import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { hashFile } from "@decupa/media";

const run = promisify(execFile);

const exists = (path: string) => access(path).then(() => true, () => false);

/**
 * Gera (ou reaproveita) um proxy leve para o navegador tocar.
 *
 * Os brutos são HEVC 4K: o Chrome até decodifica, mas travar o scrub num
 * arquivo de 900 MB derrota o propósito da ferramenta. 720p H.264 com
 * `faststart` carrega na hora e busca sem engasgo, e a marcação é de tempo,
 * não de qualidade de imagem.
 *
 * A chave do cache é o hash do conteúdo — o mesmo arquivo nunca é convertido
 * duas vezes, e um arquivo diferente com o mesmo nome não reaproveita o proxy
 * errado.
 */
export async function ensureProxy(opts: {
  input: string;
  cacheDir: string;
}): Promise<string> {
  const hash = await hashFile(opts.input);
  const output = join(opts.cacheDir, `${hash}.mp4`);

  if (await exists(output)) return output;

  await mkdir(dirname(output), { recursive: true });
  await run("ffmpeg", [
    "-v", "error", "-y",
    "-i", opts.input,
    "-vf", "scale=w=720:h=720:force_original_aspect_ratio=decrease:force_divisible_by=2",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "28",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ac", "1",
    "-movflags", "+faststart",
    output,
  ], { maxBuffer: 32 * 1024 * 1024 });

  return output;
}
