import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeSource } from "./analysis.ts";
import { fixtureAssembly } from "./fixture.ts";
import { runPreparation, type PreparationDeps } from "./preparation.ts";
import { blankProject } from "./routes.ts";
import { createProject, loadProject, saveProject } from "./store.ts";
import type { Source } from "./types.ts";

const hooks = vi.hoisted(() => ({
  audio: null as null | (() => Promise<void>),
  visual: null as null | (() => Promise<void>),
}));

vi.mock("./analysis.ts", () => ({
  analyzeSource: vi.fn(async (source: Source) => {
    if (hooks.audio) await hooks.audio();
    return {
      sourceId: source.id, key: `analysis-${source.id}`, status: "ready",
      speech: source.hasAudio ? [{
        id: `${source.id}:u001`, sourceId: source.id, start: 0, end: 1,
        text: source.id === "a" ? "fala inicial" : "fala nova",
      }] : [],
      words: [], wordsStatus: "missing", visual: [],
      visualCoverage: { requested: [], returned: [], missing: [] },
    };
  }),
}));
vi.mock("./model.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("./model.ts")>(),
  describeSource: async (source: Source) => {
    if (hooks.visual) await hooks.visual();
    return [{ id: `${source.id}:v001`, sourceId: source.id, start: 0, end: 3, text: "imagem", confidence: "observed", tags: [] }];
  },
}));
vi.mock("./media.ts", () => ({
  ensurePlayback: async (source: Source) => ({ videoPath: source.path }),
  verifySourceIdentity: async () => undefined,
}));
vi.mock("./waveform.ts", () => ({ buildPeaks: async () => undefined, peaksPath: () => "/tmp/new-source-peaks.json" }));
vi.mock("./render.ts", () => ({ renderAssembly: async () => "/tmp/new-source-render.mp4" }));
vi.mock("@decupa/media", () => ({ hashFile: async () => "d".repeat(64) }));

function stageGate() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { entered, release, run: async () => { enter(); await wait; } };
}

async function seed(dir: string) {
  await createProject(dir, blankProject("new-source-preparation"));
  const base = await loadProject(dir);
  await saveProject(dir, base.revision, (project) => ({
    ...project,
    input: { kind: "brief", text: "montar a fala", targetSeconds: 0 },
    assembly: { ...project.assembly, sources: [{ ...fixtureAssembly().sources[0]!, size: 1, mtimeMs: 1 }] },
  }));
  return loadProject(dir);
}

async function includeNewSource(dir: string, hasAudio = true) {
  const fresh = await loadProject(dir);
  await saveProject(dir, fresh.revision, (project) => ({
    ...project,
    revision: project.revision + 1,
    assembly: {
      ...project.assembly, revision: project.assembly.revision + 1,
      sources: [...project.assembly.sources, {
        ...fixtureAssembly().sources[1]!, hasAudio, name: "fonte-nova.mp4", size: 1, mtimeMs: 1,
      }],
    },
  }));
}

const request = { mode: "prepare" as const, request: "preparar", modelOptIn: true, visualOptIn: false };
const control = () => ({ signal: new AbortController().signal, isCurrent: () => true });
const proposal = JSON.stringify({
  scenes: [{ id: "s1", objective: "abertura", rationale: "fala", speechIds: ["a:u001"], support: [], gaps: [] }],
  changedSceneIds: ["s1"],
});

describe("fonte incluída durante a preparação", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "decupa-new-source-"));
    hooks.audio = null;
    hooks.visual = null;
    vi.clearAllMocks();
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it.each(["audio", "visual"] as const)("interrompe antes de pagar se entra fonte com fala durante %s e retoma com uma chamada", async (stage) => {
    const base = await seed(dir);
    const gate = stageGate();
    hooks[stage] = gate.run;
    const send = vi.fn(async () => proposal);
    const deps: PreparationDeps = {
      exec: { run: async () => ({ code: 0, stdout: "", stderr: "" }) }, proposeSend: send,
      ...(stage === "visual" ? { describeClient: { send: async () => "" } } : {}),
    };
    const run = runPreparation(dir, base.revision, request, deps, control());
    await gate.entered;
    await includeNewSource(dir);
    hooks[stage] = null;
    gate.release();
    const interrupted = await run;

    expect(interrupted.preparation?.status).toBe("interrupted");
    expect(interrupted.preparation?.error).toContain("fonte incluída durante a preparação");
    expect(interrupted.preparation?.error).toContain("b (fonte-nova.mp4)");
    expect(interrupted.preparation?.error).toContain("retome");
    expect(interrupted.preparation?.error).not.toContain("edição preservada");
    expect(send).not.toHaveBeenCalled();
    expect(analyzeSource).not.toHaveBeenCalledWith(expect.objectContaining({ id: "b" }), expect.anything(), expect.anything(), expect.anything());

    const resumed = await runPreparation(dir, interrupted.revision, request, deps, control());
    expect(resumed.preparation?.status).toBe("ready");
    expect(resumed.preparation?.sources.b?.audio).toBe("ready");
    if (stage === "visual") expect(resumed.preparation?.sources.b?.visual).toBe("ready");
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(send.mock.calls)).toContain("fala nova");
  });

  it("fonte nova sem áudio não bloqueia quando não há visão exigida", async () => {
    const base = await seed(dir);
    const gate = stageGate();
    hooks.audio = gate.run;
    const send = vi.fn(async () => proposal);
    const run = runPreparation(dir, base.revision, request, {
      exec: { run: async () => ({ code: 0, stdout: "", stderr: "" }) }, proposeSend: send,
    }, control());
    await gate.entered;
    await includeNewSource(dir, false);
    hooks.audio = null;
    gate.release();
    const done = await run;

    expect(done.preparation?.status).toBe("ready");
    expect(send).toHaveBeenCalledTimes(1);
    expect(done.assembly.sources.find((source) => source.id === "b")?.included).toBe(true);
  });
});
