import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createProject, loadProject, readHistorySnapshot, saveProject } from "./store.ts";
import { blankProject } from "./routes.ts";
import { fixtureAssembly } from "./fixture.ts";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import { holdPreparation, isPreparationActive, runPreparation, type PreparationDeps } from "./preparation.ts";
import { mediaWork } from "./media-work.ts";
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

const PREVIEW_WAIT_NOTE = "prévia aguardando proxy e waveform";

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
  /** Proxy com o clipe real, para o probe aceitar e o waveform chegar a rodar. */
  validProxy?: boolean;
  /** Segura cada extração de frames até `frames.release`. */
  paceFrames?: boolean;
  /** Segura cada request visual até `describes.release`. */
  paceDescribes?: boolean;
};
type Calls = { ingest: number; ffmpeg: number; render: number; propose: number; describe: number };
type Pace = { inFlight: () => number; max: () => number; release: () => void };

function makeFakes(opts: FakeOpts = {}): {
  deps: PreparationDeps;
  calls: Calls;
  execCalls: ExecCall[];
  blockPropose: () => { release: (json: string) => void; gate: Promise<string> };
  blockAudio: () => { release: () => void };
  blockFfmpeg: () => { release: () => void };
  blockProxy: () => { release: () => void };
  blockProxyTeardown: () => { release: () => void };
  blockWaveform: () => { release: () => void };
  blockDescribe: () => { release: () => void };
  proxyFinished: () => boolean;
  waveformFinished: () => boolean;
  proxyInFlight: () => number;
  proxyTeardownWaiting: () => boolean;
  waveformInFlight: () => number;
  describeBeforeProxy: () => boolean;
  liveExec: () => number;
  frames: Pace;
  describes: Pace;
} {
  const calls: Calls = { ingest: 0, ffmpeg: 0, render: 0, propose: 0, describe: 0 };
  const execCalls: ExecCall[] = [];
  let gate: { release: (json: string) => void; gate: Promise<string> } | null = null;
  let audioGate: Promise<void> | null = null;
  let ffmpegGate: Promise<void> | null = null;
  let proxyGate: Promise<void> | null = null;
  let proxyTeardownGate: Promise<void> | null = null;
  let waveformGate: Promise<void> | null = null;
  let describeGate: Promise<void> | null = null;
  let proxyDone = false;
  let waveformDone = false;
  let proxyFlight = 0;
  let proxyTeardownWaiting = false;
  let waveformFlight = 0;
  let sawDescribeBeforeProxy = false;
  let frameFlight = 0;
  let frameMax = 0;
  let describeFlight = 0;
  let describeMax = 0;
  const frameReleasers: Array<() => void> = [];
  const describeReleasers: Array<() => void> = [];
  const live = new Set<object>();

  const releaseAll = (releasers: Array<() => void>): void => {
    for (const resolve of releasers.splice(0)) resolve();
  };
  const holdSlot = (releasers: Array<() => void>): Promise<void> =>
    new Promise((resolve) => {
      releasers.push(resolve);
    });
  const killed = (): ExecResult => ({ code: 1, stdout: "", stderr: "killed" });
  const waitOrKill = async (
    signal: AbortSignal | undefined,
    gates: Array<Promise<void> | null>,
  ): Promise<ExecResult | null> => {
    if (signal?.aborted) return killed();
    const pending = gates.filter((item): item is Promise<void> => item != null);
    if (pending.length === 0) return null;
    if (!signal) {
      await Promise.all(pending);
      return null;
    }
    return await new Promise((resolve) => {
      const finish = (result: ExecResult | null) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = () => finish(killed());
      signal.addEventListener("abort", onAbort, { once: true });
      Promise.all(pending).then(() => finish(null), () => finish(null));
    });
  };
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
    execCalls.push(call);
    const token = {};
    live.add(token);
    try {
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
      if (call.args.includes("-encoders")) {
        return { code: 0, stdout: " V..... libx264            libx264 H.264\n", stderr: "" };
      }
      const dest = call.args[call.args.length - 1];
      // Extração de frames: um JPEG por segundo solicitado, no padrão de saída.
      if (dest && dest.includes("%03d")) {
        frameFlight += 1;
        frameMax = Math.max(frameMax, frameFlight);
        try {
          if (opts.paceFrames) {
            const stopped = await waitOrKill(call.signal, [holdSlot(frameReleasers)]);
            if (stopped) return stopped;
          }
          const seconds = Number(call.args[call.args.indexOf("-t") + 1]!);
          for (let i = 0; i < seconds; i += 1) {
            await writeFile(dest.replace("%03d", String(i).padStart(3, "0")), `frame-${i}`);
          }
          return { code: 0, stdout: "", stderr: "" };
        } finally {
          frameFlight -= 1;
        }
      }
      const isProxy = call.args.includes("scale='min(960,iw)':-2");
      const isWave = call.args.includes("pcm_s16le");
      const isThumb = call.args.includes("-vframes");
      if (isProxy || isWave || isThumb) {
        if (isProxy) proxyFlight += 1;
        if (isWave) waveformFlight += 1;
        try {
          const stopped = await waitOrKill(call.signal, [
            ffmpegGate,
            isProxy ? proxyGate : null,
            isWave ? waveformGate : null,
          ]);
          if (stopped) {
            if (isProxy && proxyTeardownGate) {
              proxyTeardownWaiting = true;
              try {
                await proxyTeardownGate;
              } finally {
                proxyTeardownWaiting = false;
              }
            }
            return stopped;
          }
          if (dest && !dest.startsWith("-")) {
            if (isProxy && opts.validProxy) await cp(CLIP, dest);
            else await writeFile(dest, `clip-${calls.ffmpeg}`);
          }
          if (isProxy) proxyDone = true;
          if (isWave) waveformDone = true;
          return { code: 0, stdout: "", stderr: "" };
        } finally {
          if (isProxy) proxyFlight -= 1;
          if (isWave) waveformFlight -= 1;
        }
      }
      if (dest && !dest.startsWith("-")) {
        await writeFile(dest, `clip-${calls.ffmpeg}`);
      }
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
    } finally {
      live.delete(token);
    }
  };
  const proposeSend = async (): Promise<string> => {
    calls.propose += 1;
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
      model: "fake-visual",
      providerKey: "fake",
      send: async (content: unknown[], signal?: AbortSignal): Promise<string> => {
        calls.describe += 1;
        if (!proxyDone) sawDescribeBeforeProxy = true;
        describeFlight += 1;
        describeMax = Math.max(describeMax, describeFlight);
        try {
        const stopped = await waitOrKill(signal, [
          describeGate,
          opts.paceDescribes ? holdSlot(describeReleasers) : null,
        ]);
        if (stopped) throw new Error("descrição visual cancelada");
        if (opts.failVisual) throw new Error("visual provider unavailable");
        if (opts.describeImpl) {
          const match = /na fonte: \[([\d.]+), ([\d.]+)\)/.exec(JSON.stringify(content));
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
        } finally {
          describeFlight -= 1;
        }
      },
    },
  };
  const openGate = (): { release: () => void; promise: Promise<void> } => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { release, promise };
  };
  return {
    deps,
    calls,
    execCalls,
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
      const opened = openGate();
      audioGate = opened.promise;
      return { release: opened.release };
    },
    blockFfmpeg: () => {
      const opened = openGate();
      ffmpegGate = opened.promise;
      return { release: opened.release };
    },
    blockProxy: () => {
      const opened = openGate();
      proxyGate = opened.promise;
      return { release: opened.release };
    },
    blockProxyTeardown: () => {
      const opened = openGate();
      proxyTeardownGate = opened.promise;
      return { release: opened.release };
    },
    blockWaveform: () => {
      const opened = openGate();
      waveformGate = opened.promise;
      return { release: opened.release };
    },
    blockDescribe: () => {
      const opened = openGate();
      describeGate = opened.promise;
      return { release: opened.release };
    },
    proxyFinished: () => proxyDone,
    waveformFinished: () => waveformDone,
    proxyInFlight: () => proxyFlight,
    proxyTeardownWaiting: () => proxyTeardownWaiting,
    waveformInFlight: () => waveformFlight,
    describeBeforeProxy: () => sawDescribeBeforeProxy,
    liveExec: () => live.size,
    frames: {
      inFlight: () => frameFlight,
      max: () => frameMax,
      release: () => releaseAll(frameReleasers),
    },
    describes: {
      inFlight: () => describeFlight,
      max: () => describeMax,
      release: () => releaseAll(describeReleasers),
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
    expect((await readHistorySnapshot(dir, base.revision)).scenes).toEqual([]);
    expect(done.proposal?.decisionReport?.status).toBe("not-run");
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

  it("prévia enfileirada na preparação não lança após cancelar", async () => {
    const base = await seed(dir, [["fala.mp4", "fala", "speech"]]);
    const { deps, calls } = makeFakes();
    const prepared = await runPreparation(
      dir,
      base.revision,
      { mode: "prepare", request: "montar tudo", modelOptIn: true, visualOptIn: true },
      deps,
      ctrl(),
    );
    expect(prepared.preparation?.status).toBe("ready");
    expect(calls.render).toBe(1);
    await rm(join(dir, "preview-cache"), { recursive: true, force: true });
    let release!: () => void;
    const holderGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = mediaWork.run(() => holderGate);
    const aborter = new AbortController();
    try {
      const run = runPreparation(
        dir,
        prepared.revision,
        { mode: "preview", request: "", modelOptIn: false, visualOptIn: false },
        deps,
        ctrl(aborter.signal),
      );
      await vi.waitFor(() => {
        expect(mediaWork.waiting).toBeGreaterThanOrEqual(1);
      });
      aborter.abort();
      release();
      const done = await run;
      expect(done.preparation?.status).toBe("cancelled");
      expect(calls.render).toBe(1);
    } finally {
      release();
      await holding.catch(() => undefined);
    }
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
      expect(claimed.preparation?.sources.fala?.audio).toBe("running");
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
    expect(done.preparation?.status).toBe("ready");
    expect(done.revision).toBe(prepared.revision + 2);
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

  it("reexecução com mesma configuração não troca IDs nem reanalisa", async () => {
    const base = await seed(dir, [["fala.mp4", "fala", "speech"]]);
    const first = makeFakes();
    const done = await runPreparation(
      dir,
      base.revision,
      { mode: "prepare", request: "montar tudo", modelOptIn: true, visualOptIn: true },
      first.deps,
      ctrl(),
    );
    const beforeIds = done.analyses.find((item) => item.sourceId === "fala")?.visual.map((span) => span.id);
    expect(beforeIds).toEqual(["fala:w0:0"]);
    await saveProject(dir, done.revision, (p) => ({
      ...p,
      scenes: [{
        id: "s-manual",
        objective: "Manual",
        rationale: "apoio manual de teste",
        speechIds: ["fala:u0"],
        takes: [{
          id: "s-manual:fala:u0", sourceId: "fala", speechId: "fala:u0",
          start: 0, end: 1.2, removed: [], protected: [],
        }],
        visualEvidenceIds: [],
        support: [{ visualId: "fala:w0:0", offsetFrames: 0, durationFrames: 25 }],
        gaps: [],
      }],
    }));
    const current = await loadProject(dir);
    const second = makeFakes();
    const again = await runPreparation(
      dir,
      current.revision,
      { mode: "prepare", request: "montar tudo", modelOptIn: true, visualOptIn: true },
      second.deps,
      ctrl(),
    );
    // Mesma configuração: zero novas chamadas visuais, mesmos IDs, apoio válido.
    expect(second.calls.describe).toBe(0);
    expect(again.analyses.find((item) => item.sourceId === "fala")?.visual.map((span) => span.id))
      .toEqual(beforeIds);
    const support = again.scenes.find((scene) => scene.id === "s-manual")?.support ?? [];
    expect(support).toHaveLength(1);
    const catalog = new Set(again.analyses.flatMap((analysis) => analysis.visual.map((span) => span.id)));
    expect(support.every((entry) => catalog.has(entry.visualId))).toBe(true);
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

  it("proposta inválida após a correção interrompe sem mexer nas cenas", async () => {
    const base = await seed(dir, [["fala.mp4", "fala", "speech"]]);
    const { deps, calls } = makeFakes({ proposalJson: "isto não é json {{{" });
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
    expect(calls.propose).toBe(2);
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

  it("áudio fica pronto com proxy pendente; a nota de prévia só aparece depois da proposta", async () => {
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
      expect(mid.preparation?.sources.fala?.audio).toBe("ready");
    }, { timeout: 5000 });
    await vi.waitFor(async () => {
      const mid = await loadProject(dir);
      expect(mid.preparation?.note).toBe(PREVIEW_WAIT_NOTE);
      expect(mid.preparation?.stage).toBe("proposal");
      expect(mid.scenes).toHaveLength(1);
      expect(mid.preparation?.sources.fala?.audio).toBe("ready");
      expect(mid.preparation?.sources.fala?.visual).toBe("ready");
    }, { timeout: 10000 });
    expect(calls.propose).toBeGreaterThan(0);
    expect(calls.describe).toBeGreaterThan(0);
    expect(calls.render).toBe(0);
    release();
    const done = await running;
    expect(done.preparation?.status).toBe("ready");
    expect(done.preparation?.stage).toBe("preview");
    expect(done.preparation?.note).toBeUndefined();
    expect(done.previewArtifact).toBeTruthy();
    expect(calls.render).toBe(1);
  });

  it("análise de áudio não dispara ingest visual e salva fala/palavras sem cobertura", async () => {
    const base = await seed(dir, [["fala.mp4", "fala", "speech"]]);
    const { deps, execCalls, blockFfmpeg } = makeFakes({ withWords: true });
    const { release } = blockFfmpeg();
    const running = runPreparation(
      dir,
      base.revision,
      { mode: "prepare", request: "montar tudo", modelOptIn: true, visualOptIn: true },
      deps,
      ctrl(),
    );

    let mid: Project;
    await vi.waitFor(async () => {
      mid = await loadProject(dir);
      expect(mid.preparation?.sources.fala?.audio).toBe("ready");
    }, { timeout: 5000 });

    expect(execCalls.some((call) => call.args.includes(
      "fps=4,scale='min(540,iw)':'min(960,ih)':force_original_aspect_ratio=decrease",
    ))).toBe(false);
    expect(execCalls.some((call) => call.command === "uv" && call.args.includes("run")
      && call.args.includes("python") && call.args.includes("visual_index.py"))).toBe(false);
    const analysis = mid!.analyses.find((item) => item.sourceId === "fala");
    expect(analysis?.speech).toEqual([{
      id: "fala:u0",
      sourceId: "fala",
      start: 0,
      end: 1.2,
      text: "fala transcrito",
    }]);
    expect(analysis?.words.map(({ text, start, end }) => ({ text, start, end }))).toEqual([
      { text: "olá", start: 0.1, end: 0.5 },
      { text: "tema", start: 0.6, end: 1 },
    ]);

    release();
    await running;
  });
  it("visual e proposta correm antes do proxy; o render espera proxy e waveform", async () => {
    const base = await seed(dir, [["fala.mp4", "fala", "speech"]]);
    const fakes = makeFakes({ withWords: true, validProxy: true });
    const audio = fakes.blockAudio();
    const proxy = fakes.blockProxy();
    const waveform = fakes.blockWaveform();
    const visual = fakes.blockDescribe();
    const running = runPreparation(
      dir,
      base.revision,
      { mode: "prepare", request: "montar tudo", modelOptIn: true, visualOptIn: true },
      fakes.deps,
      ctrl(),
    );
    try {
      await vi.waitFor(async () => {
        const mid = await loadProject(dir);
        expect(mid.preparation?.status).toBe("running");
        expect(mid.preparation?.stage).toBe("audio");
        expect(mid.preparation?.sources.fala).toMatchObject({
          media: "ready",
          audio: "running",
          visual: "pending",
        });
        expect(mid.preparation?.note).toBeUndefined();
      }, { timeout: 5000 });
      expect(fakes.calls.describe).toBe(0);
      expect(fakes.calls.propose).toBe(0);
      expect(fakes.calls.render).toBe(0);
      expect(fakes.liveExec()).toBeGreaterThan(0);
      audio.release();

      await vi.waitFor(() => {
        expect(fakes.calls.describe).toBeGreaterThan(0);
        expect(fakes.proxyFinished()).toBe(false);
        expect(fakes.proxyInFlight()).toBeGreaterThan(0);
      }, { timeout: 5000 });
      expect(fakes.describeBeforeProxy()).toBe(true);
      const atVisual = await loadProject(dir);
      expect(atVisual.preparation?.stage).toBe("visual");
      expect(atVisual.preparation?.note).toBeUndefined();
      expect(atVisual.preparation?.sources.fala).toMatchObject({
        media: "ready",
        audio: "ready",
        visual: "running",
      });
      expect(fakes.calls.propose).toBe(0);
      expect(fakes.calls.render).toBe(0);
      visual.release();

      await vi.waitFor(async () => {
        const mid = await loadProject(dir);
        const analysis = mid.analyses.find((item) => item.sourceId === "fala");
        expect(analysis?.words.map((word) => word.text)).toEqual(["olá", "tema"]);
        expect(analysis?.visual.length).toBeGreaterThan(0);
        expect(mid.preparation?.sources.fala?.visual).toBe("ready");
        expect(fakes.proxyFinished()).toBe(false);
      }, { timeout: 5000 });

      await vi.waitFor(async () => {
        const mid = await loadProject(dir);
        expect(mid.scenes).toHaveLength(1);
        expect(mid.preparation?.note).toBe(PREVIEW_WAIT_NOTE);
        expect(mid.preparation?.stage).toBe("proposal");
        expect(mid.preparation?.status).toBe("running");
        expect(fakes.proxyFinished()).toBe(false);
        expect(fakes.waveformFinished()).toBe(false);
      }, { timeout: 5000 });
      expect(fakes.calls.propose).toBeGreaterThan(0);
      expect(fakes.calls.render).toBe(0);

      proxy.release();
      await vi.waitFor(() => {
        expect(fakes.proxyFinished()).toBe(true);
        expect(fakes.waveformInFlight()).toBeGreaterThan(0);
        expect(fakes.waveformFinished()).toBe(false);
      }, { timeout: 5000 });
      expect(fakes.calls.render).toBe(0);
      const waitingPreview = await loadProject(dir);
      expect(waitingPreview.preparation?.note).toBe(PREVIEW_WAIT_NOTE);
      expect(waitingPreview.preparation?.stage).toBe("proposal");
      expect(waitingPreview.previewArtifact).toBeNull();

      waveform.release();
      const done = await running;
      expect(fakes.waveformFinished()).toBe(true);
      expect(fakes.calls.render).toBe(1);
      expect(done.preparation?.status).toBe("ready");
      expect(done.preparation?.stage).toBe("preview");
      expect(done.preparation?.note).toBeUndefined();
      expect(done.preparation?.sources.fala).toMatchObject({
        media: "ready",
        audio: "ready",
        visual: "ready",
      });
      expect(done.previewArtifact?.relativePath).toMatch(/reference\.mp4$/);
    } finally {
      audio.release();
      visual.release();
      proxy.release();
      waveform.release();
      await running.catch(() => undefined);
    }
  });

  it("cancelar o visual que começou antes das imagens encerra os subprocessos", async () => {
    const base = await seed(dir, [["fala.mp4", "fala", "speech"]]);
    const fakes = makeFakes();
    const proxy = fakes.blockProxy();
    const visual = fakes.blockDescribe();
    const aborter = new AbortController();
    const run = runPreparation(
      dir,
      base.revision,
      { mode: "prepare", request: "vai cancelar", modelOptIn: true, visualOptIn: true },
      fakes.deps,
      ctrl(aborter.signal),
    );
    try {
      await vi.waitFor(() => {
        expect(fakes.calls.describe).toBeGreaterThan(0);
        expect(fakes.proxyInFlight()).toBeGreaterThan(0);
        expect(fakes.proxyFinished()).toBe(false);
      }, { timeout: 5000 });
      expect(fakes.describeBeforeProxy()).toBe(true);
      const mid = await loadProject(dir);
      expect(mid.preparation?.stage).toBe("visual");
      expect(mid.preparation?.sources.fala?.visual).toBe("running");
      expect(mid.preparation?.sources.fala?.audio).toBe("ready");
      expect(fakes.liveExec()).toBeGreaterThan(0);
      aborter.abort();
      const done = await run;
      expect(done.preparation?.status).toBe("cancelled");
      expect(done.scenes).toHaveLength(0);
      expect(fakes.calls.propose).toBe(0);
      expect(fakes.calls.render).toBe(0);
      await vi.waitFor(() => {
        expect(fakes.liveExec()).toBe(0);
      }, { timeout: 5000 });
    } finally {
      aborter.abort();
      proxy.release();
      visual.release();
    }
  });

  it("cancelar o último consumidor espera o teardown do proxy", async () => {
    const base = await seed(dir, [["fala.mp4", "fala", "speech"]]);
    const fakes = makeFakes();
    const proxy = fakes.blockProxy();
    const teardown = fakes.blockProxyTeardown();
    const visual = fakes.blockDescribe();
    const aborter = new AbortController();
    const run = runPreparation(
      dir,
      base.revision,
      { mode: "prepare", request: "vai cancelar", modelOptIn: true, visualOptIn: true },
      fakes.deps,
      ctrl(aborter.signal),
    );
    let settled = false;
    void run.then(() => { settled = true; }, () => { settled = true; });
    try {
      await vi.waitFor(() => {
        expect(fakes.calls.describe).toBeGreaterThan(0);
        expect(fakes.proxyInFlight()).toBeGreaterThan(0);
      }, { timeout: 5000 });
      aborter.abort();
      await vi.waitFor(() => {
        expect(fakes.proxyTeardownWaiting()).toBe(true);
      }, { timeout: 5000 });
      expect(settled).toBe(false);
      expect(fakes.liveExec()).toBeGreaterThan(0);
      teardown.release();
      const done = await run;
      expect(done.preparation?.status).toBe("cancelled");
      expect(fakes.liveExec()).toBe(0);
    } finally {
      aborter.abort();
      proxy.release();
      teardown.release();
      visual.release();
      await run.catch(() => undefined);
    }
  });

  it("cancelar remove o proxy que ainda aguarda a fila global", async () => {
    const base = await seed(dir, [["fala.mp4", "fala", "speech"]]);
    const fakes = makeFakes();
    const visual = fakes.blockDescribe();
    let releaseHolder!: () => void;
    const holder = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holding = mediaWork.run(() => holder);
    const aborter = new AbortController();
    const run = runPreparation(
      dir,
      base.revision,
      { mode: "prepare", request: "vai cancelar", modelOptIn: true, visualOptIn: true },
      fakes.deps,
      ctrl(aborter.signal),
    );
    try {
      await vi.waitFor(() => {
        expect(fakes.calls.describe).toBeGreaterThan(0);
        expect(fakes.proxyInFlight()).toBe(0);
        expect(mediaWork.waiting).toBeGreaterThanOrEqual(1);
      }, { timeout: 5000 });
      aborter.abort();
      const done = await run;
      expect(done.preparation?.status).toBe("cancelled");
      expect(mediaWork.waiting).toBe(0);
      expect(fakes.liveExec()).toBe(0);
    } finally {
      aborter.abort();
      visual.release();
      releaseHolder();
      await holding.catch(() => undefined);
      await run.catch(() => undefined);
    }
  });

  it("interrompe os artefatos de prévia antes de devolver falha visual", async () => {
    const base = await seed(dir, [["fala.mp4", "fala", "speech"]]);
    const fakes = makeFakes({ failVisual: true });
    const proxy = fakes.blockProxy();
    const visual = fakes.blockDescribe();
    const run = runPreparation(
      dir,
      base.revision,
      { mode: "prepare", request: "vai falhar", modelOptIn: true, visualOptIn: true },
      fakes.deps,
      ctrl(),
    );
    try {
      await vi.waitFor(() => {
        expect(fakes.calls.describe).toBeGreaterThan(0);
        expect(fakes.proxyInFlight()).toBeGreaterThan(0);
      }, { timeout: 5000 });
      visual.release();
      const done = await run;
      expect(done.preparation?.status).toBe("interrupted");
      expect(fakes.calls.propose).toBe(0);
      expect(fakes.calls.render).toBe(0);
      expect(fakes.proxyInFlight()).toBe(0);
      expect(fakes.liveExec()).toBe(0);
    } finally {
      proxy.release();
      visual.release();
      await run.catch(() => undefined);
    }
  });

  it("sem opt-in pago o visual não descreve", async () => {
    const base = await seed(dir, [["fala.mp4", "fala", "speech"]]);
    expect(base.permissions).toEqual({ model: false, visual: false });
    const { deps, calls } = makeFakes();
    deps.describeClient = undefined;
    const done = await runPreparation(
      dir,
      base.revision,
      { mode: "prepare", request: "montar tudo", modelOptIn: true, visualOptIn: false },
      deps,
      ctrl(),
    );
    expect(calls.describe).toBe(0);
    expect(done.permissions).toEqual({ model: true, visual: false });
    expect(done.preparation?.sources.fala?.visual).toBe("pending");
    expect(done.analyses.find((item) => item.sourceId === "fala")?.visual ?? []).toEqual([]);
    expect(done.preparation?.status).toBe("ready");
    expect(done.scenes).toHaveLength(1);
  });

  it("visual não estoura o pool de frames nem de requests", async () => {
    const base = await seed(dir, [["longa.mp4", "fala", "speech", 61]]);
    const fakes = makeFakes({
      paceFrames: true,
      paceDescribes: true,
      describeImpl: (start, end) => ({ spans: [{ start, end, text: `janela-${start}` }] }),
    });
    const running = runPreparation(
      dir,
      base.revision,
      { mode: "prepare", request: "montar tudo", modelOptIn: true, visualOptIn: true },
      fakes.deps,
      ctrl(),
    );
    let releaseFrames = false;
    let releaseDescribes = false;
    const pump = setInterval(() => {
      if (releaseFrames) fakes.frames.release();
      if (releaseDescribes) fakes.describes.release();
    }, 5);
    try {
      await vi.waitFor(() => {
        expect(fakes.frames.inFlight()).toBe(2);
      }, { timeout: 5000 });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(fakes.frames.max()).toBe(2);
      expect(fakes.frames.inFlight()).toBe(2);
      releaseFrames = true;
      await vi.waitFor(() => {
        expect(fakes.describes.inFlight()).toBe(2);
      }, { timeout: 5000 });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(fakes.describes.max()).toBe(2);
      expect(fakes.describes.inFlight()).toBe(2);
      releaseDescribes = true;
      const done = await running;
      expect(fakes.calls.describe).toBe(4);
      expect(fakes.frames.max()).toBeLessThanOrEqual(2);
      expect(fakes.describes.max()).toBeLessThanOrEqual(2);
      expect(done.preparation?.sources.fala?.visual).toBe("ready");
      expect(done.preparation?.status).toBe("ready");
    } finally {
      clearInterval(pump);
      fakes.frames.release();
      fakes.describes.release();
      await running.catch(() => undefined);
    }
  }, 20_000);
});

it.each(["cancelar","editar"])("não publica decisão Jev tardia ao %s", async action => {
  const dir=mkdtempSync(join(tmpdir(),"prep-jev-"));
  const base=await seed(dir,[["fala.mp4","fala","speech"],["outra.mp4","outra","speech"]]);
  const {deps}=makeFakes({proposalJson:JSON.stringify({scenes:[{id:"s",speechIds:["fala:u0","outra:u0"]}],changedSceneIds:["s"],cutCandidates:[{sceneId:"s",speechId:"fala:u0",reason:"repetição"}]})});
  let entered=false;let release!:()=>void;
  const gate=new Promise<void>(r=>{release=r;});
  deps.decision={mode:"hybrid",model:"test",client:{decide:async req=>{entered=true;await gate;return {model:"test",answers:Object.fromEntries(Object.keys(req.questions).map(id=>[id,{type:"noul" as const,noul:1}]))};}}};
  const aborter=new AbortController();
  const run=runPreparation(dir,base.revision,{mode:"prepare",request:"montar",modelOptIn:true,visualOptIn:true},deps,ctrl(aborter.signal));
  await vi.waitFor(()=>expect(entered).toBe(true));
  expect((await loadProject(dir)).preparation?.note).toBe("Jev avaliando cortes");
  if(action==="cancelar") aborter.abort();
  else await saveProject(dir,base.revision,p=>({...p,revision:p.revision+1,assembly:{...p.assembly,revision:p.revision+1,name:"edição preservada"}}));
  release();const done=await run;
  expect(done.scenes).toHaveLength(0);
  expect(done.proposal).toBeNull();
  expect(done.preparation?.status).toBe(action==="cancelar"?"cancelled":"interrupted");
});
