import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { extractAudio } from "@decupa/media";
import { toTokens } from "./tokens.ts";
import type { RawWord, Transcript } from "./types.ts";

const run = promisify(execFile);

/** packages/transcript/src -> ../../../services/speech */
const SPEECH_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../services/speech",
);

interface SidecarOutput {
  language: string;
  words: RawWord[];
}

/**
 * A ponte com o sidecar é o único ponto onde stdout vira dado. Guardar aqui
 * é guardar uma vez para todos os chamadores.
 */
export function parseSidecarOutput(stdout: string): SidecarOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`a saída do sidecar de fala não é JSON: ${stdout.slice(0, 200)}`);
  }
  const out = parsed as Partial<SidecarOutput>;
  if (typeof out.language !== "string" || !Array.isArray(out.words)) {
    throw new Error(
      "a saída do sidecar de fala não tem `language`/`words` — o stdout foi " +
        "poluído ou o services/speech/transcribe.py mudou de contrato",
    );
  }
  return out as SidecarOutput;
}

/**
 * Extrai o áudio para um WAV temporário e roda o sidecar Python.
 * O WAV temporário é sempre removido, inclusive em erro.
 */
export async function transcribe(opts: {
  input: string;
  language?: string;
  model?: string;
}): Promise<Transcript> {
  const language = opts.language ?? "pt";
  const model = opts.model ?? "small";
  const dir = await mkdtemp(join(tmpdir(), "decupa-asr-"));
  const wav = join(dir, "audio.wav");

  try {
    await extractAudio({ input: opts.input, output: wav });

    const { stdout } = await run("uv", [
      "run", "python", "transcribe.py",
      "--wav", wav,
      "--language", language,
      "--model", model,
    ], { cwd: SPEECH_DIR, maxBuffer: 256 * 1024 * 1024 });

    const parsed = parseSidecarOutput(stdout);
    return { language: parsed.language, tokens: toTokens(parsed.words) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
