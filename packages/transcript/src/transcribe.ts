import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { extractAudio } from "@decupa/media";
import type { FileCoordinator } from "@decupa/coordinator";
import { toTokens } from "./tokens.ts";
import type { RawWord, Transcript } from "./types.ts";
import { runSpeechJob } from "./resident.ts";

const run = promisify(execFile);

/** packages/transcript/src -> ../../../services/speech */
const SPEECH_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../services/speech",
);

/**
 * Pastas de áudio temporário ainda em uso. O `finally` de quem cria cobre
 * sucesso e erro, mas o shutdown do CLI chama process.exit com a extração ou
 * o sidecar rodando e nunca chega lá: o `exit` apaga o que sobrou. Um WAV de
 * uma hora passa de 100 MB.
 */
const liveAudioDirs = new Set<string>();
let exitCleanup = false;

async function tempAudioDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  liveAudioDirs.add(dir);
  if (!exitCleanup) {
    exitCleanup = true;
    process.on("exit", () => {
      for (const live of liveAudioDirs) {
        // Saindo: exceção aqui trocaria o código de saída (EBUSY no Windows,
        // com um ffmpeg ainda segurando o WAV).
        try { rmSync(live, { recursive: true, force: true }); } catch { /* melhor esforço */ }
      }
    });
  }
  return dir;
}

async function removeAudioDir(dir: string): Promise<void> {
  liveAudioDirs.delete(dir);
  await rm(dir, { recursive: true, force: true });
}

interface SidecarOutput {
  language: string;
  words: RawWord[];
  unaligned?: unknown;
}

/**
 * A ponte com o sidecar é o único ponto onde stdout vira dado. Guardar aqui
 * é guardar uma vez para todos os chamadores.
 */
export function parseSidecarOutput(stdout: string): SidecarResult {
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
  const unaligned = Array.isArray(out.unaligned)
    ? out.unaligned.filter((entry): entry is string =>
      typeof entry === "string" && entry.trim().length > 0)
    : [];
  return { language: out.language, words: out.words as RawWord[], unaligned };
}

export interface SidecarResult {
  language: string;
  words: RawWord[];
  unaligned: string[];
}

export type SpeechWorkerRequest = {
  taskId: string;
  wav: string;
  language: string;
  model?: string;
  computeType?: string;
  signal?: AbortSignal;
  /** Progresso do WhisperX em texto curto ("transcrevendo 42%"). */
  onProgress?: (line: string) => void;
};

/** Padrões de `transcribe`, exportados para quem monta a chave da tarefa. */
export const DEFAULT_LANGUAGE = "pt";
export const DEFAULT_MODEL = "small";

export type TranscribeDeps = {
  extract?: (opts: { input: string; output: string }) => Promise<void>;
  coordinator?: FileCoordinator;
  runSidecar?: (args: string[]) => Promise<string>;
  worker?: (req: SpeechWorkerRequest) => Promise<SidecarResult>;
};

/**
 * Extrai o áudio para um WAV temporário e roda o sidecar Python.
 * Com `worker`, reutiliza o serviço residente sob o coordenador.
 * O WAV temporário é sempre removido, inclusive em erro.
 */
export async function transcribe(
  opts: {
    input: string;
    language?: string;
    model?: string;
    computeType?: string;
    signal?: AbortSignal;
    /** Progresso do worker residente, repassado a quem mostra andamento. */
    onProgress?: (line: string) => void;
    /** Chave da tarefa no coordenador. Padrão: o caminho. Um task "completed"
     *  com a mesma chave devolve a transcrição antiga, então quem troca o
     *  conteúdo no mesmo caminho precisa de uma chave que mude junto. */
    taskId?: string;
  },
  deps: TranscribeDeps = {},
): Promise<Transcript> {
  const language = opts.language ?? DEFAULT_LANGUAGE;
  const model = opts.model ?? DEFAULT_MODEL;
  const extract = deps.extract ?? extractAudio;
  const dir = await tempAudioDir("decupa-asr-");
  const wav = join(dir, "audio.wav");

  try {
    if (opts.signal?.aborted) throw new Error(`tarefa cancelada: ${opts.input}`);
    await extract({ input: opts.input, output: wav });
    const parsed = await runSpeechSidecar({
      taskId: opts.taskId ?? opts.input,
      wav,
      language,
      model,
      computeType: opts.computeType,
      signal: opts.signal,
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    }, deps);
    return { language: parsed.language, tokens: toTokens(parsed.words), unaligned: parsed.unaligned };
  } finally {
    await removeAudioDir(dir);
  }
}

async function runSpeechSidecar(
  req: SpeechWorkerRequest,
  deps: TranscribeDeps,
): Promise<SidecarResult> {
  if (deps.worker) {
    const build = () => deps.worker!(req);
    if (deps.coordinator) {
      return runSpeechJob(deps.coordinator, { id: req.taskId, signal: req.signal, build });
    }
    return build();
  }
  const stdout = await (deps.runSidecar ?? defaultRunSidecar)([
    "--wav", req.wav,
    "--language", req.language,
    "--model", req.model ?? "small",
    ...(req.computeType ? ["--compute-type", req.computeType] : []),
  ]);
  return parseSidecarOutput(stdout);
}

function normalizeForCoverage(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Confere que o alinhamento cobriu o texto pedido, em ordem e com tempos
 * válidos. Alinhamento forçado sozinho não prova que a fala existe: qualquer
 * divergência estoura nomeando o trecho sem vínculo, em vez de inventar tempo.
 */
export function validateAlignmentCoverage(
  text: string,
  words: RawWord[],
  unaligned: string[],
): void {
  const expected = text.split(/\s+/).map(normalizeForCoverage).filter(Boolean);
  if (expected.length === 0) throw new Error("texto vazio para alinhamento");
  const got = words.map((word) => normalizeForCoverage(word.text ?? ""));
  if (words.length === 0 || got.join("") !== expected.join("")) {
    const missing = unaligned.length > 0 ? `: sem vínculo (${unaligned.join(", ")})` : "";
    throw new Error(`texto sem correspondência no áudio${missing}`);
  }
  for (const [i, word] of words.entries()) {
    if (!Number.isFinite(word.startMs) || !Number.isFinite(word.endMs)
      || !(word.startMs < word.endMs)) {
      throw new Error(`palavra "${word.text}" com tempo inválido no alinhamento`);
    }
    if (i > 0 && words[i - 1]!.endMs > word.startMs) {
      throw new Error(`palavra "${word.text}" fora de ordem no alinhamento`);
    }
  }
}

export interface AlignTextDeps {
  extract: (opts: {
    input: string;
    output: string;
    startSeconds: number;
    durationSeconds: number;
  }) => Promise<void>;
  runSidecar: (args: string[]) => Promise<string>;
}

/**
 * O venv da fala bate com o uv.lock? `uv run --no-sync` não instala nada e,
 * sem o venv, cria um `.venv` vazio no repositório antes de falhar num
 * ModuleNotFoundError. `sync --check` compara sem criar nem alterar nada.
 * Sem cache de propósito: custa ~100 ms, e transcrever ou alinhar leva
 * segundos.
 */
async function assertSpeechEnvSynced(): Promise<void> {
  try {
    await run("uv", ["sync", "--locked", "--check", "--offline"], { cwd: SPEECH_DIR });
  } catch (error) {
    // `uv` fora do PATH é outro problema, e o erro original já o diz.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new Error(
      `o ambiente Python de fala está ausente ou incompleto em ${join(SPEECH_DIR, ".venv")}. ` +
      "Execute primeiro: node scripts/setup.mjs",
    );
  }
}

async function defaultRunSidecar(args: string[]): Promise<string> {
  await assertSpeechEnvSynced();
  const { stdout } = await run("uv", ["run", "--no-sync", "python", "transcribe.py", ...args], {
    cwd: SPEECH_DIR,
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout as string;
}

/**
 * Alinha um texto corrigido no trecho de áudio [startSeconds, endSeconds).
 * Pula a ASR e usa whisperx.align no recorte; a origem temporal é somada
 * exatamente uma vez. Falha quando o texto não tem correspondência no áudio.
 */
export async function alignText(
  opts: {
    input: string;
    text: string;
    startSeconds: number;
    endSeconds: number;
    language?: string;
  },
  deps: AlignTextDeps = { extract: extractAudio, runSidecar: defaultRunSidecar },
): Promise<Transcript> {
  const { input, text } = opts;
  const { startSeconds, endSeconds } = opts;
  const language = opts.language ?? "pt";
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error("texto vazio para alinhamento");
  }
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)
    || !(startSeconds >= 0 && startSeconds < endSeconds)) {
    throw new Error("intervalo inválido para alinhamento");
  }
  const dir = await tempAudioDir("decupa-align-");
  try {
    const wav = join(dir, "clip.wav");
    await deps.extract({
      input,
      output: wav,
      startSeconds,
      durationSeconds: endSeconds - startSeconds,
    });
    const textFile = join(dir, "texto.txt");
    await writeFile(textFile, text.trim(), "utf8");
    const stdout = await deps.runSidecar([
      "--wav", wav,
      "--language", language,
      "--text-file", textFile,
    ]);
    const parsed = parseSidecarOutput(stdout);
    validateAlignmentCoverage(text, parsed.words, parsed.unaligned);
    const shiftMs = Math.round(startSeconds * 1000);
    const shifted: RawWord[] = parsed.words.map((word) => ({
      text: word.text,
      startMs: Math.round(word.startMs) + shiftMs,
      endMs: Math.round(word.endMs) + shiftMs,
      confidence: word.confidence,
      sentenceIndex: 0,
    }));
    return { language: parsed.language, tokens: toTokens(shifted), unaligned: [] };
  } finally {
    await removeAudioDir(dir);
  }
}
