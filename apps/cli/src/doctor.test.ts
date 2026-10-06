import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderDoctor, runDoctor } from "./doctor.ts";
import { writeCredentials } from "@decupa/triage";

/**
 * Executor falso: binário conhecido existe (código 0), o resto não.
 * Qualquer python responde: o doctor prova o Python do motor via
 * enginePython() e os sidecars pelo Python do venv de cada um, em caminho
 * absoluto — em teste real quem responde é o fakeRun.
 */
const fakeRun = async (command: string, _args: string[]): Promise<{ code: number }> =>
  ({ code: ["ffmpeg", "ffprobe", "uv"].includes(command) || /python(3)?(\.exe)?$/.test(command) ? 0 : 1 });

it("doctor informa origem do usuário e sobreposição visual sem exibir chaves", async () => {
  const home = await emptyHome(), projectDir = await emptyHome();
  await writeCredentials(home, { preset: "zai", apiKey: "user-text", openaiApiKey: "user-luna", visualProvider: "openai", typesafeApiKey: "user-jev", typesafe: true });
  await writeCredentials(projectDir, { preset: "gemini", apiKey: "project-text", openaiApiKey: "project-luna", visualProvider: "text" });
  const lines = await runDoctor({ run: fakeRun, home, projectDir, env: {} });
  expect(lines.find(l => l.name === "provedor de visão")?.detail).toContain("origem: usuário (tela)");
  expect(lines.find(l => l.name === "precedência da visão")?.detail).toContain("sobrepõe");
  expect(lines.find(l => l.name === "Jev")?.detail).toContain("usuário (tela)");
  expect(lines.find(l => l.name === "chave de análise")?.detail).toContain("gemini");
  expect(JSON.stringify(lines)).not.toMatch(/user-luna|user-jev|user-text|project-luna|project-text/);
  const explicit = await runDoctor({ run: fakeRun, home, projectDir, env: { DECUPA_VISUAL_PROVIDER: "text", DECUPA_TYPESAFE: "0" } });
  expect(explicit.find(l => l.name === "provedor de visão")?.detail).toContain("origem: ambiente");
  expect(explicit.find(l => l.name === "Jev")?.detail).toContain("desligado");
});

/** HOME sem credencial: o doctor lê ~/.decupa/credentials, e o da máquina
 *  de quem roda a suíte não pode decidir o resultado. */
const emptyHome = () => mkdtemp(join(tmpdir(), "doctor-home-"));

it("doctor mostra Jev desligado com flag true, igual ao estado da tela e ao cliente", async () => {
  const home = await emptyHome(), projectDir = await emptyHome();
  await writeCredentials(home, { preset: "zai", apiKey: "text", typesafe: true, typesafeApiKey: "stored-key" });
  const lines = await runDoctor({ run: fakeRun, home, projectDir, env: { DECUPA_TYPESAFE: "true" } });
  expect(lines.find(l => l.name === "Jev")?.detail).toContain("desligado");
  expect(lines.find(l => l.name === "Jev")?.detail).toContain("ative o Jev");
});

it("doctor mostra texto e Luna efetivos, sem enviar requisições", async () => {
  const lines = await runDoctor({ run: fakeRun, home: await emptyHome(), env: {
    DECUPA_API_KEY: "meta-fake", DECUPA_MODEL: "muse-spark-1.3-contributor", DECUPA_BASE_URL: "https://api.meta.ai/v1/chat/completions",
    DECUPA_VISUAL_PROVIDER: "openai", OPENAI_API_KEY: "openai-fake",
  } });
  expect(lines.find(l => l.name === "provedor de texto")).toMatchObject({ ok: true, detail: expect.stringContaining("muse-spark") });
  expect(lines.find(l => l.name === "provedor de visão")).toMatchObject({ ok: true, detail: expect.stringContaining("gpt-6-luna") });
  expect(renderDoctor(lines)).not.toMatch(/meta-fake|openai-fake/);
  const missing = await runDoctor({ run: fakeRun, home: await emptyHome(), env: { ZAI_API_KEY: "text-fake", DECUPA_VISUAL_PROVIDER: "openai" } });
  expect(missing.find(l => l.name === "provedor de texto")?.ok).toBe(true);
  expect(missing.find(l => l.name === "provedor de visão")).toMatchObject({ ok: false, detail: expect.stringContaining("OPENAI_API_KEY") });
  expect(missing.find(l => l.name === "provedor de visão")?.detail).toContain("origem: ambiente");
  const empty = await runDoctor({ run: fakeRun, home: await emptyHome(), projectDir: await emptyHome(), env: {} });
  const fallback = empty.find(l => l.name === "provedor de visão")!;
  expect(fallback.ok).toBe(false);
  expect(fallback.detail).toContain("alternativa sem chave");
  expect(fallback.detail).toContain("A análise de imagem está usando o provedor de texto");
  expect(empty.find(l => l.name === "Jev")?.detail).toContain("sem chave");
});

/**
 * Motor mínimo num tmpdir: só o que o doctor abre — `condense.py` para a
 * checagem de existência e `condense_lang.py` com (ou sem) o patch PT-BR.
 * O clone do motor vive em `work/`, que não é versionado, então o teste não
 * pode depender de ele estar no checkout — injeta o caminho falso.
 */
async function writeFakeEngine(patched: boolean): Promise<string> {
  const engine = await mkdtemp(join(tmpdir(), "doctor-motor-"));
  const tools = join(engine, "mcp", "ve_tools");
  await mkdir(tools, { recursive: true });
  await writeFile(join(tools, "condense.py"), "# motor de mentira\n", "utf8");
  await writeFile(
    join(tools, "condense_lang.py"),
    patched
      ? '_TERMINAL_PUNCT = ".!?"\nFILLERS_SOFT_PT = ["tipo", "né"]\n'
      : '_TERMINAL_PUNCT = "!?"\n',
    "utf8",
  );
  return engine;
}

describe("runDoctor", () => {
  it("tudo presente dá linha verde inteira", async () => {
    const engine = await writeFakeEngine(true);
    const lines = await runDoctor({
      run: fakeRun,
      env: { ZAI_API_KEY: "k" },
      home: await emptyHome(),
      // engine injetado: o motor real fica em work/, fora do git — nem todo
      // checkout o tem, e o teste verde não pode depender disso
      engine,
    });
    expect(lines.every((l) => l.ok)).toBe(true);
  });

  it("binário ausente vira linha vermelha com conserto", async () => {
    const lines = await runDoctor({
      // O fakeRun de cima conhece o ffmpeg; aqui o cenário é outro — máquina
      // recém-clonada, nenhum binário no PATH.
      run: async () => ({ code: 1 }),
      env: {},
    });
    const ffmpeg = lines.find((l) => l.name === "ffmpeg")!;
    expect(ffmpeg.ok).toBe(false);
    // Pré-requisito aponta ao guia, não a um gerenciador de pacote de uma
    // plataforma só (brew não existe no Windows).
    expect(ffmpeg.fix).toMatch(/docs\/setup\/GUIA\.md/);
    expect(ffmpeg.fix).not.toMatch(/brew/);
  });

  it("sem nenhuma chave, lista as 4 variáveis", async () => {
    const lines = await runDoctor({ run: fakeRun, env: {}, home: await emptyHome() });
    const chave = lines.find((l) => l.name === "chave de análise")!;
    expect(chave.ok).toBe(false);
    expect(chave.fix).toMatch(/ZAI_API_KEY/);
    expect(chave.fix).toMatch(/GEMINI_API_KEY/);
    expect(chave.fix).toMatch(/MINIMAX_API_KEY/);
    expect(chave.fix).toMatch(/DECUPA_API_KEY/);
    expect(chave.fix).toMatch(/configure_provider/);
  });

  it("com GEMINI_API_KEY, chave de análise passa", async () => {
    const lines = await runDoctor({ run: fakeRun, env: { GEMINI_API_KEY: "k" }, home: await emptyHome() });
    const chave = lines.find((l) => l.name === "chave de análise")!;
    expect(chave.ok).toBe(true);
    expect(chave.detail).toMatch(/gemini/);
  });

  it("precedência segue o resolver", async () => {
    const lines = await runDoctor({
      run: fakeRun,
      env: { ZAI_API_KEY: "k", GEMINI_API_KEY: "k2" },
      home: await emptyHome(),
    });
    const chave = lines.find((l) => l.name === "chave de análise")!;
    expect(chave.ok).toBe(true);
    expect(chave.detail).toMatch(/zai/);
  });

  it("endpoint default vira nota sobre a armadilha 1113", async () => {
    const lines = await runDoctor({ run: fakeRun, env: { ZAI_API_KEY: "k" }, home: await emptyHome() });
    const endpoint = lines.find((l) => l.name === "ZAI_BASE_URL")!;
    expect(endpoint.ok).toBe(true);
    expect(endpoint.detail).toMatch(/coding/);
    expect(endpoint.detail).toMatch(/1113/);
  });

  it("motor sem o patch PT-BR vira linha vermelha apontando o setup", async () => {
    // Mesmo fake do teste verde, mas sem ponto ASCII nem léxico: é exatamente
    // o estado de um clone novo do motor, que o teste de existência não pega.
    const engine = await writeFakeEngine(false);
    const lines = await runDoctor({ run: fakeRun, env: {}, engine });
    const patch = lines.find((l) => l.name === "patch PT-BR do motor")!;
    expect(patch.ok).toBe(false);
    expect(patch.fix).toMatch(/setup-engine\.sh/);
  });

  it("doctor local dispensa provedor, mas executa imports", async () => {
    const calls: string[][] = [];
    const lines = await runDoctor({
      localOnly: true,
      env: {},
      run: async (command, args) => {
        calls.push([command, ...args]);
        return { code: 0 };
      },
    });
    expect(lines.some((line) => line.name === "chave de análise")).toBe(false);
    expect(lines.some((line) => line.name === "ZAI_BASE_URL")).toBe(false);
    expect(calls.some((args) => args.includes("import whisperx"))).toBe(true);
    expect(calls.some((args) => args.includes("import mediapipe"))).toBe(true);
    // O doctor não vira instalador: nenhum `uv run`, que criava .venv vazio;
    // o import roda no Python do venv, em caminho absoluto (sem depender do
    // cwd), e o Python do motor também é provado.
    expect(calls.some(([command, ...args]) => command === "uv" && args[0] === "run")).toBe(false);
    const whisperx = calls.find((args) => args.includes("import whisperx"))!;
    expect(isAbsolute(whisperx[0]!)).toBe(true);
    expect(whisperx[0]).toMatch(/[\\/]services[\\/]speech[\\/]\.venv[\\/]/);
    expect(calls.some((args) => args.includes("import sys; assert sys.version_info >= (3, 11)"))).toBe(true);
    expect(calls.some((args) => args.includes("import cv2, numpy, scenedetect"))).toBe(true);
  });

  it("import que retorna code 1 vira linha vermelha apontando o setup", async () => {
    const lines = await runDoctor({
      // Cenário: venvs incompletos — todo `python -c 'import ...'` falha,
      // o resto da máquina responde normal.
      run: async (command, args) =>
        args.some((a) => a.startsWith("import ")) ? { code: 1 } : fakeRun(command, args),
      env: {},
    });
    for (const name of ["pacote de fala", "pacote de visão"]) {
      const line = lines.find((l) => l.name === name)!;
      expect(line.ok).toBe(false);
      expect(line.detail).toBe("ambiente incompleto");
      expect(line.fix).toMatch(/execute node scripts\/setup\.mjs/);
    }
    const python = lines.find((l) => l.name === "Python do motor")!;
    expect(python.ok).toBe(false);
  });

  it("Python do motor com versão ok e imports falhando vira ERR", async () => {
    const lines = await runDoctor({
      home: await emptyHome(),
      env: {},
      run: async (_command, args) => ({ code: args.some((arg) => arg.includes("import cv2")) ? 1 : 0 }),
    });
    const python = lines.find((l) => l.name === "Python do motor")!;
    expect(python.ok, python.detail).toBe(false);
    expect(python.detail).toMatch(/cv2, numpy ou scenedetect/);
    expect(python.fix).toMatch(/setup\.mjs/);
  });

  it("credencial gemini no home conta sem chave no ambiente", async () => {
    const home = await emptyHome();
    await mkdir(join(home, ".decupa"), { recursive: true });
    await writeFile(join(home, ".decupa", "credentials"), JSON.stringify({ preset: "gemini", apiKey: "k" }));
    const lines = await runDoctor({ run: fakeRun, env: {}, home });
    const chave = lines.find((l) => l.name === "chave de análise")!;
    expect(chave.ok, chave.detail).toBe(true);
    expect(chave.detail).toBe("setada (provedor gemini, ~/.decupa/credentials)");
  });

  it("credencial com baseUrl e sem apiKey vira ERR", async () => {
    // A chave do ambiente não pode autenticar o host que o arquivo escolheu.
    const home = await emptyHome();
    await mkdir(join(home, ".decupa"), { recursive: true });
    await writeFile(
      join(home, ".decupa", "credentials"),
      JSON.stringify({ preset: "zai", baseUrl: "https://evil.example/v1" }),
    );
    const lines = await runDoctor({ run: fakeRun, env: { ZAI_API_KEY: "k" }, home });
    const chave = lines.find((l) => l.name === "chave de análise")!;
    expect(chave.ok, chave.detail).toBe(false);
    expect(chave.detail).toMatch(/apiKey/);
  });

  it("Node 22.11 reprova e 22.12 passa", async () => {
    const previous = Object.getOwnPropertyDescriptor(process.versions, "node");
    const setNode = (value: string) => {
      Object.defineProperty(process.versions, "node", { value, configurable: true, enumerable: true });
    };
    try {
      setNode("22.11.0");
      const old = await runDoctor({ run: fakeRun, env: { ZAI_API_KEY: "k" }, home: await emptyHome() });
      const bad = old.find((l) => l.name === "node")!;
      expect(bad.ok, bad.detail).toBe(false);
      expect(bad.fix).toMatch(/22\.12/);
      setNode("22.12.0");
      const next = await runDoctor({ run: fakeRun, env: { ZAI_API_KEY: "k" }, home: await emptyHome() });
      expect(next.find((l) => l.name === "node")!.ok).toBe(true);
    } finally {
      if (previous) Object.defineProperty(process.versions, "node", previous);
    }
  });
});

describe("renderDoctor", () => {
  it("marca OK/ERR e traz o conserto", () => {
    const out = renderDoctor([
      { ok: true, name: "node", detail: "22.9.0" },
      { ok: false, name: "ffmpeg", detail: "fora do PATH", fix: "brew install ffmpeg" },
    ]);
    expect(out).toContain("OK node — 22.9.0");
    expect(out).toContain("ERR ffmpeg — fora do PATH (brew install ffmpeg)");
  });
});
