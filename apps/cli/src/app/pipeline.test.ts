import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENGINE,
  enginePatchError,
  FakeExecutor,
  makeTriageProxy,
  preflight,
  probeFps,
  runIngest,
  runPlan,
  runTriage,
  SpawnExecutor,
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

  it("passa CLAUDE_PROJECT_DIR para o motor em toda chamada", async () => {
    // Sem diretório por job, dois vídeos no mesmo cwd se sobrescrevem.
    const exec = new FakeExecutor();
    await runIngest(job, exec, () => {});
    for (const call of exec.calls) {
      expect(call.env?.CLAUDE_PROJECT_DIR).toBe("/work/j1");
    }
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
});

describe("probeFps", () => {
  it("lê o frame rate como fração", async () => {
    expect(await probeFps(job, new FakeExecutor({ stdout: "30/1\n" }))).toBe(30);
  });

  it("recusa fracionário com instrução do que fazer", async () => {
    // 29,97 vira deriva crescente no timecode; ninguém percebe até o fim.
    const exec = new FakeExecutor({ stdout: "30000/1001\n" });
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
    const exec = new FakeExecutor({ stdout: "24000/1001\n" });
    await expect(probeFps(job, exec)).rejects.toThrow(/otio/i);
  });

  it("29.97 com allowDropFrame continua passando", async () => {
    const exec = new FakeExecutor({ stdout: "30000/1001\n" });
    await expect(probeFps(job, exec, { allowDropFrame: true })).resolves.toBeCloseTo(29.97, 2);
  });
});
