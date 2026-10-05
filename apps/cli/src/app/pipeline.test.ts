import { access, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createFileCoordinator } from "@decupa/coordinator";
import { CancelledError } from "@decupa/queue";
import { FIXTURES } from "../../../../tests/fixtures/global-setup.ts";
import { collectSink, createTracer } from "@decupa/trace";
import {
  audioProxyPath,
  DEFAULT_ENGINE,
  ensureAudioProxy,
  enginePatchError,
  FakeExecutor,
  makeTriageProxy,
  preflight,
  probeFps,
  runIngest,
  runPlan,
  runRender,
  runTriage,
  SpawnExecutor,
  transcriptTaskId,
  visualProxyArgs,
  type ExecCall,
  type Executor,
} from "./pipeline.ts";

const job = { id: "j1", videoPath: "/vid/aula.mp4", workDir: "/work/j1" };
const realJob = {
  id: "j1",
  videoPath: resolve("tests/fixtures/generated/clip.mp4"),
  workDir: "/work/j1",
};

/** Todo binário responde bem — isola a etapa que o teste quer olhar. */
const okExec: Executor = {
  async run() {
    return { code: 0, stdout: "", stderr: "" };
  },
};

/** Motor mínimo: só o que o preflight abre, com o léxico que o teste pede. */
async function writeFakeEngine(
  terminalPunct: string,
  opts: { lexicon?: boolean } = {},
): Promise<string> {
  const engine = await mkdtemp(join(tmpdir(), "motor-"));
  const tools = join(engine, "mcp", "ve_tools");
  await mkdir(tools, { recursive: true });
  await writeFile(join(tools, "condense.py"), "# motor de mentira\n", "utf8");
  const lexicon = opts.lexicon === false
    ? ""
    : 'FILLERS_SOFT_PT = ["tipo", "né", "tá"]\n';
  await writeFile(
    join(tools, "condense_lang.py"),
    `_TERMINAL_PUNCT = "${terminalPunct}"\n_CLAUSE_PUNCT = "，,、；;：:"\n${lexicon}`,
    "utf8",
  );
  return engine;
}

describe("runIngest", () => {
  it("transcreve, indexa, tenta o visual e reporta cada estágio na ordem", async () => {
    const exec = new FakeExecutor();
    const stages: string[] = [];
    await runIngest(job, exec, (s) => stages.push(s));
    expect(stages).toEqual(["transcribing", "indexing", "visual"]);
  });

  it.each([
    ["default", undefined],
    ["explícito", true],
  ] as const)("mantém proxy, sidecar, saída e ordem com visual %s", async (_label, visual) => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-ingest-visual-"));
    const exec = new FakeExecutor({ stdout: JSON.stringify({ video: "x", fps: 4, units: [] }) });
    const stages: string[] = [];
    const opts = visual === undefined ? undefined : { visual };
    await runIngest(
      { ...job, workDir: dir },
      exec,
      (stage) => stages.push(stage),
      undefined,
      undefined,
      undefined,
      undefined,
      opts,
    );

    expect(stages).toEqual(["transcribing", "indexing", "visual"]);
    expect(exec.calls.some((call) => call.command === "ffmpeg" && call.args.includes(
      "fps=4,scale='min(540,iw)':'min(960,ih)':force_original_aspect_ratio=decrease",
    ))).toBe(true);
    expect(exec.calls.some((call) => call.command === "uv" && call.args.includes("run")
      && call.args.includes("python") && call.args.includes("visual_index.py"))).toBe(true);
    expect(await readFile(join(dir, "out", "visual_index.json"), "utf8"))
      .toBe(JSON.stringify({ video: "x", fps: 4, units: [] }));
  });

  it("visual desligado não chama proxy/sidecar, não sinaliza etapa nem grava aviso ou índice", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-ingest-no-visual-"));
    const calls: ExecCall[] = [];
    const exec: Executor = {
      async run(call) {
        calls.push(call);
        if (call.command === "ffmpeg" || call.command === "uv"
          || call.args.includes("visual_index.py")
          || call.args.includes("fps=4,scale='min(540,iw)':'min(960,ih)':force_original_aspect_ratio=decrease")) {
          return { code: 1, stdout: "", stderr: "MediaPipe não está instalado" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const stages: string[] = [];
    const sink = collectSink();
    const result = await runIngest(
      { ...job, workDir: dir },
      exec,
      (stage) => stages.push(stage),
      undefined,
      createTracer(sink),
      undefined,
      undefined,
      { visual: false },
    );

    expect(calls.some((call) => call.args.includes("condense-prep"))).toBe(true);
    expect(calls.some((call) => call.command === "python3" && call.args.includes("index"))).toBe(true);
    expect(calls.every((call) => call.env?.CLAUDE_PROJECT_DIR === dir)).toBe(true);
    expect(calls.some((call) => call.command === "ffmpeg")).toBe(false);
    expect(calls.some((call) => call.args.includes("visual_index.py"))).toBe(false);
    expect(stages).toEqual(["transcribing", "indexing"]);
    expect(sink.events.some((event) => event.stage === "visual")).toBe(false);
    expect(result).toEqual({});
    await expect(readFile(join(dir, "out", "visual_index.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("passa CLAUDE_PROJECT_DIR para o motor em toda chamada", async () => {
    // Sem diretório por job, dois vídeos no mesmo cwd se sobrescrevem.
    const exec = new FakeExecutor();
    await runIngest(job, exec, () => {});
    // `uv sync --check` confere o venv do sidecar: não é chamada ao motor e
    // não tem diretório de job.
    for (const call of exec.calls.filter((c) => !c.args.includes("sync"))) {
      expect(call.env?.CLAUDE_PROJECT_DIR).toBe("/work/j1");
    }
    // Sem isso o filtro acima esconderia um sync que sumiu ou que apontou
    // para o venv errado: o da visão é o único que o ingest confere.
    const syncs = exec.calls.filter((c) => c.args.includes("sync"));
    expect(syncs.length).toBeGreaterThan(0);
    for (const call of syncs) expect(call.cwd).toMatch(/services[\\/]vision$/);
  });

  it("estoura com a saída do motor quando uma etapa falha", async () => {
    const exec = new FakeExecutor({ code: 2, stdout: "[ERROR] transcript inválido" });
    await expect(runIngest(job, exec, () => {})).rejects.toThrow(/transcript inválido/);
  });

  it("reusa transcript.json e só roda o índice e o visual", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-ingest-"));
    await writeFile(join(dir, "transcript.json"), "{}", "utf8");
    const exec = new FakeExecutor();
    await runIngest({ id: "j1", videoPath: "/vid/aula.mp4", workDir: dir }, exec, () => {});
    expect(exec.calls[0]!.args).toContain("index");
    expect(exec.calls.some((c) => c.args.includes("condense-prep"))).toBe(false);
    expect(exec.calls.some((c) => c.args.includes("visual_index.py"))).toBe(true);
  });

  it("aceita transcript sem segmentos e grava índice vazio sem chamar o motor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-ingest-"));
    await writeFile(join(dir, "transcript.json"), JSON.stringify({ segments: [] }), "utf8");
    const exec = new FakeExecutor();
    const stages: string[] = [];
    await runIngest({ id: "j1", videoPath: "/vid/apoio.mp4", workDir: dir }, exec, (s) => stages.push(s));
    expect(stages).toEqual(["indexing", "visual"]);
    expect(exec.calls).toHaveLength(0);
    expect(JSON.parse(await readFile(join(dir, "out", "speech_index.json"), "utf8"))).toMatchObject({ units: [] });
  });

  it("tenta o sidecar de visão com cwd em services/vision", async () => {
    const exec = new FakeExecutor();
    await runIngest(job, exec, () => {});
    const vis = exec.calls.find((c) => c.args.includes("visual_index.py"));
    expect(vis).toBeDefined();
    expect(vis!.command).toBe("uv");
    expect(isAbsolute(vis!.cwd!)).toBe(true);
    expect(vis!.cwd!.endsWith(join("services", "vision"))).toBe(true);
    expect(vis!.args).toContain("--fps");
    expect(vis!.args).toContain("4");
    const proxy = exec.calls.find((c) => c.command === "ffmpeg" && c.args.includes("fps=4,scale='min(540,iw)':'min(960,ih)':force_original_aspect_ratio=decrease"));
    expect(proxy).toBeDefined();
  });

  it("chama visual_index.py com uv run --no-sync", async () => {
    // Sem --no-sync, uv cria um .venv vazio quando o sidecar não está sincronizado.
    const exec = new FakeExecutor();
    await runIngest(job, exec, () => {});
    const vis = exec.calls.find((call) => call.args.includes("visual_index.py"));
    expect(vis?.args.slice(0, 4)).toEqual(["run", "--no-sync", "python", "visual_index.py"]);
  });

  it("invoca o condense-prep com o Node do processo na raiz do repo, não no cwd de quem chamou", async () => {
    // Sem subprocesso pnpm: o CLI é reentrado pelo próprio Node, por caminho
    // absoluto, e o cwd segue sendo a raiz do repo.
    const exec = new FakeExecutor();
    await runIngest(job, exec, () => {});
    const prep = exec.calls.find((c) => c.args.includes("condense-prep"))!;
    expect(prep.command).toBe(process.execPath);
    expect(prep.args[0]).toBe("--experimental-strip-types");
    expect(isAbsolute(prep.args[1]!)).toBe(true);
    expect(prep.cwd).toBeDefined();
    expect(isAbsolute(prep.cwd!)).toBe(true);
  });

  it("proxy visual decodifica em hardware só quando pedido e mantém o libx264", () => {
    const hw = visualProxyArgs("/in.mp4", "/out.mp4", true);
    expect(hw.indexOf("-hwaccel")).toBeLessThan(hw.indexOf("-i"));
    expect(hw[hw.indexOf("-hwaccel") + 1]).toBe("videotoolbox");
    expect(hw[hw.indexOf("-c:v") + 1]).toBe("libx264");
    const sw = visualProxyArgs("/in.mp4", "/out.mp4", false);
    expect(sw).not.toContain("-hwaccel");
    expect(sw.slice(sw.indexOf("-i"))).toEqual(hw.slice(hw.indexOf("-i")));
  });

  it("decodificação por hardware que falha refaz o proxy visual em software", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-visual-hw-"));
    await writeFile(join(dir, "transcript.json"), "{}", "utf8");
    const proxyCalls: ExecCall[] = [];
    const exec: Executor = {
      async run(call: ExecCall) {
        if (call.command === "ffmpeg" && call.args.some((a) => a.startsWith("fps=4"))) {
          proxyCalls.push(call);
          if (call.args.includes("-hwaccel")) return { code: 1, stdout: "", stderr: "vt indisponível" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const result = await runIngest({ id: "j1", videoPath: "/vid/aula.mp4", workDir: dir }, exec, () => {},
      undefined, undefined, undefined, undefined, { hwDecode: true });
    expect(proxyCalls.map((c) => c.args.includes("-hwaccel"))).toEqual([true, false]);
    expect(result.warning).toBeUndefined();
  });

  it("sem hwDecode o proxy visual não pede hardware", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-visual-sw-"));
    await writeFile(join(dir, "transcript.json"), "{}", "utf8");
    const exec = new FakeExecutor();
    await runIngest({ id: "j1", videoPath: "/vid/aula.mp4", workDir: dir }, exec, () => {},
      undefined, undefined, undefined, undefined, { hwDecode: false });
    const proxy = exec.calls.find((c) => c.command === "ffmpeg" && c.args.some((a) => a.startsWith("fps=4")));
    expect(proxy!.args).not.toContain("-hwaccel");
  });

  it("grava visual_index.json quando o sidecar devolve JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-visual-"));
    await writeFile(join(dir, "transcript.json"), "{}", "utf8");
    const payload = JSON.stringify({ video: "x", fps: 4, units: [] });
    const exec = new FakeExecutor({ stdout: payload });
    const result = await runIngest({ id: "j1", videoPath: "/vid/aula.mp4", workDir: dir }, exec, () => {});
    expect(result.warning).toBeUndefined();
    expect(await readFile(join(dir, "out", "visual_index.json"), "utf8")).toBe(payload);
  });

  it("não falha o job se o sidecar de visão recusar", async () => {
    const exec: Executor = {
      async run(call: ExecCall) {
        if (call.args.includes("visual_index.py") || call.args.includes("fps=4,scale='min(540,iw)':'min(960,ih)':force_original_aspect_ratio=decrease")) {
          return { code: 1, stdout: "", stderr: "MediaPipe não está instalado" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const stages: string[] = [];
    const result = await runIngest(job, exec, (s) => stages.push(s));
    expect(stages).toEqual(["transcribing", "indexing", "visual"]);
    expect(result.warning).toMatch(/visão/);
  });

  it("repassa as linhas do motor para quem quiser mostrar progresso", async () => {
    const exec = new FakeExecutor();
    exec.lines = ["Detectando idioma…", "97%|=====> | 58/60"];
    const linhas: string[] = [];
    await runIngest(job, exec, () => {}, (line) => linhas.push(line));
    expect(linhas).toContain("97%|=====> | 58/60");
  });

  it("emite queued/started/finished por estágio e um finished mesmo quando a transcrição falha", async () => {
    const sink = collectSink();
    const tracer = createTracer(sink);
    await runIngest(job, new FakeExecutor(), () => {}, undefined, tracer);
    const stages = [...new Set(sink.events.map((e) => e.stage))];
    expect(stages).toEqual(["transcribing", "indexing", "visual"]);
    for (const stage of stages) {
      const phases = sink.events.filter((e) => e.stage === stage).map((e) => e.phase);
      expect(phases).toEqual(["queued", "started", "finished"]);
      expect(sink.events.filter((e) => e.stage === stage && e.phase === "finished")).toHaveLength(1);
    }
    const blob = JSON.stringify(sink.events);
    expect(blob).not.toMatch(/aula\.mp4/);
    expect(blob).not.toMatch(/\/vid\//);

    const failSink = collectSink();
    await expect(runIngest(
      job,
      new FakeExecutor({ code: 2, stdout: "[ERROR] transcript inválido" }),
      () => {},
      undefined,
      createTracer(failSink),
    )).rejects.toThrow(/transcript inválido/);
    const transcribe = failSink.events.filter((e) => e.stage === "transcribing");
    expect(transcribe.map((e) => e.phase)).toEqual(["queued", "started", "finished"]);
    expect(transcribe.at(-1)!.category).toBe("error");
    expect(failSink.events.some((e) => e.stage === "indexing")).toBe(false);
  });

  it("dois arquivos no serviço residente compartilham o worker e não spawnam transcribe.py", async () => {
    const dirA = await mkdtemp(join(tmpdir(), "decupa-ingest-a-"));
    const dirB = await mkdtemp(join(tmpdir(), "decupa-ingest-b-"));
    // Arquivos de verdade: a chave da tarefa sai do stat do conteúdo.
    const camA = join(dirA, "cam-a.mp4");
    const camB = join(dirB, "cam-b.mp4");
    await writeFile(camA, "A");
    await writeFile(camB, "BB");
    const workerCalls: string[] = [];
    const speech = {
      worker: async (req: { taskId: string; language: string }) => {
        workerCalls.push(req.taskId);
        return {
          language: req.language,
          words: [{ text: "oi", startMs: 0, endMs: 80, confidence: 1, sentenceIndex: 0 }],
          unaligned: [],
        };
      },
      extract: async () => {},
      detectSilence: async () => [],
    };
    const exec = new FakeExecutor();
    await Promise.all([
      runIngest({ id: "a", videoPath: camA, workDir: dirA }, exec, () => {}, undefined, createTracer(), speech),
      runIngest({ id: "b", videoPath: camB, workDir: dirB }, exec, () => {}, undefined, createTracer(), speech),
    ]);
    expect(workerCalls.sort()).toEqual([
      transcriptTaskId(camA, await stat(camA)),
      transcriptTaskId(camB, await stat(camB)),
    ].sort());
    expect(exec.calls.some((c) => c.args.includes("condense-prep"))).toBe(false);
    expect(exec.calls.some((c) => c.args.includes("transcribe.py"))).toBe(false);
    expect(JSON.parse(await readFile(join(dirA, "transcript.json"), "utf8")).segments[0].words[0].text).toBe("oi");
    expect(JSON.parse(await readFile(join(dirB, "transcript.json"), "utf8")).segments[0].words[0].text).toBe("oi");
  });

  it("manda --no-visual-survey na chamada spawnada de index", async () => {
    // Survey do motor (cena, contact sheet, movimento) não é o sidecar
    // visual_index.py. Limpeza e montagem chegam aqui pelo mesmo runIngest.
    const exec = new FakeExecutor();
    await runIngest(job, exec, () => {});
    const indexes = exec.calls.filter((c) =>
      c.command === "python3"
      && c.args[1] === "index"
      && c.args[0]?.endsWith(join("scripts", "condense.py")),
    );
    expect(indexes).toHaveLength(1);
    const index = indexes[0]!;
    expect(isAbsolute(index.args[0]!)).toBe(true);
    expect(index.args.slice(1)).toEqual([
      "index",
      job.videoPath,
      join(job.workDir, "transcript.json"),
      "--no-visual-survey",
    ]);
  });
});

describe("runPlan", () => {
  it("sempre manda --drop-fillers hard, que é o default da skill", async () => {
    const exec = new FakeExecutor();
    await runPlan(job, "u001-u003 u005", exec);
    const call = exec.calls.at(-1)!;
    expect(call.args).toContain("--drop-fillers");
    expect(call.args).toContain("hard");
  });

  it("passa o keep-list como itens separados, não como uma string só", async () => {
    // `--keep u001-u003 u005` são dois argumentos para o argparse do motor.
    const exec = new FakeExecutor();
    await runPlan(job, "u001-u003 u005", exec);
    const { args } = exec.calls.at(-1)!;
    expect(args.slice(args.indexOf("--keep") + 1, args.indexOf("--keep") + 3))
      .toEqual(["u001-u003", "u005"]);
  });

  it("recusa keep-list vazio antes de chamar o motor", async () => {
    const exec = new FakeExecutor();
    await expect(runPlan(job, "   ", exec)).rejects.toThrow(/keep/);
    expect(exec.calls).toHaveLength(0);
  });

  it("chama o motor por caminho absoluto, não relativo ao cwd", async () => {
    // O SKILL manda rodar de dentro de work/<trabalho> com CLAUDE_PROJECT_DIR
    // apontando pra lá. Caminho relativo transforma isso num ENOENT de Python
    // que não descreve o que a pessoa fez de errado.
    const exec = new FakeExecutor();
    await runPlan(job, "u001-u003", exec);
    const script = exec.calls.at(-1)!.args[0]!;
    expect(isAbsolute(script)).toBe(true);
    expect(script.endsWith(join("scripts", "condense.py"))).toBe(true);
  });

  it("emite um único finished em sucesso e em keep-list inválido não chama o motor", async () => {
    const sink = collectSink();
    await runPlan(job, "u001-u003", new FakeExecutor(), createTracer(sink));
    expect(sink.events.map((e) => e.phase)).toEqual(["queued", "started", "finished"]);
    expect(sink.events.filter((e) => e.phase === "finished")).toHaveLength(1);
    expect(sink.events[2]!.category).toBe("ok");
    expect(JSON.stringify(sink.events)).not.toMatch(/aula\.mp4/);
  });
});

describe("makeTriageProxy", () => {
  it("gera o proxy a 1 fps e resolução reduzida", async () => {
    // Mandar o original quebra: 11,2 MB viram 14,9 MB em base64 e voltam como
    // erro genérico do provedor.
    const exec = new FakeExecutor();
    const out = await makeTriageProxy(job, exec);
    const { command, args } = exec.calls.at(-1)!;
    expect(command).toBe("ffmpeg");
    expect(args.join(" ")).toContain("fps=1,scale='min(270,iw)':'min(480,ih)':force_original_aspect_ratio=decrease");
    expect(out).toContain("triage-proxy.mp4");
  });

  it("não regera o proxy se ele já existe", async () => {
    const exec = new FakeExecutor();
    await makeTriageProxy(job, exec, { exists: async () => true });
    expect(exec.calls).toHaveLength(0);
  });
});

describe("runTriage", () => {
  it("chama a biblioteca com o proxy leve e devolve o keep-list tipado", async () => {
    const seen: unknown[] = [];
    const keep = await runTriage(job, new FakeExecutor(), undefined, async (opts) => {
      seen.push(opts);
      return { keepList: "u001-u003" };
    });
    expect(keep).toBe("u001-u003");
    expect(seen[0]).toMatchObject({
      videoPath: join(job.workDir, "triage-proxy.mp4"),
      outDir: join(job.workDir, "out"),
    });
    expect(seen[0]).not.toHaveProperty("provider");
  });

  it("passa o provider escolhido para a biblioteca", async () => {
    const seen: unknown[] = [];
    await runTriage(job, new FakeExecutor(), "zai", async (opts) => {
      seen.push(opts);
      return { keepList: "u001" };
    });
    expect(seen[0]).toMatchObject({ provider: "zai" });
  });

  it("encaminha o signal do job para o inspect da biblioteca", async () => {
    const ac = new AbortController();
    const seen: { signal?: AbortSignal }[] = [];
    await runTriage(
      { ...job, signal: ac.signal },
      new FakeExecutor(),
      undefined,
      async (opts) => {
        seen.push(opts);
        return { keepList: "u001" };
      },
    );
    expect(seen[0]?.signal).toBe(ac.signal);
  });
});

/** Saída JSON do ffprobe com as duas taxas que o probeFps pede. */
const rates = (r: string, avg = r) => JSON.stringify({ streams: [{ r_frame_rate: r, avg_frame_rate: avg }] });

describe("probeFps", () => {
  it("lê o frame rate como fração", async () => {
    expect(await probeFps(job, new FakeExecutor({ stdout: rates("30/1") }))).toBe(30);
  });

  it("recusa fracionário com instrução do que fazer", async () => {
    // 29,97 vira deriva crescente no timecode; ninguém percebe até o fim.
    const exec = new FakeExecutor({ stdout: rates("30000/1001") });
    await expect(probeFps(job, exec)).rejects.toThrow(/29\.97/);
  });

  it("estoura quando o ffprobe falha, em vez de assumir 30", async () => {
    await expect(probeFps(job, new FakeExecutor({ code: 1 }))).rejects.toThrow(/ffprobe/);
  });
});

describe("SpawnExecutor", () => {
  it("resolve com code !== 0 quando o binário não existe, em vez de rejeitar", async () => {
    const exec = new SpawnExecutor();
    const result = await exec.run({ command: "definitely-not-a-binary-xyz", args: [] });
    expect(result.code).not.toBe(0);
  });

  it("emite linhas de stdout/stderr para onLine", async () => {
    const exec = new SpawnExecutor();
    const lines: string[] = [];
    await exec.run({
      command: process.execPath,
      args: ["-e", "console.log('linha1'); console.error('linha2');"],
      onLine: (l) => lines.push(l),
    });
    expect(lines).toContain("linha1");
    expect(lines).toContain("linha2");
  });

  it("descarrega resto sem quebra de linha ao fechar o processo", async () => {
    const exec = new SpawnExecutor();
    const lines: string[] = [];
    await exec.run({
      command: process.execPath,
      args: ["-e", "process.stdout.write('último pedaço');"],
      onLine: (l) => lines.push(l),
    });
    expect(lines).toContain("último pedaço");
  });

  it("abort mata só o subprocesso daquela chamada", async () => {
    const exec = new SpawnExecutor();
    const own = new AbortController();
    const other = new AbortController();
    const hang = "console.log('ready'); setInterval(() => {}, 1000)";
    let ownReady = false;
    let otherReady = false;
    const ownRun = exec.run({
      command: process.execPath,
      args: ["-e", hang],
      signal: own.signal,
      onLine: (line) => { if (line === "ready") ownReady = true; },
    });
    const otherRun = exec.run({
      command: process.execPath,
      args: ["-e", hang],
      signal: other.signal,
      onLine: (line) => { if (line === "ready") otherReady = true; },
    });
    for (let i = 0; i < 50 && (!ownReady || !otherReady); i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(ownReady && otherReady).toBe(true);
    own.abort();
    expect((await ownRun).code).not.toBe(0);
    await new Promise((r) => setTimeout(r, 80));
    expect(otherReady).toBe(true);
    other.abort();
    expect((await otherRun).code).not.toBe(0);
  }, 5000);
});

describe("preflight", () => {
  it("diz que o sidecar de fala está fora do ar quando uv falta", async () => {
    const exec: Executor = {
      async run(call: ExecCall) {
        if (call.command === "uv") return { code: 1, stdout: "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    await expect(preflight(realJob, exec)).rejects.toThrow(/sidecar de fala/);
    await expect(preflight(realJob, exec)).rejects.toThrow(/services\/speech\/README\.md/);
  });

  it("para quando o motor está sem o patch de pontuação PT-BR", async () => {
    // Um clone novo do motor passa no teste de existência: o que degrada o
    // corte é o conteúdo, não a ausência. Sem esta checagem a suíte fica verde
    // — o gold lê índice congelado — enquanto a produção volta a marcar quase
    // toda unidade como frase inacabada.
    const engine = await writeFakeEngine("。．！？!?…");
    const previous = process.env.VE_PLUGIN_ROOT;
    process.env.VE_PLUGIN_ROOT = engine;
    try {
      await expect(preflight(realJob, okExec)).rejects.toThrow(/sem o patch de pontuação/);
    } finally {
      if (previous === undefined) delete process.env.VE_PLUGIN_ROOT;
      else process.env.VE_PLUGIN_ROOT = previous;
    }
  });

  it("segue quando o motor tem o ponto ASCII", async () => {
    const engine = await writeFakeEngine("。．！？!?….");
    const previous = process.env.VE_PLUGIN_ROOT;
    process.env.VE_PLUGIN_ROOT = engine;
    try {
      await expect(preflight(realJob, okExec)).resolves.toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.VE_PLUGIN_ROOT;
      else process.env.VE_PLUGIN_ROOT = previous;
    }
  });

  it("o default do motor é absoluto e ancorado na raiz do repo", () => {
    expect(isAbsolute(DEFAULT_ENGINE)).toBe(true);
    expect(DEFAULT_ENGINE.endsWith(join("work", "video-agent-kit-plugin"))).toBe(true);
  });
});

describe("enginePatchError", () => {
  it("aceita o motor patchado e recusa o de upstream", async () => {
    expect(await enginePatchError(await writeFakeEngine("。．！？!?…."))).toBeNull();
    expect(await enginePatchError(await writeFakeEngine("。．！？!?…")))
      .toMatch(/sem o patch de pontuação/);
  });

  it("avisa quando não dá para ler o arquivo, em vez de deixar passar", async () => {
    // Não conseguir conferir não é o mesmo que estar bom: em caso de dúvida o
    // preflight para, porque a falha alternativa é silenciosa.
    expect(await enginePatchError(join(tmpdir(), "motor-que-nao-existe")))
      .toMatch(/não consegui ler/);
  });

  it("avisa quando o símbolo sumiu — motor em versão inesperada", async () => {
    const engine = await mkdtemp(join(tmpdir(), "motor-"));
    await mkdir(join(engine, "mcp", "ve_tools"), { recursive: true });
    await writeFile(join(engine, "mcp", "ve_tools", "condense_lang.py"), "# vazio\n", "utf8");
    expect(await enginePatchError(engine)).toMatch(/não achei `_TERMINAL_PUNCT`/);
  });

  it("recusa motor com o ponto mas sem o léxico PT-BR", async () => {
    // O patch são 110 linhas, não uma. Conferir só `_TERMINAL_PUNCT` deixa
    // passar um clone onde alguém restaurou a pontuação e perdeu o resto: o
    // motor volta a decidir por léxico inglês, "né"/"tipo"/"tá" deixam de ser
    // soft filler, e o passe mecânico fica sem o sinal que ele consome.
    const engine = await writeFakeEngine("。．！？!?….", { lexicon: false });
    expect(await enginePatchError(engine)).toMatch(/léxico PT-BR/);
  });
});

describe("probeFps orienta para OTIO (ICE3-04)", () => {
  it("fracionário não-EDL sugere OTIO", async () => {
    // 24000/1001 ≈ 23,98: o EDL não gera, mas o OTIO aceita qualquer taxa
    // racional — o erro precisa nomear essa saída.
    const exec = new FakeExecutor({ stdout: rates("24000/1001") });
    await expect(probeFps(job, exec)).rejects.toThrow(/otio/i);
  });

  it("29.97 com allowDropFrame continua passando", async () => {
    const exec = new FakeExecutor({ stdout: rates("30000/1001") });
    await expect(probeFps(job, exec, { allowDropFrame: true })).resolves.toBeCloseTo(29.97, 2);
  });
});

describe("ensureAudioProxy", () => {
  const run = promisify(execFile);
  const probeJson = async (path: string) => JSON.parse((await run("ffprobe", [
    "-v", "error", "-show_entries", "stream=codec_type,start_time:format=duration", "-of", "json", path,
  ])).stdout) as { streams: { codec_type: string; start_time: string }[]; format: { duration: string } };

  it("gera um m4a só de áudio, começando no zero da fonte, e reaproveita o existente", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-audio-"));
    const job = { id: "j1", videoPath: join(FIXTURES, "clip.mp4"), workDir: dir };
    expect(await ensureAudioProxy(job, new SpawnExecutor())).toBe(true);
    const info = await probeJson(audioProxyPath(job));
    expect(info.streams.map((s) => s.codec_type)).toEqual(["audio"]);
    expect(Number(info.streams[0]!.start_time)).toBe(0);
    expect(Math.abs(Number(info.format.duration) - 3)).toBeLessThan(0.1);

    const calls: ExecCall[] = [];
    const counting: Executor = { async run(call) { calls.push(call); return { code: 0, stdout: "", stderr: "" }; } };
    expect(await ensureAudioProxy(job, counting)).toBe(true);
    expect(calls).toHaveLength(0);
  }, 60_000);

  it("fonte sem áudio devolve false e não deixa arquivo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-audio-mute-"));
    const video = join(dir, "mudo.mp4");
    await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=25:duration=1",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", video]);
    const job = { id: "j1", videoPath: video, workDir: dir };
    expect(await ensureAudioProxy(job, new SpawnExecutor())).toBe(false);
    await expect(readFile(audioProxyPath(job))).rejects.toThrow();
    const leftovers = (await readdir(dir)).filter((n) => n.startsWith("playback"));
    expect(leftovers).toEqual([]);
  }, 60_000);
});

const palavra = { text: "oi", startMs: 0, endMs: 80, confidence: 1, sentenceIndex: 0 };

/** Worker de mentira: o ingest não pode depender de WhisperX nestes casos. */
function fala(worker: (req: { taskId: string; onProgress?: (line: string) => void }) => Promise<{
  language: string;
  words: (typeof palavra)[];
  unaligned: string[];
}>) {
  return {
    worker,
    extract: async () => {},
    detectSilence: async () => [],
    coordinator: undefined as ReturnType<typeof createFileCoordinator> | undefined,
  };
}

/** ffmpeg que deixa um arquivo no último argumento e sai com erro. */
function ffmpegMorto(): { exec: Executor; vezes: () => number } {
  let vezes = 0;
  const exec: Executor = {
    async run(call) {
      if (call.command === "ffmpeg") {
        vezes += 1;
        const destino = call.args.at(-1);
        if (destino) await writeFile(destino, "parcial");
        return { code: 1, stdout: "", stderr: "encode interrompido" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  return { exec, vezes: () => vezes };
}

describe("derivados atômicos", () => {
  it("proxy visual que falha no meio não fica no destino e a próxima ingestão gera de novo", async () => {
    // O ffmpeg antigo escrevia direto em visual-proxy.mp4: o pedaço era reusado.
    const dir = await mkdtemp(join(tmpdir(), "decupa-proxy-visual-"));
    const { exec, vezes } = ffmpegMorto();
    const alvo = { id: "j1", videoPath: "/vid/aula.mp4", workDir: dir };
    const primeira = await runIngest(alvo, exec, () => {}, undefined, undefined, undefined, undefined, { hwDecode: false });
    expect(primeira.warning).toMatch(/visão/);
    await expect(access(join(dir, "visual-proxy.mp4"))).rejects.toThrow();
    await runIngest(alvo, exec, () => {}, undefined, undefined, undefined, undefined, { hwDecode: false });
    expect(vezes()).toBe(2);
    expect((await readdir(dir)).filter((nome) => nome.includes("partial"))).toEqual([]);
  });

  it("proxy de triagem que falha no meio não é reusado na tentativa seguinte", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-proxy-triagem-"));
    const { exec, vezes } = ffmpegMorto();
    const alvo = { ...job, workDir: dir };
    await expect(makeTriageProxy(alvo, exec)).rejects.toThrow(/proxy de triagem/);
    await expect(makeTriageProxy(alvo, exec)).rejects.toThrow(/proxy de triagem/);
    expect(vezes()).toBe(2);
    await expect(access(join(dir, "triage-proxy.mp4"))).rejects.toThrow();
    expect((await readdir(dir)).filter((nome) => nome.includes("partial"))).toEqual([]);
  });
});

describe("cancelamento do ingest", () => {
  it("signal abortado depois da transcrição não chama o índice nem o visual", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-abort-fala-"));
    const video = join(dir, "aula.mp4");
    await writeFile(video, "video");
    const ac = new AbortController();
    const exec = new FakeExecutor();
    let erro: unknown = "seguiu";
    try {
      await runIngest(
        { id: "j1", videoPath: video, workDir: dir },
        exec,
        () => {},
        undefined,
        undefined,
        fala(async () => {
          ac.abort();
          return { language: "pt", words: [palavra], unaligned: [] };
        }),
        ac.signal,
      );
    } catch (error) {
      erro = error;
    }
    const seguiu = exec.calls.filter((call) => call.command === "ffmpeg" || call.args[1] === "index");
    expect(seguiu).toEqual([]);
    expect(erro).toBeInstanceOf(CancelledError);
  });

  it("ffmpeg abortado com hwDecode não é relançado em software", async () => {
    // Relançar em software desfazia o cancelar e seguia por minutos.
    const dir = await mkdtemp(join(tmpdir(), "decupa-abort-hw-"));
    await writeFile(join(dir, "transcript.json"), JSON.stringify({
      segments: [{ text: "oi", words: [{ text: "oi", start: 0, end: 1 }] }],
    }), "utf8");
    const ac = new AbortController();
    let ffmpeg = 0;
    const exec: Executor = {
      async run(call) {
        if (call.command === "ffmpeg") {
          ffmpeg += 1;
          ac.abort();
          return { code: 1, stdout: "", stderr: "killed" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    let erro: unknown = "seguiu";
    try {
      await runIngest(
        { id: "j1", videoPath: "/vid/aula.mp4", workDir: dir, signal: ac.signal },
        exec,
        () => {},
        undefined,
        undefined,
        undefined,
        undefined,
        { hwDecode: true },
      );
    } catch (error) {
      erro = error;
    }
    expect(ffmpeg).toBe(1);
    // O span "visual" reembrulha o erro: o que sai tem o nome de cancelamento,
    // e a causa é o CancelledError de @decupa/queue.
    expect(erro).toMatchObject({ name: "CancelledError" });
    expect((erro as { cause?: unknown }).cause).toBeInstanceOf(CancelledError);
  });

  it("todo exec.run do ingest, do plano, do proxy, do fps e do render recebe o signal", async () => {
    const ac = new AbortController();
    const dir = await mkdtemp(join(tmpdir(), "decupa-signal-"));
    const comSignal = { ...job, workDir: dir, signal: ac.signal };
    const ingest = new FakeExecutor();
    // O sinal entra uma vez só. Passar o mesmo nos dois lugares faz o
    // pipeline compor um AbortSignal.any, que não é o signal original.
    await runIngest(
      { ...job, workDir: dir },
      ingest,
      () => {},
      undefined,
      undefined,
      undefined,
      ac.signal,
      { hwDecode: false },
    );
    expect(ingest.calls.length).toBeGreaterThan(0);
    for (const call of ingest.calls) expect(call.signal).toBe(ac.signal);

    const plano = new FakeExecutor();
    await runPlan(comSignal, "u001", plano);
    expect(plano.calls[0]?.signal).toBe(ac.signal);

    const proxy = new FakeExecutor();
    await makeTriageProxy(comSignal, proxy);
    expect(proxy.calls[0]?.signal).toBe(ac.signal);

    const fpsCalls: ExecCall[] = [];
    const fps: Executor = {
      async run(call) {
        fpsCalls.push(call);
        const json = call.args.includes("json") || call.args.some((arg) => arg.includes("avg_frame_rate"));
        return { code: 0, stdout: json ? rates("30/1") : "30/1\n", stderr: "" };
      },
    };
    expect(await probeFps(comSignal, fps)).toBe(30);
    expect(fpsCalls[0]?.signal).toBe(ac.signal);

    const render = new FakeExecutor();
    await runRender(comSignal, join(dir, "corte.mp4"), render);
    expect(render.calls[0]?.signal).toBe(ac.signal);
  });

  it("repassa o progresso do worker residente para onLine", async () => {
    // onLine é o que o servidor manda para setProgress.
    const dir = await mkdtemp(join(tmpdir(), "decupa-progresso-"));
    const video = join(dir, "aula.mp4");
    await writeFile(video, "video");
    const linhas: string[] = [];
    await runIngest(
      { id: "j1", videoPath: video, workDir: dir },
      new FakeExecutor(),
      () => {},
      (linha) => linhas.push(linha),
      undefined,
      fala(async (req) => {
        req.onProgress?.("transcrevendo 42%");
        return { language: "pt", words: [palavra], unaligned: [] };
      }),
      undefined,
      { visual: false },
    );
    expect(linhas).toContain("transcrevendo 42%");
  });
});

describe("transcrição vazia", () => {
  it("limpeza com fala vazia não grava cache e a próxima abertura transcreve de novo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-sem-fala-"));
    const video = join(dir, "aula.mp4");
    await writeFile(video, "video");
    const coordinator = createFileCoordinator(join(dir, "coord"), { limit: 1, pollMs: 5 });
    let chamadas = 0;
    const speech = fala(async () => {
      chamadas += 1;
      return { language: "pt", words: [], unaligned: [] };
    });
    speech.coordinator = coordinator;
    const rodar = () => runIngest(
      { id: "j1", videoPath: video, workDir: dir },
      new FakeExecutor(),
      () => {},
      undefined,
      undefined,
      speech,
      undefined,
      { requireSpeech: true, visual: false },
    );
    await expect(rodar()).rejects.toThrow(/não encontrou fala/);
    await expect(access(join(dir, "transcript.json"))).rejects.toThrow();
    await expect(rodar()).rejects.toThrow(/não encontrou fala/);
    expect(chamadas).toBe(2);
  });

  it("montagem aceita fonte sem fala e grava o índice vazio", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-sem-fala-montagem-"));
    const video = join(dir, "apoio.mp4");
    await writeFile(video, "video");
    let chamadas = 0;
    await runIngest(
      { id: "j1", videoPath: video, workDir: dir },
      new FakeExecutor(),
      () => {},
      undefined,
      undefined,
      fala(async () => {
        chamadas += 1;
        return { language: "pt", words: [], unaligned: [] };
      }),
      undefined,
      { visual: false },
    );
    expect(chamadas).toBe(1);
    const indice = JSON.parse(await readFile(join(dir, "out", "speech_index.json"), "utf8")) as { units: unknown[] };
    expect(indice.units).toEqual([]);
  });
});

describe("keep-list e frame rate", () => {
  it("recusa faixa que não é unidade antes de chamar o motor", async () => {
    // `--drop-fillers` no keep-list ia parar como argumento do condense.py.
    const exec = new FakeExecutor();
    await expect(runPlan(job, "--drop-fillers u001", exec)).rejects.toThrow(/faixa inválida/);
    expect(exec.calls).toHaveLength(0);
  });

  it("r_frame_rate absurdo cai para a taxa média", async () => {
    // Celular em VFR devolve 90000/1; o EDL não pode usar essa taxa.
    const exec = new FakeExecutor({ stdout: rates("90000/1", "30/1") });
    expect(await probeFps(job, exec)).toBe(30);
  });
});
