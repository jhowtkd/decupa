import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Executor } from "../pipeline.ts";
import type { Source } from "./types.ts";

/** Janela visual de 20s com 1s de contexto; `fetchStart` é o ponto buscado. */
export type VisualWindow = { start: number; end: number; fetchStart: number };

/** Frame JPEG com data URL e o segundo da fonte que ele representa. */
export type VisualFrame = {
  sourceSecond: number;
  dataUrl: string;
};

/**
 * Frames JPEG timestampados de uma janela da fonte, em vez de `video_url`:
 * o modelo visual recebe as imagens já etiquetadas pelo segundo da fonte.
 * Falha do FFmpeg e diretório vazio são erros — nunca análise vazia.
 */
export async function extractVisualFrames(
  source: Source,
  window: VisualWindow,
  cacheDir: string,
  exec: Executor,
  opts?: { signal?: AbortSignal },
): Promise<VisualFrame[]> {
  // Diretório efêmero por janela: o `finally` garante que o cache final fica limpo.
  const tempDir = await mkdtemp(join(cacheDir, "frames-"));
  try {
    const pattern = join(tempDir, "frame-%03d.jpg");
    // Ordem output-seek (`-i` antes de `-ss`): manter como está para os
    // timestamps dos frames continuarem alinhados ao contrato das janelas.
    const result = await exec.run({
      command: "ffmpeg",
      args: [
        "-n", "-i", source.path,
        "-ss", String(window.fetchStart),
        "-t", String(window.end - window.fetchStart),
        "-vf", "fps=1,scale='min(480,iw)':'min(480,ih)':force_original_aspect_ratio=decrease",
        "-an", "-q:v", "5", pattern,
      ],
      signal: opts?.signal,
    });
    if (result.code !== 0) {
      throw new Error(
        "extração de frames [" + window.fetchStart + ", " + window.end +
        ") falhou (código " + result.code + "): " +
        (result.stderr || result.stdout).trim().slice(0, 300),
      );
    }

    // FFmpeg pode emitir um frame extra na borda: descarta o que alcança
    // ou passa de `window.end` (janela semiaberta).
    const names = (await readdir(tempDir))
      .filter((name) => /^frame-\d+\.jpg$/.test(name))
      .sort()
      .filter((_, index) => window.fetchStart + index < window.end);
    if (names.length === 0) {
      throw new Error(
        "extração de frames [" + window.fetchStart + ", " + window.end +
        ") não produziu frames",
      );
    }

    return Promise.all(names.map(async (name, index) => ({
      sourceSecond: window.fetchStart + index,
      dataUrl: "data:image/jpeg;base64," +
        (await readFile(join(tempDir, name))).toString("base64"),
    })));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
