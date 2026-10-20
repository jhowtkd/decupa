import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureAssembly } from "./fixture.ts";
import { createProject, loadProject, saveProject } from "./store.ts";
import { blankProject, publishCorrection } from "./routes.ts";
import { runPreparation, type PreparationControl, type PreparationDeps } from "./preparation.ts";
import type { Project, Source } from "./types.ts";

const analysisGate = vi.hoisted(() => ({
  wait: null as null | Promise<void>,
  entered: null as null | (() => void),
}));
const checkpointGate = vi.hoisted(() => ({
  enabled: false,
  wait: null as null | Promise<void>,
  entered: null as null | (() => void),
}));
const terminalSaveGate = vi.hoisted(() => ({
  enabled: false,
  wait: null as null | Promise<void>,
  entered: null as null | (() => void),
  finished: null as null | (() => void),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (String(args[0]).endsWith("proposal-checkpoint.json") && checkpointGate.enabled && checkpointGate.wait) {
        checkpointGate.enabled = false;
        checkpointGate.entered?.();
        await checkpointGate.wait;
      }
      return actual.readFile(...args);
    },
  };
});

vi.mock("./store.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./store.ts")>();
  return {
    ...actual,
    saveProject: async (...args: Parameters<typeof actual.saveProject>) => {
      if (terminalSaveGate.enabled && terminalSaveGate.wait) {
        terminalSaveGate.enabled = false;
        terminalSaveGate.entered?.();
        await terminalSaveGate.wait;
        try {
          return await actual.saveProject(...args);
        } finally {
          terminalSaveGate.finished?.();
        }
      }
      return actual.saveProject(...args);
    },
  };
});

vi.mock("./analysis.ts", () => ({
  analyzeSource: async (source: Source) => {
    if (source.id === "a" && analysisGate.wait) {
      analysisGate.entered?.();
      await analysisGate.wait;
    }
    return {
      sourceId: source.id,
      key: `analysis-${source.id}`,
      speech: source.id === "a" ? [
        { id: "a:u001", sourceId: "a", start: 0, end: 1, text: "fala inicial" },
        { id: "a:u002", sourceId: "a", start: 1.1, end: 2, text: "fala final" },
      ] : [],
      visual: [], status: "ready" as const, words: [], wordsStatus: "missing" as const,
      visualCoverage: { requested: [], returned: [], missing: [] },
    };
  },
}));

vi.mock("./media.ts", () => ({
  ensurePlayback: async (source: Source) => ({ videoPath: source.path }),
  verifySourceIdentity: async () => undefined,
}));
vi.mock("./waveform.ts", () => ({ buildPeaks: async () => undefined, peaksPath: () => "/tmp/new-source-test-peaks.json" }));
vi.mock("./render.ts", () => ({ renderAssembly: async () => "/tmp/new-source-test-render.mp4" }));
vi.mock("@decupa/media", () => ({ hashFile: async () => "e".repeat(64) }));

function control(signal = new AbortController().signal): PreparationControl {
  return { signal, isCurrent: () => true };
}

async function seed(dir: string, includeSupport = false): Promise<Project> {
  await createProject(dir, blankProject("new-source-preparation-additional"));
  const [speech, support] = fixtureAssembly().sources as [Source, Source];
  const sources = [
    { ...speech, hasVideo: false, size: 1, mtimeMs: 1 },
    { ...support, included: includeSupport, size: 2, mtimeMs: 2 },
  ] as Source[];
  let project = await loadProject(dir);
  await saveProject(dir, project.revision, (p) => ({
    ...p,
    input: { kind: "brief", text: "montar a fala", targetSeconds: 0 },
    assembly: { ...p.assembly, sources },
  }));
  project = await loadProject(dir);
  return project;
}

function proposal(): string {
  return JSON.stringify({
    scenes: [{ id: "s1", objective: "abertura", rationale: "fala", speechIds: ["a:u001"], support: [], gaps: [] }],
    changedSceneIds: ["s1"],
  });
}

function fakeDeps(send: PreparationDeps["proposeSend"], describeClient?: PreparationDeps["describeClient"]): PreparationDeps {
  return {
    exec: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
    proposeSend: send,
    describeClient,
    resolveOperationDeps: async () => ({ decision: { mode: "off", model: "test" }, fillerEnv: {} }),
  };
}

const request = { mode: "prepare" as const, request: "preparar", modelOptIn: true, visualOptIn: true };

async function addPendingCorrection(dir: string): Promise<Project> {
  const current = await loadProject(dir);
  await saveProject(dir, current.revision, (p) => ({
    ...p,
    corrections: [{ id: "corr-bg", sourceId: "a", start: 0, end: 1, text: "fala corrigida", status: "pending", words: [] }],
  }));
  return loadProject(dir);
}

async function addNewIncludedSource(dir: string, overrides: Partial<Source> = {}): Promise<Project> {
  const current = await loadProject(dir);
  const extra = {
    ...(fixtureAssembly().sources[1] as Source),
    id: "new-source",
    path: "/tmp/new-source.mp4",
    sha256: "f".repeat(64),
    name: "novo-video.mp4",
    included: true,
    hasAudio: true,
    size: 3,
    mtimeMs: 3,
    ...overrides,
  } satisfies Source;
  await saveProject(dir, current.revision, (p) => ({
    ...p,
    assembly: { ...p.assembly, sources: [...p.assembly.sources, extra] },
  }));
  return loadProject(dir);
}

describe("barreira de fonte incluída depois da captura", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "decupa-new-source-additional-"));
    analysisGate.wait = null;
    analysisGate.entered = null;
    checkpointGate.enabled = false;
    checkpointGate.wait = null;
    checkpointGate.entered = null;
    terminalSaveGate.enabled = false;
    terminalSaveGate.wait = null;
    terminalSaveGate.entered = null;
    terminalSaveGate.finished = null;
    vi.restoreAllMocks();
  });
  afterEach(async () => {
    analysisGate.wait = null;
    analysisGate.entered = null;
    checkpointGate.enabled = false;
    checkpointGate.wait = null;
    checkpointGate.entered = null;
    terminalSaveGate.enabled = false;
    terminalSaveGate.wait = null;
    terminalSaveGate.entered = null;
    terminalSaveGate.finished = null;
    await rm(dir, { recursive: true, force: true });
  });

  it("revalida uma fonte incluída durante a espera F2 depois que a correção assenta", async () => {
    const base = await seed(dir);
    const pending = await addPendingCorrection(dir);
    let textualCalls = 0;
    const run = runPreparation(dir, pending.revision, request, fakeDeps(async () => {
      textualCalls += 1;
      return proposal();
    }), control());

    await vi.waitFor(async () => {
      expect((await loadProject(dir)).preparation?.stage).toBe("proposal");
    });
    const current = await addNewIncludedSource(dir);
    await publishCorrection(dir, current.revision, "corr-bg", {
      words: [
        { text: "fala", start: 0.1, end: 0.35, confidence: 0.9 },
        { text: "corrigida", start: 0.4, end: 0.8, confidence: 0.9 },
      ],
    });
    expect((await loadProject(dir)).corrections[0]?.status).toBe("aligned");
    const done = await run;

    expect(done.preparation?.status).toBe("interrupted");
    expect(done.preparation?.error).toContain("new-source (novo-video.mp4)");
    expect(done.preparation?.error).toContain("retome");
    expect(textualCalls).toBe(0);
    expect(base.assembly.sources).toHaveLength(2);
  });

  it("cancela durante a espera de assentamento sem pagar a proposta", async () => {
    const base = await seed(dir);
    const pending = await addPendingCorrection(dir);
    const aborter = new AbortController();
    let textualCalls = 0;
    const run = runPreparation(dir, pending.revision, request, fakeDeps(async () => {
      textualCalls += 1;
      return proposal();
    }), control(aborter.signal));

    await vi.waitFor(async () => {
      expect((await loadProject(dir)).preparation?.stage).toBe("proposal");
    });
    aborter.abort();
    const done = await run;

    expect(done.preparation?.status).toBe("cancelled");
    expect(textualCalls).toBe(0);
    expect(base.preparation).toBeNull();
  });

  it("bloqueia quando uma fonte antes desincluída passa a incluída durante o áudio", async () => {
    const base = await seed(dir, false);
    let releaseAnalysis!: () => void;
    let enterAnalysis!: () => void;
    const held = new Promise<void>((resolve) => { releaseAnalysis = resolve; });
    const entered = new Promise<void>((resolve) => { enterAnalysis = resolve; });
    analysisGate.wait = held;
    analysisGate.entered = enterAnalysis;
    let textualCalls = 0;
    const run = runPreparation(dir, base.revision, request, fakeDeps(async () => {
      textualCalls += 1;
      return proposal();
    }), control());

    await entered;
    const current = await loadProject(dir);
    await saveProject(dir, current.revision, (p) => ({
      ...p,
      assembly: {
        ...p.assembly,
        sources: p.assembly.sources.map((source) => source.id === "b"
          ? { ...source, included: true, hasAudio: true }
          : source),
      },
    }));
    releaseAnalysis();
    const done = await run;

    expect(done.preparation?.status).toBe("interrupted");
    expect(done.preparation?.error).toContain("b (apoio.mp4)");
    expect(done.preparation?.error).toContain("retome");
    expect(textualCalls).toBe(0);
  });

  it("bloqueia vídeo novo sem evidência visual quando hasAudio é false e há cliente visual", async () => {
    const base = await seed(dir);
    const pending = await addPendingCorrection(dir);
    let textualCalls = 0;
    const describeSend = vi.fn(async () => JSON.stringify({ spans: [] }));
    const run = runPreparation(dir, pending.revision, request, fakeDeps(async () => {
      textualCalls += 1;
      return proposal();
    }, { send: describeSend }), control());

    await vi.waitFor(async () => {
      expect((await loadProject(dir)).preparation?.stage).toBe("proposal");
    });
    const added = await addNewIncludedSource(dir, { hasAudio: false, hasVideo: true });
    await publishCorrection(dir, added.revision, "corr-bg", {
      words: [
        { text: "fala", start: 0.1, end: 0.35, confidence: 0.9 },
        { text: "corrigida", start: 0.4, end: 0.8, confidence: 0.9 },
      ],
    });
    const done = await run;

    expect(done.preparation?.status).toBe("interrupted");
    expect(done.preparation?.error).toContain("new-source (novo-video.mp4)");
    expect(done.preparation?.error).toContain("retome");
    expect(textualCalls).toBe(0);
    expect(describeSend).not.toHaveBeenCalled();
    expect(base.preparation).toBeNull();
  });

  it("revalida a inclusão tardia entre checkpoint.load e o primeiro envio textual", async () => {
    const base = await seed(dir);
    let checkpointEntered!: () => void;
    let releaseCheckpoint!: () => void;
    const entered = new Promise<void>((resolve) => { checkpointEntered = resolve; });
    const held = new Promise<void>((resolve) => { releaseCheckpoint = resolve; });
    checkpointGate.enabled = true;
    checkpointGate.wait = held;
    checkpointGate.entered = checkpointEntered;
    let textualCalls = 0;
    const run = runPreparation(dir, base.revision, request, fakeDeps(async () => {
      textualCalls += 1;
      return proposal();
    }), control());

    await entered;
    await addNewIncludedSource(dir);
    releaseCheckpoint();
    const done = await run;

    expect(done.preparation?.status).toBe("interrupted");
    expect(textualCalls).toBe(0);
    expect(done.preparation?.error).toContain("new-source (novo-video.mp4)");
    expect(done.preparation?.error).toContain("retome");
  });

  it("mantém o estado retornado e persistido coerentes se cancelar durante a gravação da barreira", async () => {
    const base = await seed(dir);
    const aborter = new AbortController();
    let checkpointEntered!: () => void;
    let releaseCheckpoint!: () => void;
    const atCheckpoint = new Promise<void>((resolve) => { checkpointEntered = resolve; });
    const checkpointHold = new Promise<void>((resolve) => { releaseCheckpoint = resolve; });
    checkpointGate.enabled = true;
    checkpointGate.wait = checkpointHold;
    checkpointGate.entered = checkpointEntered;

    let terminalSaveEntered!: () => void;
    let releaseTerminalSave!: () => void;
    let terminalSaveFinished!: () => void;
    const atTerminalSave = new Promise<void>((resolve) => { terminalSaveEntered = resolve; });
    const terminalSaveHold = new Promise<void>((resolve) => { releaseTerminalSave = resolve; });
    const terminalSaveDone = new Promise<void>((resolve) => { terminalSaveFinished = resolve; });
    let textualCalls = 0;
    const run = runPreparation(dir, base.revision, request, fakeDeps(async () => {
      textualCalls += 1;
      return proposal();
    }), control(aborter.signal));

    let gateReached = false;
    try {
      await atCheckpoint;
      const waiting = await loadProject(dir);
      await saveProject(dir, waiting.revision, (p) => ({
        ...p,
        assembly: {
          ...p.assembly,
          sources: p.assembly.sources.map((source) => source.id === "b"
            ? { ...source, included: true, hasAudio: true }
            : source),
        },
      }));
      terminalSaveGate.enabled = true;
      terminalSaveGate.wait = terminalSaveHold;
      terminalSaveGate.entered = terminalSaveEntered;
      terminalSaveGate.finished = terminalSaveFinished;
      releaseCheckpoint();
      await atTerminalSave;

      aborter.abort();
      gateReached = true;
      // Let the abort path run while the terminal save is held. Depending on
      // whether the principal catch already owns the write, run may finish or
      // wait for this gate; the test does not choose a winning terminal state.
      await Promise.race([run, new Promise<void>((resolve) => setTimeout(resolve, 75))]);
    } finally {
      releaseCheckpoint();
      releaseTerminalSave();
    }

    const done = await run;
    if (gateReached) await terminalSaveDone;
    const persisted = await loadProject(dir);
    expect(textualCalls).toBe(0);
    expect(persisted.preparation).toEqual(done.preparation);
  });
});
