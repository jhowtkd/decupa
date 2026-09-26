import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  exec: Executor,
  opts?: { signal?: AbortSignal },
): Promise<VisualFrame[]> {
  // Diretório efêmero por janela no tmpdir: o `finally` garante limpeza e o
  // caminho curto não estoura o limite de ~260 chars do Windows (o cache
  // `analysis/<sha>/<sha>/visual-v4-<sha>` já consome ~200).
  const tempDir = await mkdtemp(join(tmpdir(), "decupa-frames-"));
  try {
    const pattern = join(tempDir, "frame-%03d.jpg");
    // Busca precisa na entrada (`-ss` + `-accurate_seek` antes de `-i`): o
    // FFmpeg pula direto para o keyframe anterior à janela em vez de
    // decodificar o vídeo desde o início a cada janela. Os frames saem nos
    // mesmos segundos da busca na saída — o teste de alinhamento prova isso
    // em CFR, VFR, início não zero, GOP longo e rotação.
    const result = await exec.run({
      command: "ffmpeg",
      args: [
        "-n",
        // Até 2 threads de decodificação por janela (a fila roda 2 janelas):
        // sem teto, cada FFmpeg ocupa quase todos os núcleos e a carga do Mac
        // passava de 20 na preparação. Os JPEGs não mudam com o número de threads.
        "-threads", "2",
        "-ss", String(window.fetchStart), "-accurate_seek",
        "-i", source.path,
        "-t", String(window.end - window.fetchStart),
        "-vf", "fps=1,scale='min(480,iw)':'min(480,ih)':force_original_aspect_ratio=decrease",
        "-filter_threads", "1",
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

    // `return await`: sem o await, o `finally` abaixo apagaria o diretório
    // enquanto as leituras ainda estão em voo.
    return await Promise.all(names.map(async (name, index) => ({
      sourceSecond: window.fetchStart + index,
      dataUrl: "data:image/jpeg;base64," +
        (await readFile(join(tempDir, name))).toString("base64"),
    })));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
