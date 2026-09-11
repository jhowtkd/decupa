import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createProject, loadProject, saveProject } from "./store.ts";
import { blankProject } from "./routes.ts";
import { fixtureAssembly } from "./fixture.ts";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import { runPreparation, type PreparationDeps } from "./preparation.ts";
import type { ExecCall, ExecResult } from "../pipeline.ts";
import type { Project, Source } from "./types.ts";

const CLIP = join(FIXTURES, "clip.mp4");

async function sourceFrom(
  dir: string,
  name: string,
  id: string,
  role: "speech" | "support",
): Promise<Source> {
  const path = join(dir, name);
  await cp(CLIP, path);
  if (name.includes("apoio")) await writeFile(path, Buffer.from([0]));
  const st = await stat(path);
  const bytes = await readFile(path);
  return {
    ...fixtureAssembly().sources[0]!,
    id,
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    durationSeconds: 3,
    hasVideo: true,
    hasAudio: true,
    role,
    included: true,
    name,
    size: st.size,
    mtimeMs: st.mtimeMs,
  };
}

type FakeOpts = { failAudioFor?: string; failRender?: boolean; describeShort?: boolean };
type Calls = { ingest: number; ffmpeg: number; render: number; propose: number; describe: number };

function makeFakes(opts: FakeOpts = {}): {
  deps: PreparationDeps;
  calls: Calls;
  failNextPropose: () => void;
  blockPropose: () => { release: (json: string) => void; gate: Promise<string> };
} {
  const calls: Calls = { ingest: 0, ffmpeg: 0, render: 0, propose: 0, describe: 0 };
  let nextFail = false;
  let gate: { release: (json: string) => void; gate: Promise<string> } | null = null;
  const proposalJson = JSON.stringify({
    scenes: [
      {
        id: "sc-1",
        objective: "Abertura",
        selections: [{ speechId: "fala:u0" }],
      },
    ],
    changedSceneIds: ["sc-1"],
    gaps: [],
  });
  const exec = async (call: ExecCall): Promise<ExecResult> => {
    if (call.command === "pnpm" || call.args.includes("condense-prep")) {
      calls.ingest += 1;
      const input = call.args[call.args.indexOf("--input") + 1];
      const id = input.includes("apoio") ? "b" : "a";
      if (opts.failAudioFor === id) return { code: 1, stdout: "", stderr: "boom" };
      const work = call.env?.CLAUDE_PROJECT_DIR ?? "";
      await mkdir(join(work, "out"), { recursive: true });
      await writeFile(
        call.args[call.args.indexOf("--out") + 1],
        JSON.stringify({ segments: [{ start: 0, end: 2, text: `fala ${id}` }] }),
      );
      return { code: 0, stdout: "", stderr: "" };
    }
    if (call.command === "python3" && call.args.includes("index")) {
      calls.ingest += 1;
      const work = call.env?.CLAUDE_PROJECT_DIR ?? "";
      await mkdir(join(work, "out"), { recursive: true });
      await writeFile(
        join(work, "out", "speech_index.json"),
        JSON.stringify({
          units: [{
            id: "u0", index: 1, start: 0, end: 1.2, duration: 1.2, text: "fala transcrito",
            has_terminal_punct: true, is_question: false, word_count: 2, cps: 1,
            lead_gap: 0, disfluency: { hard: [], soft: [], stutter: [] },
          }],
        }),
      );
      return { code: 0, stdout: "", stderr: "" };
    }
    if (call.command === "ffmpeg") {
      calls.ffmpeg += 1;
      await writeFile(call.args[call.args.length - 1], `clip-${calls.ffmpeg}`);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (call.command === "python3") {
      calls.render += 1;
      if (opts.failRender) return { code: 1, stdout: "", stderr: "no render" };
      const out = call.args[call.args.indexOf("--out") + 1];
      await mkdir(join(out, ".."), { recursive: true }).catch(() => undefined);
      await cp(CLIP, out);
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const proposeSend = async (): Promise<string> => {
    calls.propose += 1;
    if (nextFail) {
      nextFail = false;
      return "isto não é json {{{";
    }
    if (gate) {
      const g = gate;
      gate = null;
      return g.gate;
    }
    return proposalJson;
  };
  const deps: PreparationDeps = {
    exec: { run: exec },
    proposeSend,
    describeClient: {
      send: async (): Promise<string> => {
        calls.describe += 1;
        const end = opts.describeShort ? 2 : 3;
        return JSON.stringify({
          spans: [{ start: 0, end, text: "pessoa falando", confidence: "observed", tags: [] }],
        });
      },
    },
  };
  return {
    deps,
    calls,
    failNextPropose: () => {
      nextFail = true;
    },
    blockPropose: () => {
      let release!: (json: string) => void;
      const gatePromise = new Promise<string>((resolve) => {
        release = resolve;
      });
      const slot = { release, gate: gatePromise };
      gate = slot;
      return slot;
    },
  };
}

async function seed(dir: string, specs: Array<[string, string, "speech" | "support"]>): Promise<Project> {
  await createProject(dir, blankProject("prep-test"));
  let current = await loadProject(dir);
  for (const [name, id, role] of specs) {
    const source = await sourceFrom(dir, name, id, role);
    await saveProject(dir, current.revision, (p) => ({
      ...p,
      assembly: { ...p.assembly, sources: [...p.assembly.sources, source] },
    }));
    current = await loadProject(dir);
  }
  return current;
}

function ctrl(signal?: AbortSignal) {
  return { signal: signal ?? new AbortController().signal, isCurrent: () => true };
}

describe("runPreparation", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "decupa-prep-"));
    vi.restoreAllMocks();
  });

  it("prepare leva do zero a cenas aplicadas e prévia atual", async () => {
    const base = await seed(dir, [["fala.mp4", "fala", "speech"]]);
    const { deps } = makeFakes();
    const done = await runPreparation(
      dir,
      base.revision,
      { mode: "prepare", request: "montar tudo", modelOptIn: true, visualOptIn: true },
      deps,
      ctrl(),
    );
    expect(done.revision).toBe(base.revision + 1);
    expect(done.scenes).toHaveLength(1);
    expect(done.scenes[0]?.objective).toBe("Abertura");
    expect(done.preparation?.status).toBe("ready");
    expect(done.preparation?.sources.fala?.media).toBe("ready");
    expect(done.preparation?.sources.fala?.audio).toBe("ready");
    expect(done.preparation?.sources.fala?.visual).toBe("ready");
    expect(done.previewRevision).toBe(done.revision);
    expect(done.previewArtifact?.relativePath).toMatch(/reference\.mp4$/);
    expect(done.corrections).toHaveLength(0);
  });

  it("falha do áudio da segunda fonte preserva a primeira e resolve", async () => {
    const base = await seed(dir, [["fala.mp4", "fala", "speech"], ["apoio.mp4", "apoio", "support"]]);
    const { deps } = makeFakes({ failAudioFor: "b" });
    const done = await runPreparation(
      dir,
      base.revision,
      { mode: "prepare", request: "montar tudo", modelOptIn: true, visualOptIn: true },
      deps,
      ctrl(),
    );
    const analyses = Object.fromEntries(done.analyses.map((a) => [a.sourceId, a.status]));
    expect(analyses).toMatchObject({ fala: "ready" });
    expect(done.analyses.find((a) => a.sourceId === "apoio")?.status).toBe("error");
    expect(done.scenes).toHaveLength(1);
    expect(["ready", "attention"]).toContain(done.preparation?.status);
  });

  it("duplo início não duplica cenas nem revisões", async () => {
    const base = await seed(dir, [["fala.mp4", "fala", "speech"]]);
    const { deps, calls, blockPropose } = makeFakes();
    const gate = blockPropose();
    const first = runPreparation(
      dir,
      base.revision,
      { mode: "prepare", request: "ida A", modelOptIn: true, visualOptIn: true },
      deps,
      ctrl(),
    );
    const second = runPreparation(
      dir,
      base.revision,
      { mode: "prepare", request: "ida B", modelOptIn: true, visualOptIn: true },
      deps,
      ctrl(),
    );
    gate.release(
      JSON.stringify({
        scenes: [
          { id: "sc-1", objective: "Abertura", selections: [{ speechId: "fala:u0" }] },
        ],
        changedSceneIds: ["sc-1"],
        gaps: [],
      }),
    );
    const [a, b] = await Promise.all([first, second]);
    const fresh = await loadProject(dir);
    expect(fresh.revision).toBe(base.revision + 1);
    expect(fresh.scenes.filter((sc) => sc.id === "sc-1")).toHaveLength(1);
    expect(calls.propose).toBe(1);
    expect(b.preparation?.id).toBe(a.preparation?.id);
    expect(fresh.preparation?.status).toBe("ready");
  });

  it("cancelamento marca cancelled sem lançar", async () => {
    const base = await seed(dir, [["fala.mp4", "fala", "speech"]]);
    const { deps, blockPropose } = makeFakes();
    const gate = blockPropose();
    const aborter = new AbortController();
    const run = runPreparation(
      dir,
      base.revision,
      { mode: "prepare", request: "vai cancelar", modelOptIn: true, visualOptIn: true },
      deps,
      ctrl(aborter.signal),
    );
    aborter.abort();
    gate.release("nunca usado");
    const done = await run;
    expect(done.preparation?.status).toBe("cancelled");
    expect(done.scenes).toHaveLength(0);
  });

  it("edição do usuário durante a proposta não é sobrescrita", async () => {
    const base = await seed(dir, [["fala.mp4", "fala", "speech"]]);
    const { deps, blockPropose } = makeFakes();
    const gate = blockPropose();
    const run = runPreparation(
      dir,
      base.revision,
      { mode: "prepare", request: "ida lenta", modelOptIn: true, visualOptIn: true },
      deps,
      ctrl(),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await saveProject(dir, base.revision, (p) => ({
      ...p,
      revision: p.revision + 1,
      assembly: { ...p.assembly, revision: p.revision + 1, name: "Edição do usuário" },
    }));
    const edited = await loadProject(dir);
    gate.release(
      JSON.stringify({
        scenes: [{ id: "sc-1", objective: "Abertura", selections: [{ speechId: "fala:u0" }] }],
        changedSceneIds: ["sc-1"],
        gaps: [],
      }),
    );
    const done = await run;
    expect(done.preparation?.status).toBe("interrupted");
    expect(done.assembly.name).toBe("Edição do usuário");
    expect(done.revision).toBe(edited.revision);
  });

  it("gaps necessários viram attention com prévia disponível", async () => {
    const base = await seed(dir, [["fala.mp4", "fala", "speech"]]);
    const { deps } = makeFakes({ describeShort: true });
    const done = await runPreparation(
      dir,
      base.revision,
      { mode: "prepare", request: "montar tudo", modelOptIn: true, visualOptIn: true },
      deps,
      ctrl(),
    );
    expect(done.preparation?.status).toBe("attention");
    expect(done.previewRevision).toBe(done.revision);
  });

  it("opt-in persiste permissões de modelo e visual", async () => {
    const base = await seed(dir, [["fala.mp4", "fala", "speech"]]);
    expect(base.permissions).toEqual({ model: false, visual: false });
    const { deps } = makeFakes();
    const done = await runPreparation(
      dir,
      base.revision,
      { mode: "prepare", request: "montar tudo", modelOptIn: true, visualOptIn: true },
      deps,
      ctrl(),
    );
    expect(done.permissions).toEqual({ model: true, visual: true });
  });

  it("falha da proposta interrompe sem mexer nas cenas", async () => {
    const base = await seed(dir, [["fala.mp4", "fala", "speech"]]);
    const { deps, failNextPropose } = makeFakes();
    failNextPropose();
    const done = await runPreparation(
      dir,
      base.revision,
      { mode: "prepare", request: "montar tudo", modelOptIn: true, visualOptIn: true },
      deps,
      ctrl(),
    );
    expect(done.preparation?.status).toBe("interrupted");
    expect(done.scenes).toHaveLength(0);
    expect(done.revision).toBe(base.revision);
  });

  it("preview só renderiza, sem nova proposta", async () => {
    const base = await seed(dir, [["fala.mp4", "fala", "speech"]]);
    const { deps, calls } = makeFakes();
    const prepared = await runPreparation(
      dir,
      base.revision,
      { mode: "prepare", request: "montar tudo", modelOptIn: true, visualOptIn: true },
      deps,
      ctrl(),
    );
    expect(calls.propose).toBe(1);
    const previewed = await runPreparation(
      dir,
      prepared.revision,
      { mode: "preview", request: "", modelOptIn: false, visualOptIn: false },
      deps,
      ctrl(),
    );
    expect(calls.propose).toBe(1);
    expect(previewed.preparation?.mode).toBe("preview");
    expect(previewed.preparation?.status).toBe("ready");
    expect(previewed.scenes).toHaveLength(1);
    expect(previewed.previewRevision).toBe(previewed.revision);
    expect(previewed.revision).toBe(prepared.revision);
  });

  it("adjust sem cenas rejeita", async () => {
    const base = await seed(dir, [["fala.mp4", "fala", "speech"]]);
    const { deps } = makeFakes();
    await expect(
      runPreparation(
        dir,
        base.revision,
        { mode: "adjust", request: "ajustar", modelOptIn: true, visualOptIn: true },
        deps,
        ctrl(),
      ),
    ).rejects.toThrow("nada a ajustar");
  });
});
