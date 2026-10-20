import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureAssembly } from "./fixture.ts";
import { createProject, loadProject, saveProject } from "./store.ts";
import { blankProject, publishCorrection } from "./routes.ts";
import {
  CORRECTION_SETTLE_TIMEOUT_MS,
  runPreparation,
  type PreparationControl,
  type PreparationDeps,
} from "./preparation.ts";
import type { Project, Source } from "./types.ts";

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
vi.mock("./waveform.ts", () => ({ buildPeaks: async () => undefined, peaksPath: () => "/tmp/pending-test-peaks.json" }));
vi.mock("./render.ts", () => ({ renderAssembly: async () => "/tmp/pending-test-render.mp4" }));
vi.mock("@decupa/media", () => ({ hashFile: async () => "d".repeat(64) }));

function control(signal = new AbortController().signal): PreparationControl {
  return { signal, isCurrent: () => true };
}

async function seed(dir: string): Promise<Project> {
  await createProject(dir, blankProject("pending-preparation-additional"));
  const source = { ...fixtureAssembly().sources[0]!, hasVideo: false, size: 1, mtimeMs: 1 } as Source;
  let project = await loadProject(dir);
  await saveProject(dir, project.revision, (p) => ({
    ...p,
    input: { kind: "brief", text: "montar a fala", targetSeconds: 0 },
    assembly: { ...p.assembly, sources: [source] },
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

function fakeDeps(send: PreparationDeps["proposeSend"]): PreparationDeps {
  return { exec: { run: async () => ({ code: 0, stdout: "", stderr: "" }) }, proposeSend: send };
}

const request = { mode: "prepare" as const, request: "preparar", modelOptIn: true, visualOptIn: false };

async function addPendingCorrection(dir: string): Promise<Project> {
  const current = await loadProject(dir);
  await saveProject(dir, current.revision, (p) => ({
    ...p,
    corrections: [{ id: "corr-bg", sourceId: "a", start: 0, end: 1, text: "fala corrigida", status: "pending", words: [] }],
  }));
  return loadProject(dir);
}

describe("barreira de alinhamento pendente antes da proposta", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "decupa-pending-preparation-")); vi.restoreAllMocks(); });
  afterEach(async () => { vi.useRealTimers(); await rm(dir, { recursive: true, force: true }); });

  it("usa correção que assenta durante a barreira e faz uma chamada com texto corrigido", async () => {
    let base = await seed(dir);
    base = await addPendingCorrection(dir);
    let textualCalls = 0;
    let prompt = "";
    const deps = fakeDeps(async (content) => {
      textualCalls += 1;
      prompt = JSON.stringify(content);
      return proposal();
    });
    const run = runPreparation(dir, base.revision, request, deps, control());

    await vi.waitFor(async () => {
      expect((await loadProject(dir)).preparation?.stage).toBe("proposal");
    });
    expect(textualCalls).toBe(0);
    await publishCorrection(dir, base.revision, "corr-bg", {
      words: [
        { text: "fala", start: 0.1, end: 0.35, confidence: 0.9 },
        { text: "corrigida", start: 0.4, end: 0.8, confidence: 0.9 },
      ],
    });
    const done = await run;

    expect(done.preparation?.status).toMatch(/ready|attention/);
    expect(prompt).toContain("fala corrigida");
    expect(textualCalls).toBe(1);
  });

  it("interrompe no teto de assentamento sem pagar a proposta", async () => {
    let base = await seed(dir);
    base = await addPendingCorrection(dir);
    vi.useFakeTimers();
    let textualCalls = 0;
    let finished = false;
    const run = runPreparation(dir, base.revision, request, fakeDeps(async () => {
      textualCalls += 1;
      return proposal();
    }), control()).then((project) => {
      finished = true;
      return project;
    });

    await vi.waitFor(async () => {
      expect((await loadProject(dir)).preparation?.stage).toBe("proposal");
    }, { interval: 10, timeout: 5_000 });
    for (let elapsed = 0; elapsed <= CORRECTION_SETTLE_TIMEOUT_MS + 1_000 && !finished; elapsed += 250) {
      await vi.advanceTimersByTimeAsync(250);
      await loadProject(dir);
    }
    await vi.waitFor(() => { expect(finished).toBe(true); });
    const done = await run;

    expect(done.preparation?.status).toBe("interrupted");
    expect(done.preparation?.error).toBe("correção em alinhamento em background; retome em instantes");
    expect(textualCalls).toBe(0);
  });

  it("cancela durante a espera de assentamento sem pagar a proposta", async () => {
    let base = await seed(dir);
    base = await addPendingCorrection(dir);
    const aborter = new AbortController();
    let textualCalls = 0;
    const run = runPreparation(dir, base.revision, request, fakeDeps(async () => {
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
  });

  it("interrompe se a única fonte for removida durante a espera e preserva a edição", async () => {
    await seed(dir);
    const pending = await addPendingCorrection(dir);
    let textualCalls = 0;
    const run = runPreparation(dir, pending.revision, request, fakeDeps(async () => {
      textualCalls += 1;
      return proposal();
    }), control());

    await vi.waitFor(async () => {
      expect((await loadProject(dir)).preparation?.stage).toBe("proposal");
    });
    const waiting = await loadProject(dir);
    await saveProject(dir, waiting.revision, (project) => ({
      ...project,
      input: { ...project.input, text: "briefing editado enquanto esperava" },
      assembly: { ...project.assembly, sources: [], tracks: [], canvasSourceId: null },
      corrections: [],
      analyses: [],
    }));
    const done = await run;
    const persisted = await loadProject(dir);

    expect(done.preparation?.status).toBe("interrupted");
    expect(done.preparation?.error).toContain("fonte removida");
    expect(done.input.text).toBe("briefing editado enquanto esperava");
    expect(persisted.assembly.sources).toHaveLength(0);
    expect(textualCalls).toBe(0);
  });

  it("interrompe sem fala se a única fonte for desincluída e o pending removido", async () => {
    await seed(dir);
    const pending = await addPendingCorrection(dir);
    let textualCalls = 0;
    const run = runPreparation(dir, pending.revision, request, fakeDeps(async () => {
      textualCalls += 1;
      return proposal();
    }), control());

    await vi.waitFor(async () => {
      expect((await loadProject(dir)).preparation?.stage).toBe("proposal");
    });
    const waiting = await loadProject(dir);
    await saveProject(dir, waiting.revision, (project) => ({
      ...project,
      assembly: {
        ...project.assembly,
        sources: project.assembly.sources.map((source) => ({ ...source, included: false })),
      },
      corrections: [],
    }));
    const done = await run;
    const persisted = await loadProject(dir);

    expect(done.preparation?.status).toBe("interrupted");
    expect(done.preparation?.error).toContain("sem fala");
    expect(persisted.assembly.sources).toHaveLength(1);
    expect(persisted.assembly.sources[0]?.included).toBe(false);
    expect(textualCalls).toBe(0);
  });

  it("interrompe se a análise vira error durante a espera e a correção assenta", async () => {
    await seed(dir);
    const pending = await addPendingCorrection(dir);
    let textualCalls = 0;
    const run = runPreparation(dir, pending.revision, request, fakeDeps(async () => {
      textualCalls += 1;
      return proposal();
    }), control());

    await vi.waitFor(async () => {
      expect((await loadProject(dir)).preparation?.stage).toBe("proposal");
    });
    const waiting = await loadProject(dir);
    await saveProject(dir, waiting.revision, (project) => ({
      ...project,
      corrections: [],
      analyses: project.analyses.map((analysis) => ({
        ...analysis,
        status: "error",
        error: "falha de análise durante o alinhamento",
      })),
    }));
    const done = await run;
    const persisted = await loadProject(dir);

    expect(done.preparation?.status).toBe("interrupted");
    expect(done.preparation?.error).toContain("análise necessária pendente");
    expect(persisted.analyses[0]?.status).toBe("error");
    expect(persisted.analyses[0]?.error).toBe("falha de análise durante o alinhamento");
    expect(textualCalls).toBe(0);
  });

  it("preserva a mensagem atual quando há edição humana durante o envio da proposta", async () => {
    const base = await seed(dir);
    let release!: (text: string) => void;
    let entered!: () => void;
    const sendGate = new Promise<string>((resolve) => { release = resolve; });
    const sendStarted = new Promise<void>((resolve) => { entered = resolve; });
    let textualCalls = 0;
    const run = runPreparation(dir, base.revision, request, fakeDeps(async () => {
      textualCalls += 1;
      entered();
      return sendGate;
    }), control());

    await sendStarted;
    const current = await loadProject(dir);
    await saveProject(dir, current.revision, (p) => ({
      ...p,
      assembly: { ...p.assembly, name: "edição humana" },
    }));
    const edited = await loadProject(dir);
    release(proposal());
    const result = await run;

    expect(result.preparation?.status).toBe("interrupted");
    expect(result.preparation?.error).toBe(
      "proposta rejeitada: entrada da proposta mudou durante a preparação; edição preservada, retome para prosseguir",
    );
    expect(result.assembly.name).toBe("edição humana");
    expect(result.revision).toBe(edited.revision);
    expect(textualCalls).toBe(1);
  });
});
