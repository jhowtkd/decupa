import { mkdtempSync } from "node:fs";
import { access, rm } from "node:fs/promises";
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
const sidecarFault = vi.hoisted(() => ({ read: "", write: "", writeAt: 1, writes: 0 }));
const describeGate = vi.hoisted(() => ({ onDescribe: null as null | (() => void), calls: 0, visualText: "pessoa falando" }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    if (String(args[0]).endsWith("proposal-checkpoint.json") && sidecarFault.read) {
      throw Object.assign(new Error("sidecar read unavailable"), { code: sidecarFault.read });
    }
    return actual.readFile(...args);
  } };
});

vi.mock("@decupa/cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@decupa/cache")>();
  return { ...actual, publishAtomic: async (...args: Parameters<typeof actual.publishAtomic>) => {
    if (String(args[0]).includes("proposal") && sidecarFault.write) {
      sidecarFault.writes += 1;
      if (sidecarFault.writes === sidecarFault.writeAt) {
        throw Object.assign(new Error("sidecar write unavailable"), { code: sidecarFault.write });
      }
    }
    return actual.publishAtomic(...args);
  } };
});

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

vi.mock("./model.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./model.ts")>();
  return { ...actual, describeSource: async (source: Source) => {
    describeGate.calls += 1;
    describeGate.onDescribe?.();
    return [{ id: `${source.id}:v001`, sourceId: source.id, start: 0, end: source.durationSeconds, text: describeGate.visualText, confidence: "observed", tags: [] }];
  } };
});

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

function control(signal = new AbortController().signal, isCurrent = () => true): PreparationControl {
  return { signal, isCurrent };
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
  describeClient?: PreparationDeps["describeClient"];
}): PreparationDeps {
  return {
    exec: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
    proposeSend: options.send,
    decision: options.decision,
    describeClient: options.describeClient,
  };
}

const request = { mode: "prepare" as const, request: "preparar", modelOptIn: true, visualOptIn: false };

describe("regressões da revisão independente do checkpoint H4", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "decupa-h4-review-"));
    historyGate.wait = null;
    sidecarFault.read = "";
    sidecarFault.write = "";
    sidecarFault.writeAt = 1;
    sidecarFault.writes = 0;
    describeGate.onDescribe = null;
    describeGate.calls = 0;
    describeGate.visualText = "pessoa falando";
    vi.restoreAllMocks();
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  async function seedVideo(): Promise<Project> {
    const initial = await seed(dir);
    await saveProject(dir, initial.revision, (p) => ({
      ...p,
      assembly: { ...p.assembly, sources: p.assembly.sources.map((source) => ({ ...source, hasVideo: true })) },
    }));
    return loadProject(dir);
  }

  it.each([false, true])("preserva checkpoint na janela visual; replay textual extra se a evidência mudar=%s", async (visualChanged) => {
    const base = await seedVideo();
    const requestWithVisual = { ...request, visualOptIn: true };
    let textualCalls = 0;
    let decisionCalls = 0;
    let abort = new AbortController();
    const deps = () => fakeDeps({
      send: async () => { textualCalls += 1; return proposal(true); },
      describeClient: { model: "fake", providerKey: "fake", send: async () => "[]" },
      decision: { mode: "observe", model: "fake", client: { decide: async (query: TypeSafeRequest) => {
        decisionCalls += 1;
        if (decisionCalls === 1) abort.abort();
        const id = Object.keys(query.questions)[0]!;
        return { model: "fake", answers: { [id]: { type: "noul" as const, noul: 0 } } };
      } } },
    });
    const controlForAttempt = () => control(abort.signal);
    const first = await runPreparation(dir, base.revision, requestWithVisual, deps(), controlForAttempt());
    expect(first.preparation?.status).toBe("cancelled");
    const path = join(dir, ".decupa", "proposal-checkpoint.json");
    await expect(access(path)).resolves.toBeUndefined();

    abort = new AbortController();
    describeGate.onDescribe = () => abort.abort();
    const fresh = await loadProject(dir);
    const second = await runPreparation(dir, fresh.revision, requestWithVisual, deps(), controlForAttempt());
    describeGate.onDescribe = null;
    expect(second.preparation?.status).toBe("cancelled");
    await expect(access(path)).resolves.toBeUndefined();

    abort = new AbortController();
    if (visualChanged) describeGate.visualText = "pessoa falando em outro momento";
    const latest = await loadProject(dir);
    const third = await runPreparation(dir, latest.revision, requestWithVisual, deps(), controlForAttempt());
    expect(third.preparation?.status).toBe("ready");
    expect(textualCalls).toBe(visualChanged ? 2 : 1);
  });

  it("limpa checkpoint morto quando o escritor externo troca a preparação durante Jev", async () => {
    const base = await seed(dir);
    const deps = fakeDeps({
      send: async () => proposal(true),
      decision: { mode: "observe", model: "fake", client: { decide: async (query: TypeSafeRequest) => {
        const external = await loadProject(dir);
        await saveProject(dir, external.revision, (p) => ({
          ...p,
          input: { ...p.input, text: "briefing do escritor externo" },
          preparation: p.preparation ? { ...p.preparation, id: "prep-externa", status: "running" } : p.preparation,
        }));
        const id = Object.keys(query.questions)[0]!;
        return { model: "fake", answers: { [id]: { type: "noul" as const, noul: 0 } } };
      } } },
    });
    const result = await runPreparation(dir, base.revision, request, deps, control());
    expect(result.preparation).toMatchObject({ id: "prep-externa", status: "running" });
    expect(result.input.text).toBe("briefing do escritor externo");
    await expect(access(join(dir, ".decupa", "proposal-checkpoint.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
