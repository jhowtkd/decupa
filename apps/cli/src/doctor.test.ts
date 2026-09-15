import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderDoctor, runDoctor } from "./doctor.ts";

/**
 * Executor falso: binário conhecido existe (código 0), o resto não.
 * python/python3 entram na lista porque o doctor agora prova o Python do
 * motor via enginePython() — em teste real quem responde é o fakeRun.
 */
const fakeRun = async (command: string, _args: string[]): Promise<{ code: number }> =>
  ({ code: ["ffmpeg", "ffprobe", "uv", "python", "python3"].includes(command) ? 0 : 1 });

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
    const lines = await runDoctor({ run: fakeRun, env: {} });
    const chave = lines.find((l) => l.name === "chave de análise")!;
    expect(chave.ok).toBe(false);
    expect(chave.fix).toMatch(/ZAI_API_KEY/);
    expect(chave.fix).toMatch(/GEMINI_API_KEY/);
    expect(chave.fix).toMatch(/MINIMAX_API_KEY/);
    expect(chave.fix).toMatch(/DECUPA_API_KEY/);
    expect(chave.fix).toMatch(/configure_provider/);
  });

  it("com GEMINI_API_KEY, chave de análise passa", async () => {
    const lines = await runDoctor({ run: fakeRun, env: { GEMINI_API_KEY: "k" } });
    const chave = lines.find((l) => l.name === "chave de análise")!;
    expect(chave.ok).toBe(true);
    expect(chave.detail).toMatch(/gemini/);
  });

  it("precedência segue o resolver", async () => {
    const lines = await runDoctor({
      run: fakeRun,
      env: { ZAI_API_KEY: "k", GEMINI_API_KEY: "k2" },
    });
    const chave = lines.find((l) => l.name === "chave de análise")!;
    expect(chave.ok).toBe(true);
    expect(chave.detail).toMatch(/zai/);
  });

  it("endpoint default vira nota sobre a armadilha 1113", async () => {
    const lines = await runDoctor({ run: fakeRun, env: { ZAI_API_KEY: "k" } });
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
    // O doctor não vira instalador: --no-sync --offline, projeto em caminho
    // absoluto (sem depender do cwd) e o Python do motor também é provado.
    const whisperx = calls.find((args) => args.includes("import whisperx"))!;
    expect(whisperx.slice(0, 5)).toEqual(["uv", "run", "--no-sync", "--offline", "--project"]);
    expect(isAbsolute(whisperx[5]!)).toBe(true);
    expect(calls.some((args) => args.includes("import sys; assert sys.version_info >= (3, 11)"))).toBe(true);
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
