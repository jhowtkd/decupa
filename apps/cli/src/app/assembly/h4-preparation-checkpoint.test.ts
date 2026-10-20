import { mkdtempSync } from "node:fs";
import { access, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TypeSafeRequest } from "@decupa/typesafe";
import { fixtureAssembly } from "./fixture.ts";
import { createProject, loadProject, saveProject } from "./store.ts";
import { blankProject } from "./routes.ts";
import { runPreparation, type PreparationControl, type PreparationDeps } from "./preparation.ts";
import type { Project, Source } from "./types.ts";

const historyGate = vi.hoisted(() => ({ wait: null as null | (() => Promise<void>) }));

vi.mock("./analysis.ts", () => ({
  analyzeSource: async (source: Source) => ({
    sourceId: source.id,
    key: `analysis-${source.id}`,
    speech: source.id === "a" ? [
      { id: "a:u001", sourceId: "a", start: 0, end: 1, text: "fala inicial" },
      { id: "a:u002", sourceId: "a", start: 1.1, end: 2, text: "fala final" },
    ] : [],
    visual: [], status: "ready" as const, words: [], wordsStatus: "missing" as const,
    visualCoverage: { requested: [], returned: [], missing: [] },
  }),
}));

vi.mock("./media.ts", () => ({
  ensurePlayback: async (source: Source) => ({ videoPath: source.path }),
  verifySourceIdentity: async () => undefined,
}));

vi.mock("./waveform.ts", () => ({
  buildPeaks: async () => undefined,
  peaksPath: () => "/tmp/h4-test-peaks.json",
}));

vi.mock("./render.ts", () => ({ renderAssembly: async () => "/tmp/h4-checkpoint-render.mp4" }));
vi.mock("@decupa/media", () => ({ hashFile: async () => "c".repeat(64) }));

vi.mock("./store.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./store.ts")>();
  return {
    ...actual,
    writeHistorySnapshot: async (...args: Parameters<typeof actual.writeHistorySnapshot>) => {
      const wait = historyGate.wait;
      historyGate.wait = null;
      if (wait) await wait();
      return actual.writeHistorySnapshot(...args);
    },
  };
});

function control(signal = new AbortController().signal): PreparationControl {
  return { signal, isCurrent: () => true };
}

async function seed(dir: string): Promise<Project> {
  await createProject(dir, blankProject("h4-preparation-checkpoint"));
  const source = {
    ...fixtureAssembly().sources[0]!,
    hasVideo: false,
    size: 1,
    mtimeMs: 1,
  } as Source;
  let project = await loadProject(dir);
  await saveProject(dir, project.revision, (p) => ({
    ...p,
    input: { kind: "brief", text: "montar a fala", targetSeconds: 0 },
    assembly: { ...p.assembly, sources: [source] },
  }));
  project = await loadProject(dir);
  return project;
}

function proposal(cut = false): string {
  return JSON.stringify({
    scenes: [{ id: "s1", objective: "abertura", rationale: "fala", speechIds: cut ? ["a:u001", "a:u002"] : ["a:u001"], support: [], gaps: [] }],
    changedSceneIds: ["s1"],
    ...(cut ? { cutCandidates: [{ sceneId: "s1", speechId: "a:u001", reason: "repetição" }] } : {}),
  });
}

function fakeDeps(options: {
  send: PreparationDeps["proposeSend"];
  decision?: PreparationDeps["decision"];
}): PreparationDeps {
  return {
    exec: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
    proposeSend: options.send,
    decision: options.decision,
  };
}

const request = { mode: "prepare" as const, request: "preparar", modelOptIn: true, visualOptIn: false };

async function humanEdit(dir: string, bumpRevision: boolean): Promise<Project> {
  const current = await loadProject(dir);
  await saveProject(dir, current.revision, (p) => {
    const revision = p.revision + (bumpRevision ? 1 : 0);
    return {
      ...p,
      revision,
      assembly: { ...p.assembly, revision: p.assembly.revision + (bumpRevision ? 1 : 0), name: "edição humana" },
    };
  });
  return loadProject(dir);
}

async function checkpointPath(dir: string): Promise<string> {
  const path = join(dir, ".decupa", "proposal-checkpoint.json");
  await expect(access(path)).resolves.toBeUndefined();
  return path;
}

describe("checkpoint H4 em runPreparation", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "decupa-h4-checkpoint-"));
    historyGate.wait = null;
    vi.restoreAllMocks();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("retoma o texto persistido após abortar o primeiro Jev sem nova chamada textual", async () => {
    const base = await seed(dir);
    const firstAbort = new AbortController();
    let textualCalls = 0;
    let decisionCalls = 0;
    const deps = fakeDeps({
      send: async () => { textualCalls += 1; return proposal(true); },
      decision: {
        mode: "observe", model: "fake", client: { decide: async (query: TypeSafeRequest) => {
          decisionCalls += 1;
          const id = Object.keys(query.questions)[0]!;
          if (decisionCalls === 1) firstAbort.abort();
          return { model: "fake", answers: { [id]: { type: "noul" as const, noul: 0 } } };
        } },
      },
    });

    const first = await runPreparation(dir, base.revision, request, deps, control(firstAbort.signal));
    expect(first.preparation?.status).toBe("cancelled");
    const path = await checkpointPath(dir);
    const persisted = JSON.parse(await readFile(path, "utf8"));
    expect(persisted.generated.text).toContain("cutCandidates");

    const current = await loadProject(dir);
    const second = await runPreparation(dir, current.revision, request, deps, control());
    expect(second.preparation?.status).toBe("ready");
    expect(textualCalls).toBe(1);
    expect(decisionCalls).toBe(2);
  });

  it.each([false, true])("preserva edição humana durante o envio, revisão alterada=%s", async (bumpRevision) => {
    const base = await seed(dir);
    let textualCalls = 0;
    let release!: (text: string) => void;
    let entered!: () => void;
    const sendGate = new Promise<string>(resolve => { release = resolve; });
    const sendStarted = new Promise<void>(resolve => { entered = resolve; });
    const deps = fakeDeps({ send: async () => { textualCalls += 1; entered(); return sendGate; } });
    const run = runPreparation(dir, base.revision, request, deps, control());
    await sendStarted;
    const edited = await humanEdit(dir, bumpRevision);
    release(proposal());
    const done = await run;
    expect(done.preparation?.status).toBe("interrupted");
    expect(done.assembly.name).toBe("edição humana");
    expect(done.revision).toBe(edited.revision);
    expect(textualCalls).toBe(1);
  });

  it("confere de novo dentro do writer se a edição chega após o checkpoint e antes do commit", async () => {
    const base = await seed(dir);
    let historyEntered!: () => void;
    let releaseHistory!: () => void;
    const atHistory = new Promise<void>(resolve => { historyEntered = resolve; });
    const historyHold = new Promise<void>(resolve => { releaseHistory = resolve; });
    historyGate.wait = () => {
      historyEntered();
      return historyHold;
    };
    let textualCalls = 0;
    const deps = fakeDeps({ send: async () => { textualCalls += 1; return proposal(); } });
    const run = runPreparation(dir, base.revision, request, deps, control());

    await atHistory;
    const sidecar = JSON.parse(await readFile(join(dir, ".decupa", "proposal-checkpoint.json"), "utf8"));
    expect(sidecar.generated.text).toContain("scenes");
    const edited = await humanEdit(dir, false);
    releaseHistory();
    const done = await run;

    expect(done.preparation?.status).toBe("interrupted");
    expect(done.assembly.name).toBe("edição humana");
    expect(done.revision).toBe(edited.revision);
    expect(done.scenes).toHaveLength(0);
    expect(textualCalls).toBe(1);
  });
});
