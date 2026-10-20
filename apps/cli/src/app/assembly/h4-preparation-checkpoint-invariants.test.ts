import { mkdtempSync } from "node:fs";
import { access, readFile, readdir, rm } from "node:fs/promises";
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

describe("invariantes de checkpoint H4", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "decupa-h4-invariants-"));
    historyGate.wait = null;
    sidecarFault.read = "";
    sidecarFault.write = "";
    sidecarFault.writeAt = 1;
    sidecarFault.writes = 0;
    vi.restoreAllMocks();
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("mantém fatal a mudança da base mesmo quando a leitura do sidecar só gera aviso", async () => {
    const base = await seed(dir);
    sidecarFault.read = "EACCES";
    let calls = 0;
    const done = await runPreparation(dir, base.revision, request, fakeDeps({ send: async () => {
      calls += 1;
      await humanEdit(dir, false);
      return proposal();
    } }), control());
    expect(calls).toBe(1);
    expect(done.preparation?.status).toBe("interrupted");
    expect(done.assembly.name).toBe("edição humana");
    expect(done.scenes).toHaveLength(0);
    const metricsDir = join(dir, ".decupa", "metrics");
    const [journal] = await readdir(metricsDir);
    const events = (await readFile(join(metricsDir, journal!), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const warning = events.find(event => event.kind === "checkpoint-warning");
    expect(warning?.data).toMatchObject({ action: "read", code: "EACCES" });
    expect(JSON.stringify(warning)).not.toContain("sidecar read unavailable");
  });

  it("mantém o texto após interrupção tardia e retoma sem nova chamada paga", async () => {
    const base = await seed(dir);
    let textCalls = 0;
    let jevCalls = 0;
    const deps = () => fakeDeps({
      send: async () => { textCalls += 1; return proposal(true); },
      decision: { mode: "observe", model: "fake", client: { decide: async (query: TypeSafeRequest) => {
        jevCalls += 1;
        const id = Object.keys(query.questions)[0]!;
        return { model: "fake", answers: { [id]: { type: "noul" as const, noul: 0 } } };
      } } },
    });
    historyGate.wait = async () => { throw new Error("prazo da gravação do histórico"); };
    const first = await runPreparation(dir, base.revision, request, deps(), control());
    expect(first.preparation?.status).toBe("interrupted");
    const path = await checkpointPath(dir);
    const persisted = JSON.parse(await readFile(path, "utf8"));
    expect(persisted.generated.text).toContain("cutCandidates");
    const current = await loadProject(dir);
    const resumed = await runPreparation(dir, current.revision, request, deps(), control());
    expect(resumed.preparation?.status).toBe("ready");
    expect(textCalls).toBe(1);
    expect(jevCalls).toBe(1);
  });

  it("apaga o checkpoint obsolete quando a base muda depois da gravação", async () => {
    const base = await seed(dir);
    historyGate.wait = async () => { throw new Error("interrupção tardia para semear checkpoint"); };
    const seeded = await runPreparation(dir, base.revision, request, fakeDeps({ send: async () => proposal() }), control());
    expect(seeded.preparation?.status).toBe("interrupted");
    const path = await checkpointPath(dir);
    let current = true;
    historyGate.wait = async () => {
      await humanEdit(dir, false);
      current = false;
    };
    const fresh = await loadProject(dir);
    const obsolete = await runPreparation(dir, fresh.revision, request,
      fakeDeps({ send: async () => { throw new Error("não deveria enviar com checkpoint válido"); } }), control(new AbortController().signal, () => current));
    expect(obsolete.assembly.name).toBe("edição humana");
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserva checkpoint de Ajuste durante Preparar interrompido e limpa ambos no sucesso", async () => {
    const base = await seed(dir);
    let textualCalls = 0;
    const built = await runPreparation(dir, base.revision, request,
      fakeDeps({ send: async () => { textualCalls += 1; return proposal(); } }), control());
    expect(built.preparation?.status).toBe("ready");
    const adjustProposal = () => JSON.stringify({
      scenes: [{ id: "s1", selections: [{ takeId: built.scenes[0]!.takes[0]!.id }] }], changedSceneIds: ["s1"],
    });
    historyGate.wait = async () => { throw new Error("interrupção tardia do Ajuste"); };
    const adjust = await runPreparation(dir, built.revision, { ...request, mode: "adjust" },
      fakeDeps({ send: async () => { textualCalls += 1; return adjustProposal(); } }), control());
    expect(adjust.preparation?.status).toBe("interrupted");
    const adjustPath = join(dir, ".decupa", "proposal-adjust-checkpoint.json");
    const adjustBytes = await readFile(adjustPath, "utf8");

    historyGate.wait = async () => { throw new Error("interrupção tardia do Preparar"); };
    const preparing = await loadProject(dir);
    const interruptedPrepare = await runPreparation(dir, preparing.revision, request,
      fakeDeps({ send: async () => { textualCalls += 1; return adjustProposal(); } }), control());
    expect(interruptedPrepare.preparation?.status).toBe("interrupted");
    const preparePath = await checkpointPath(dir);
    expect(await readFile(adjustPath, "utf8")).toBe(adjustBytes);
    await expect(access(preparePath)).resolves.toBeUndefined();

    const retry = await loadProject(dir);
    const ready = await runPreparation(dir, retry.revision, request,
      fakeDeps({ send: async () => { textualCalls += 1; return adjustProposal(); } }), control());
    expect(ready.preparation?.status).toBe("ready");
    await expect(access(adjustPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(preparePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(textualCalls).toBe(3);
  });

  it("remove checkpoint obsoleto quando cancela antes da proposta após mudar o briefing", async () => {
    const base = await seed(dir);
    historyGate.wait = async () => { throw new Error("interrupção tardia para semear checkpoint"); };
    const seeded = await runPreparation(dir, base.revision, request, fakeDeps({ send: async () => proposal() }), control());
    expect(seeded.preparation?.status).toBe("interrupted");
    const path = await checkpointPath(dir);
    const edited = await loadProject(dir);
    await saveProject(dir, edited.revision, (p) => ({ ...p, input: { ...p.input, text: "briefing atualizado" } }));
    const current = await loadProject(dir);
    const abort = new AbortController();
    abort.abort();
    const cancelled = await runPreparation(dir, current.revision, request,
      fakeDeps({ send: async () => { throw new Error("não deve propor"); } }), control(abort.signal));
    expect(cancelled.preparation?.status).toBe("cancelled");
    expect(cancelled.input.text).toBe("briefing atualizado");
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("tolera falha no segundo publish, na persistência do lote Jev", async () => {
    const base = await seed(dir);
    sidecarFault.write = "ENOSPC";
    sidecarFault.writeAt = 2;
    let textualCalls = 0;
    let jevCalls = 0;
    const done = await runPreparation(dir, base.revision, request, fakeDeps({
      send: async () => { textualCalls += 1; return proposal(true); },
      decision: { mode: "observe", model: "fake", client: { decide: async (query: TypeSafeRequest) => {
        jevCalls += 1;
        const id = Object.keys(query.questions)[0]!;
        return { model: "fake", answers: { [id]: { type: "noul" as const, noul: 0 } } };
      } } },
    }), control());
    expect(done.preparation?.status).toBe("ready");
    expect(textualCalls).toBe(1);
    expect(jevCalls).toBe(1);
    const metricsDir = join(dir, ".decupa", "metrics");
    const [journal] = await readdir(metricsDir);
    const events = (await readFile(join(metricsDir, journal!), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(events.some(event => event.kind === "checkpoint-warning" && event.data?.action === "write" && event.data?.code === "ENOSPC")).toBe(true);
  });

});
