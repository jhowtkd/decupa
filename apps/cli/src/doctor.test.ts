import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderDoctor, runDoctor } from "./doctor.ts";

/** Executor falso: binário conhecido existe (código 0), o resto não. */
const fakeRun = async (command: string, _args: string[]): Promise<{ code: number }> =>
  ({ code: ["ffmpeg", "ffprobe", "uv"].includes(command) ? 0 : 1 });

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
    expect(ffmpeg.fix).toMatch(/brew install ffmpeg/);
  });

  it("sem ZAI_API_KEY, nomeia a variável", async () => {
    const lines = await runDoctor({ run: fakeRun, env: {} });
    const chave = lines.find((l) => l.name === "ZAI_API_KEY")!;
    expect(chave.ok).toBe(false);
    expect(chave.fix).toMatch(/ZAI_API_KEY/);
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
