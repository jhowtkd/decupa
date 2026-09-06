import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { FIXTURES } from "./fixtures/global-setup.ts";

const run = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE = process.env.VE_PLUGIN_ROOT ?? join(REPO_ROOT, "work", "video-agent-kit-plugin");
const temMotor = await access(join(ENGINE, "mcp", "ve_tools", "condense.py"))
  .then(() => true, () => false);

/**
 * Fala PT-BR sintética dentro dos 3 s do clip.mp4. Três propriedades de
 * propósito: ponto final (só é terminal com o patch), acento (é o que faz
 * `guess_language` devolver "pt"), e um "tá" solto (só é soft filler no léxico
 * PT). O motor lê qualquer JSON com segments[].words[].{text,start,end}.
 */
const TRANSCRIPT = {
  segments: [
    {
      start: 0.1, end: 1.2,
      text: "Então a gente começa a gravação hoje.",
      words: [
        { text: "Então", start: 0.10, end: 0.35 },
        { text: "a", start: 0.36, end: 0.42 },
        { text: "gente", start: 0.43, end: 0.62 },
        { text: "começa", start: 0.63, end: 0.88 },
        { text: "a", start: 0.89, end: 0.94 },
        { text: "gravação", start: 0.95, end: 1.12 },
        { text: "hoje.", start: 1.13, end: 1.20 },
      ],
    },
    {
      start: 1.6, end: 2.9,
      text: "Tá, então é a informação que a gente precisa, né?",
      words: [
        { text: "Tá,", start: 1.60, end: 1.72 },
        { text: "então", start: 1.73, end: 1.92 },
        { text: "é", start: 1.93, end: 1.98 },
        { text: "a", start: 1.99, end: 2.04 },
        { text: "informação", start: 2.05, end: 2.35 },
        { text: "que", start: 2.36, end: 2.45 },
        { text: "a", start: 2.46, end: 2.51 },
        { text: "gente", start: 2.52, end: 2.68 },
        { text: "precisa,", start: 2.69, end: 2.82 },
        { text: "né?", start: 2.83, end: 2.90 },
      ],
    },
  ],
};

describe.skipIf(!temMotor)("motor de condense — gold do léxico PT-BR", () => {
  it("lê como pt, fecha a frase no ponto e enxerga o soft filler", async () => {
    // Sem o patch: language "en", has_terminal_punct false no ponto ASCII, e
    // disfluency.soft vazio. Os três voltam juntos, e nenhum deles aparece como
    // erro — só como corte pior. É por isso que este teste existe.
    const dir = await mkdtemp(join(tmpdir(), "decupa-motor-"));
    await writeFile(join(dir, "transcript.json"), JSON.stringify(TRANSCRIPT), "utf8");

    await run("python3", [
      join(REPO_ROOT, "scripts", "condense.py"), "index",
      join(FIXTURES, "clip.mp4"), join(dir, "transcript.json"),
    ], { env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });

    const index = JSON.parse(
      await readFile(join(dir, "out", "speech_index.json"), "utf8"),
    ) as {
      language: string;
      units: { text: string; has_terminal_punct: boolean; disfluency: { soft: { phrase: string }[] } }[];
    };

    expect(index.language).toBe("pt");
    expect(index.units[0]!.has_terminal_punct).toBe(true);
    const soft = index.units.flatMap((u) => u.disfluency.soft.map((s) => s.phrase));
    expect(soft.length).toBeGreaterThan(0);
  }, 120_000);
});
