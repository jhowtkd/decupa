import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createProject, loadProject, saveProject } from "./store.ts";
import { blankProject } from "./routes.ts";
import { fixtureAssembly } from "./fixture.ts";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import { holdPreparation, isPreparationActive, runPreparation, type PreparationDeps } from "./preparation.ts";
import { applyTextEdit } from "./words.ts";
import type { ExecCall, ExecResult } from "../pipeline.ts";
import type { Project, Source } from "./types.ts";

const CLIP = join(FIXTURES, "clip.mp4");

async function sourceFrom(
  dir: string,
  name: string,
  id: string,
  role: "speech" | "support",
  durationSeconds = 3,
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
    durationSeconds,
    hasVideo: true,
    hasAudio: true,
    role,
    included: true,
    name,
    size: st.size,
    mtimeMs: st.mtimeMs,
  };
}

type FakeOpts = {
  failAudioFor?: string;
  failRender?: boolean;
  describeShort?: boolean;
  failVisual?: boolean;
  /** Resposta visual por janela (segundos da fonte); {throw} simula falha. */
  describeImpl?: (start: number, end: number) => { spans: { start: number; end: number; text: string }[] } | { throw: string };
  /** Grava palavras no transcript do fake para edições por palavra. */
  withWords?: boolean;
  /** Proposta enlatada alternativa (padrão: cena nova sc-1 via speechId). */
  proposalJson?: string;
};
type Calls = { ingest: number; ffmpeg: number; render: number; propose: number; describe: number };

function makeFakes(opts: FakeOpts = {}): {
  deps: PreparationDeps;
  calls: Calls;
  failNextPropose: () => void;
  blockPropose: () => { release: (json: string) => void; gate: Promise<string> };
  blockAudio: () => { release: () => void };
  blockFfmpeg: () => { release: () => void };
} {
  const calls: Calls = { ingest: 0, ffmpeg: 0, render: 0, propose: 0, describe: 0 };
  let nextFail = false;
  let gate: { release: (json: string) => void; gate: Promise<string> } | null = null;
  let audioGate: Promise<void> | null = null;
  let ffmpegGate: Promise<void> | null = null;
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
      if (audioGate) await audioGate;
      const input = call.args[call.args.indexOf("--input") + 1];
      const id = input.includes("apoio") ? "b" : "a";
      if (opts.failAudioFor === id) return { code: 1, stdout: "", stderr: "boom" };
      const work = call.env?.CLAUDE_PROJECT_DIR ?? "";
      await mkdir(join(work, "out"), { recursive: true });
      await writeFile(
        call.args[call.args.indexOf("--out") + 1],
        opts.withWords
          ? JSON.stringify({
            segments: [{
              words: [
                { text: "olá", start: 0.1, end: 0.5 },
                { text: "tema", start: 0.6, end: 1.0 },
              ],
            }],
          })
          : JSON.stringify({ segments: [{ start: 0, end: 2, text: `fala ${id}` }] }),
      );
      return { code: 0, stdout: "", stderr: "" };
    }
    if (call.command === "python3" && call.args.includes("index")) {
      calls.ingest += 1;
      if (audioGate) await audioGate;
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
      const playback = call.args.includes("scale='min(960,iw)':-2")
        || call.args.includes("-vframes")
        || call.args.includes("pcm_s16le");
      if (playback && ffmpegGate) await ffmpegGate;
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
    return opts.proposalJson ?? proposalJson;
  };
  const deps: PreparationDeps = {
    exec: { run: exec },
    proposeSend,
    describeClient: {
      send: async (content: unknown[]): Promise<string> => {
        calls.describe += 1;
        if (opts.failVisual) throw new Error("visual provider unavailable");
        if (opts.describeImpl) {
          const match = /intervalo da fonte \[([\d.]+), ([\d.]+)\)/.exec(JSON.stringify(content));
          const start = match ? Number(match[1]) : 0;
          const end = match ? Number(match[2]) : 3;
          const out = opts.describeImpl(start, end);
          if ("throw" in out) throw new Error(out.throw);
          const fetchStart = start === 0 ? 0 : start - 1;
          return JSON.stringify({
            spans: out.spans.map((span, i) => ({
              id: `local-${i}`,
              start: span.start - fetchStart,
              end: span.end - fetchStart,
              text: span.text,
              confidence: "observed",
              tags: [],
            })),
          });
        }
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
    blockAudio: () => {
      let release!: () => void;
      audioGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { release };
    },
    blockFfmpeg: () => {
      let release!: () => void;
      ffmpegGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { release };
    },
  };
}

async function seed(
  dir: string,
  specs: Array<[string, string, "speech" | "support", number?]>,
): Promise<Project> {
  await createProject(dir, blankProject("prep-test"));
  let current = await loadProject(dir);
  for (const [name, id, role, durationSeconds] of specs) {
    const source = await sourceFrom(dir, name, id, role, durationSeconds);
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

it("holdPreparation cobre o POST até o percurso assentar", () => {
  const dir = join(tmpdir(), "prep-hold");
  expect(isPreparationActive(dir)).toBe(false);
  const release = holdPreparation(dir);
  expect(isPreparationActive(dir)).toBe(true);
  const nested = holdPreparation(dir);
  nested();
  expect(isPreparationActive(dir)).toBe(true);
  release();
  expect(isPreparationActive(dir)).toBe(false);
});

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

  it("falha do áudio da segunda fonte preserva a primeira e para antes da proposta (V5)", async () => {
    const base = await seed(dir, [["fala.mp4", "fala", "speech"], ["apoio.mp4", "apoio", "support"]]);
    const { deps, calls } = makeFakes({ failAudioFor: "b" });
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
    // Barreira anterior à proposta: nada de proposta, cena ou prévia parcial.
    expect(calls.propose).toBe(0);
    expect(calls.render).toBe(0);
    expect(done.scenes).toHaveLength(0);
    expect(done.previewRevision).toBeNull();
    expect(done.preparation?.status).toBe("interrupted");
    expect(done.preparation?.error).toMatch(/apoio/);
  });

  it("falha visual para antes da proposta e retomada conclui (R1)", async () => {
    const base = await seed(dir, [["fala.mp4", "fala", "speech"]]);
    const { deps, calls } = makeFakes({ failVisual: true });
    const done = await runPreparation(
      dir,
      base.revision,
      { mode: "prepare", request: "montar tudo", modelOptIn: true, visualOptIn: true },
      deps,
      ctrl(),
    );
    expect(done.preparation?.sources.fala?.visual).toBe("error");
    expect(calls.propose).toBe(0);
    expect(calls.render).toBe(0);
    expect(done.scenes).toHaveLength(0);
    expect(done.previewRevision).toBeNull();
    expect(done.preparation?.status).toBe("interrupted");
    const retry = makeFakes();
    const resumed = await runPreparation(
      dir,
      done.revision,
      { mode: "prepare", request: "montar tudo", modelOptIn: true, visualOptIn: true },
      retry.deps,
      ctrl(),
    );
    expect(resumed.scenes).toHaveLength(1);
    expect(resumed.preparation?.status).toBe("ready");
    expect(resumed.previewRevision).toBe(resumed.revision);
  });

  it("retomar após falha completa o que falta sem perder a primeira (V5)", async () => {
    const base = await seed(dir, [["fala.mp4", "fala", "speech"], ["apoio.mp4", "apoio", "support"]]);
    const first = makeFakes({ failAudioFor: "b" });
    const blocked = await runPreparation(
      dir,
      base.revision,
      { mode: "prepare", request: "montar tudo", modelOptIn: true, visualOptIn: true },
      first.deps,
      ctrl(),
    );
    expect(blocked.preparation?.status).toBe("interrupted");
    expect(blocked.scenes).toHaveLength(0);
    const retry = makeFakes();
    const done = await runPreparation(
      dir,
      blocked.revision,
      { mode: "prepare", request: "montar tudo", modelOptIn: true, visualOptIn: true },
      retry.deps,
      ctrl(),
    );
    expect(done.scenes).toHaveLength(1);
    expect(done.preparation?.status).toBe("ready");
    expect(done.previewRevision).toBe(done.revision);
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
    const { deps, calls, blockPropose } = makeFakes();
    const gate = blockPropose();
    const run = runPreparation(
      dir,
      base.revision,
      { mode: "prepare", request: "ida lenta", modelOptIn: true, visualOptIn: true },
      deps,
      ctrl(),
    );
    // Edição pós-snapshot (a proposta já foi calculada sobre a base antiga):
    // o percurso não a sobrescreve — interrompe retomável com ela intacta.
    await vi.waitFor(async () => {
      expect(calls.propose).toBe(1);
    });
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

  it("edição correct durante o áudio faz rebase: ready sem perder a correção", async () => {
    const base = await seed(dir, [["fala.mp4", "fala", "speech"]]);
    const { deps, blockAudio } = makeFakes();
    const gate = blockAudio();
    const run = runPreparation(
      dir,
      base.revision,
      { mode: "prepare", request: "montar tudo", modelOptIn: true, visualOptIn: true },
      deps,
      ctrl(),
    );
    await vi.waitFor(async () => {
      const claimed = await loadProject(dir);
      expect(claimed.preparation?.status).toBe("running");
    });
    const before = await loadProject(dir);
    await saveProject(dir, before.revision, (p) =>
      applyTextEdit(p, { type: "correct", sourceId: "fala", start: 0, end: 1, text: "olá corrigido" }));
    gate.release();
    const done = await run;
    expect(done.preparation?.status).toBe("ready");
    expect(done.revision).toBe(base.revision + 2);
    expect(done.analyses.find((analysis) => analysis.sourceId === "fala")?.status).toBe("ready");
    expect(done.corrections).toHaveLength(1);
    expect(done.corrections[0]).toMatchObject({ sourceId: "fala", text: "olá corrigido" });
    expect(done.scenes).toHaveLength(1);
  });

  it("edição remove durante o áudio faz rebase: ready com o corte preservado", async () => {
    const base = await seed(dir, [["fala.mp4", "fala", "speech"]]);
    const first = makeFakes({ withWords: true });
    const prepared = await runPreparation(
      dir,
      base.revision,
      { mode: "prepare", request: "montar tudo", modelOptIn: true, visualOptIn: true },
      first.deps,
      ctrl(),
    );
    expect(prepared.preparation?.status).toBe("ready");
    const takeId = prepared.scenes[0]?.takes[0]?.id;
    const wordId = prepared.analyses.find((analysis) => analysis.sourceId === "fala")?.words[0]?.id;
    expect(takeId).toMatch(/^sc-1:/);
    expect(wordId).toMatch(/:w000000$/);
    // Força re-análise lenta: sem cache, o áudio volta a passar pelo executor.
    await rm(join(dir, "analysis"), { recursive: true, force: true });
    // A proposta ecoa a cena existente só-com-id: o percurso não reescreve
    // takes (a edição segue byte-a-byte igual) e termina ready.
    const second = makeFakes({
      withWords: true,
      proposalJson: JSON.stringify({
        scenes: [{ id: "sc-1" }],
        changedSceneIds: [],
        gaps: [],
      }),
    });
    const gate = second.blockAudio();
    const run = runPreparation(
      dir,
      prepared.revision,
      { mode: "prepare", request: "montar tudo", modelOptIn: true, visualOptIn: true },
      second.deps,
      ctrl(),
    );
    await vi.waitFor(async () => {
      const claimed = await loadProject(dir);
      expect(claimed.preparation?.status).toBe("running");
      expect(claimed.preparation?.revision).toBe(prepared.revision);
    });
    const before = await loadProject(dir);
    await saveProject(dir, before.revision, (p) =>
      applyTextEdit(p, { type: "remove", sceneId: "sc-1", takeId: takeId!, wordIds: [wordId!] }));
    gate.release();
    const done = await run;
    // O rebase salvou a análise sobre a revisão editada (sem o rebase o
    // percurso rejeitava com "revisão desatualizada" e nada persistia).
    expect(done.analyses.find((analysis) => analysis.sourceId === "fala")?.status).toBe("ready");
    // A edição segue intacta: o corte e a revisão dela sobreviveram.
    expect(done.scenes[0]?.takes[0]?.removed).toHaveLength(1);
    // Limite pré-existente (fora da Task 11): proposta resolvida que toca
    // cena com takes não sobrevive à revalidação do applyProposal, então o
    // percurso interrompe retomável em vez de aplicar as cenas.
    expect(done.preparation?.status).toBe("interrupted");
    expect(done.preparation?.error).toMatch(/use takeId para preservar cortes/);
    expect(done.revision).toBe(prepared.revision + 1);
  });

  it("fonte removida durante a preparação interrompe retomável sem perder a outra fonte", async () => {
    const base = await seed(dir, [["fala.mp4", "fala", "speech"], ["apoio.mp4", "apoio", "support"]]);
    const { deps, calls, blockAudio } = makeFakes();
    const gate = blockAudio();
    const run = runPreparation(
      dir,
      base.revision,
      { mode: "prepare", request: "montar tudo", modelOptIn: true, visualOptIn: true },
      deps,
      ctrl(),
    );
    // Espera o áudio começar (fase de mídia concluída): a remoção chega com
    // a primeira análise já produzida, que o interrupted deve preservar.
    await vi.waitFor(async () => {
      expect(calls.ingest).toBeGreaterThan(0);
    }, { timeout: 5000 });
    const before = await loadProject(dir);
    await saveProject(dir, before.revision, (p) => ({
      ...p,
      revision: p.revision + 1,
      assembly: {
        ...p.assembly,
        revision: p.revision + 1,
        sources: p.assembly.sources.filter((source) => source.id !== "apoio"),
      },
    }));
    gate.release();
    const done = await run;
    expect(done.preparation?.status).toBe("interrupted");
    expect(done.preparation?.error).toMatch(/fonte removida.*apoio/);
    expect(done.analyses.find((analysis) => analysis.sourceId === "fala")?.status).toBe("ready");
    // Retomável: a tentativa seguinte conclui sem refazer o áudio (cache).
    const retry = makeFakes();
    const resumed = await runPreparation(
      dir,
      done.revision,
      { mode: "prepare", request: "montar tudo", modelOptIn: true, visualOptIn: true },
      retry.deps,
      ctrl(),
    );
    expect(resumed.preparation?.status).toBe("ready");
    expect(retry.calls.ingest).toBe(0);
    expect(resumed.scenes).toHaveLength(1);
  });

  it("cobertura parcial impede proposta e retomada completa só o faltante", async () => {
    const base = await seed(dir, [["fala.mp4", "fala", "speech"]]);
    const { deps, calls } = makeFakes({ describeShort: true });
    const done = await runPreparation(
      dir,
      base.revision,
      { mode: "prepare", request: "montar tudo", modelOptIn: true, visualOptIn: true },
      deps,
      ctrl(),
    );
    // Gate: resposta parcial produz propose=render=0, sem cena nem prévia.
    expect(done.preparation?.sources.fala?.visual).toBe("pending");
    expect(done.preparation?.sources.fala?.error).toMatch(/2s–3s/);
    expect(calls.propose).toBe(0);
    expect(calls.render).toBe(0);
    expect(done.scenes).toHaveLength(0);
    expect(done.previewRevision).toBeNull();
    expect(done.preparation?.status).toBe("interrupted");
    // Retomada com resposta complementar (só 2–3s, mesma posição 0):
    // conserva 0–2s, fecha a cobertura e permite exatamente uma proposta/prévia.
    const retry = makeFakes({
      describeImpl: () => ({ spans: [{ start: 2, end: 3, text: "trecho faltante" }] }),
    });
    const resumed = await runPreparation(
      dir,
      done.revision,
      { mode: "prepare", request: "montar tudo", modelOptIn: true, visualOptIn: true },
      retry.deps,
      ctrl(),
    );
    // Só a janela incompleta foi solicitada de novo; o válido foi conservado.
    expect(retry.calls.describe).toBe(1);
    expect(retry.calls.propose).toBe(1);
    expect(retry.calls.render).toBe(1);
    expect(resumed.preparation?.status).toBe("ready");
    expect(resumed.scenes).toHaveLength(1);
    expect(resumed.previewRevision).toBe(resumed.revision);
    const analysis = resumed.analyses.find((item) => item.sourceId === "fala");
    expect(analysis?.visualCoverage.missing).toEqual([]);
    expect((analysis?.visual ?? []).map((span) => span.text).sort()).toEqual([
      "pessoa falando",
      "trecho faltante",
    ]);
    // Terceira execução reutiliza o cache completo sem outra chamada visual.
    // (A proposta enlatada idêntica é rejeitada para preservar cortes —
    // comportamento esperado; o gate aqui é só o reuso do cache.)
    const third = makeFakes();
    const again = await runPreparation(
      dir,
      resumed.revision,
      { mode: "prepare", request: "montar tudo", modelOptIn: true, visualOptIn: true },
      third.deps,
      ctrl(),
    );
    expect(third.calls.describe).toBe(0);
    expect(again.preparation?.sources.fala?.visual).toBe("ready");
  });

  it("retomada não repete janela visual completa", async () => {
    const base = await seed(dir, [["longa.mp4", "fala", "speech", 21]]);
    const first = makeFakes({
      describeImpl: (start) =>
        start === 0
          ? { spans: [{ start: 0, end: 20, text: "janela-um" }] }
          : { spans: [] },
    });
    const done = await runPreparation(
      dir,
      base.revision,
      { mode: "prepare", request: "montar tudo", modelOptIn: true, visualOptIn: true },
      first.deps,
      ctrl(),
    );
    expect(first.calls.describe).toBe(2);
    expect(done.preparation?.status).toBe("interrupted");
    expect(done.scenes).toHaveLength(0);
    const retry = makeFakes({
      describeImpl: (start, end) => ({
        spans: [{ start, end, text: start === 0 ? "janela-um" : "janela-dois" }],
      }),
    });
    const resumed = await runPreparation(
      dir,
      done.revision,
      { mode: "prepare", request: "montar tudo", modelOptIn: true, visualOptIn: true },
      retry.deps,
      ctrl(),
    );
    // [0,20) veio do cache: só [20,21) foi solicitada de novo.
    expect(retry.calls.describe).toBe(1);
    expect(resumed.preparation?.status).toBe("ready");
    expect(resumed.previewRevision).toBe(resumed.revision);
    const visual = resumed.analyses.find((item) => item.sourceId === "fala")?.visual ?? [];
    expect(visual.some((span) => span.text === "janela-um")).toBe(true);
    expect(visual.some((span) => span.text === "janela-dois")).toBe(true);
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

  it("análise de áudio começa com waveform pendente e registra o estado", async () => {
    const base = await seed(dir, [["fala.mp4", "fala", "speech"]]);
    const { deps, calls, blockFfmpeg } = makeFakes();
    const { release } = blockFfmpeg();
    const running = runPreparation(
      dir,
      base.revision,
      { mode: "prepare", request: "montar tudo", modelOptIn: true, visualOptIn: true },
      deps,
      ctrl(),
    );
    await vi.waitFor(() => {
      expect(calls.ingest).toBeGreaterThan(0);
    }, { timeout: 5000 });
    await vi.waitFor(async () => {
      const mid = await loadProject(dir);
      expect(mid.preparation?.note).toBe("áudio pronto, imagem em análise");
      expect(mid.preparation?.sources.fala?.audio).toBe("ready");
    }, { timeout: 5000 });
    release();
    const done = await running;
    expect(done.preparation?.status).toBe("ready");
    expect(done.preparation?.note).toBeUndefined();
    expect(done.previewArtifact).toBeTruthy();
  });
});
