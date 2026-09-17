import { createHash } from "node:crypto";
import { access, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { inspectArtifact, publishAtomic } from "@decupa/cache";
import { CancelledError, createLimitedQueue, isCancelledError } from "@decupa/queue";
import { PROMPT_VERSION, ZAI_DEFAULT_MODEL, parseSpeechIndex } from "@decupa/triage";
import type { Executor } from "../pipeline.ts";
import { runIngest, transcriptPath } from "../pipeline.ts";
import type { Analysis, Source, Span, Word } from "./types.ts";

export const TRANSCRIBE_LANGUAGE = "pt";

export function analysisKey(sourceSha: string): string {
  return createHash("sha256")
    .update(JSON.stringify({
      sha: sourceSha,
      language: TRANSCRIBE_LANGUAGE,
      promptVersion: PROMPT_VERSION,
      model: ZAI_DEFAULT_MODEL,
    }))
    .digest("hex");
}

export function analysisCacheDir(projectDir: string, sourceSha: string): string {
  return join(projectDir, "analysis", sourceSha, analysisKey(sourceSha));
}

function resultPath(projectDir: string, sourceSha: string): string {
  return join(analysisCacheDir(projectDir, sourceSha), "analysis.json");
}

const EMPTY_COVERAGE = { requested: [], returned: [], missing: [] } as Analysis["visualCoverage"];
const analysisBuilds = createLimitedQueue(4);

async function readCached(projectDir: string, source: Source): Promise<Analysis | null> {
  const inspection = await inspectArtifact(resultPath(projectDir, source.sha256));
  if (inspection.status !== "ready") return null;
  const raw = inspection.value as Analysis;
  if (!raw || raw.key !== analysisKey(source.sha256) || raw.status !== "ready") return null;
  const normalized: Analysis = {
    ...raw,
    words: Array.isArray(raw.words) ? raw.words : [],
    wordsStatus: raw.wordsStatus === "ready" ? "ready" : "missing",
    visualCoverage: raw.visualCoverage ?? { ...EMPTY_COVERAGE },
  };
  const adapted = adaptAnalysis(normalized, source);
  // Cache antigo (sem palavras) alimenta do transcript válido sem nova ASR.
  // Somente leitura: o arquivo de cache não é reescrito aqui.
  if (adapted.wordsStatus === "missing") {
    const derived = await wordsFromCache(join(analysisCacheDir(projectDir, source.sha256), "work"), source);
    if (derived) return { ...adapted, words: derived, wordsStatus: "ready" };
  }
  return adapted;
}

function adaptAnalysis(analysis: Analysis, source: Source): Analysis {
  if (analysis.sourceId === source.id) return analysis;
  const prefix = `${analysis.sourceId}:`;
  const remap = (id: string) => id.startsWith(prefix) ? `${source.id}:${id.slice(prefix.length)}` : `${source.id}:${id}`;
  return {
    ...analysis,
    sourceId: source.id,
    speech: analysis.speech.map((span) => ({
      ...span,
      id: remap(span.id),
      sourceId: source.id,
    })),
    visual: analysis.visual.map((span) => ({
      ...span,
      id: remap(span.id),
      sourceId: source.id,
    })),
    words: analysis.words.map((word) => ({
      ...word,
      id: remap(word.id),
      sourceId: source.id,
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Lê as palavras do transcript existente (formato condense: segundos,
 * `segments[].words[].{text,start,end}` + id/confiança opcionais) sem
 * retranscrever. IDs posicionais determinísticos incluem sourceId, hash
 * completo e índice original; tempos nunca são estimados por divisão de
 * texto — palavra sem intervalo válido rejeita a leitura.
 */
export function wordsFromTranscript(source: Source, raw: unknown): Word[] {
  if (!isRecord(raw) || !Array.isArray(raw.segments)) {
    throw new Error("transcript sem segments para derivar palavras");
  }
  const flat: { text: string; start: number; end: number; confidence: number | null }[] = [];
  for (const [si, segment] of raw.segments.entries()) {
    if (!isRecord(segment) || !Array.isArray(segment.words)) {
      throw new Error(`transcript com segmento ${si} sem words`);
    }
    for (const [wi, entry] of segment.words.entries()) {
      if (!isRecord(entry) || typeof entry.text !== "string" || entry.text.length === 0) {
        throw new Error(`palavra ${si}.${wi} sem texto`);
      }
      const start = entry.start;
      const endRaw = entry.end;
      if (
        typeof start !== "number" || typeof endRaw !== "number"
        || !Number.isFinite(start) || !Number.isFinite(endRaw)
        || start < 0 || endRaw <= start
      ) {
        throw new Error(
          `palavra "${entry.text}" com intervalo inválido [${String(start)}, ${String(endRaw)}) na fonte ${source.id}`,
        );
      }
      // durationMs é round(s*1000): ASR real frequentemente termina 0,1–1 ms
      // além. Excesso ≤ 1 ms clamba; além disso continua erro (não é arredondamento).
      const slack = 0.001;
      if (endRaw > source.durationSeconds + slack) {
        throw new Error(
          `palavra "${entry.text}" com intervalo inválido [${String(start)}, ${String(endRaw)}) na fonte ${source.id}`,
        );
      }
      const end = Math.min(endRaw, source.durationSeconds);
      const confidence = entry.confidence;
      flat.push({
        text: entry.text,
        start,
        end,
        confidence: typeof confidence === "number" && Number.isFinite(confidence) ? confidence : null,
      });
    }
  }
  return flat.map((word, index) => ({
    ...word,
    id: `${source.id}:${source.sha256}:w${String(index).padStart(6, "0")}`,
    sourceId: source.id,
  }));
}

async function wordsFromCache(workDir: string, source: Source): Promise<Word[] | null> {
  try {
    const raw = JSON.parse(
      await readFile(transcriptPath({ id: source.id, videoPath: source.path, workDir }), "utf8"),
    );
    return wordsFromTranscript(source, raw);
  } catch {
    return null;
  }
}

async function saveAnalysis(projectDir: string, sourceSha: string, analysis: Analysis): Promise<void> {
  const dir = analysisCacheDir(projectDir, sourceSha);
  await mkdir(dir, { recursive: true });
  await publishAtomic(resultPath(projectDir, sourceSha), `${JSON.stringify(analysis, null, 2)}\n`);
}

function spansFromIndex(source: Source, raw: unknown): Span[] {
  const index = parseSpeechIndex(raw);
  return index.units.map((unit) => ({
    id: `${source.id}:${unit.id}`,
    sourceId: source.id,
    start: unit.start,
    end: unit.end,
    text: unit.text,
  }));
}

async function buildAnalysis(
  source: Source,
  dir: string,
  exec: Executor,
  opts?: { signal?: AbortSignal },
): Promise<Analysis> {
  const key = analysisKey(source.sha256);
  const cached = await readCached(dir, source);
  if (cached) return cached;
  if (opts?.signal?.aborted) throw new CancelledError();

  const exists = await access(source.path).then(() => true, () => false);
  if (!exists) {
    throw new Error(`mídia ausente: fonte ${source.id} em ${source.path}`);
  }

  if (!source.hasAudio) {
    const analysis: Analysis = {
      sourceId: source.id,
      key,
      speech: [],
      visual: [],
      status: "ready",
      words: [],
      wordsStatus: "ready",
      visualCoverage: { ...EMPTY_COVERAGE },
    };
    await saveAnalysis(dir, source.sha256, analysis);
    return analysis;
  }

  const workDir = join(analysisCacheDir(dir, source.sha256), "work");
  await mkdir(join(workDir, "out"), { recursive: true });
  try {
    await runIngest(
      { id: source.id, videoPath: source.path, workDir },
      exec,
      () => undefined,
    );
    if (opts?.signal?.aborted) throw new CancelledError();
  } catch (err) {
    if (isCancelledError(err) || opts?.signal?.aborted) throw new CancelledError();
    const analysis: Analysis = {
      sourceId: source.id,
      key,
      speech: [],
      visual: [],
      status: "error",
      error: err instanceof Error ? err.message : String(err),
      words: [],
      wordsStatus: "missing",
      visualCoverage: { ...EMPTY_COVERAGE },
    };
    await saveAnalysis(dir, source.sha256, analysis);
    return analysis;
  }

  try {
    const raw = JSON.parse(await readFile(join(workDir, "out", "speech_index.json"), "utf8"));
    const words = await wordsFromCache(workDir, source);
    const analysis: Analysis = {
      sourceId: source.id,
      key,
      speech: spansFromIndex(source, raw),
      visual: [],
      status: "ready",
      words: words ?? [],
      wordsStatus: words ? "ready" : "missing",
      visualCoverage: { ...EMPTY_COVERAGE },
    };
    if (opts?.signal?.aborted) throw new CancelledError();
    await saveAnalysis(dir, source.sha256, analysis);
    return analysis;
  } catch (err) {
    if (isCancelledError(err) || opts?.signal?.aborted) throw new CancelledError();
    const analysis: Analysis = {
      sourceId: source.id,
      key,
      speech: [],
      visual: [],
      status: "partial",
      error: err instanceof Error ? err.message : String(err),
      words: [],
      wordsStatus: "missing",
      visualCoverage: { ...EMPTY_COVERAGE },
    };
    await saveAnalysis(dir, source.sha256, analysis);
    return analysis;
  }
}

export async function analyzeSource(
  source: Source,
  dir: string,
  exec: Executor,
  opts?: { signal?: AbortSignal },
): Promise<Analysis> {
  return analysisBuilds.run(
    () => buildAnalysis(source, dir, exec, opts),
    { key: `${dir}:${analysisKey(source.sha256)}`, signal: opts?.signal },
  );
}

export async function loadAnalysis(projectDir: string, source: Source): Promise<Analysis | null> {
  return readCached(projectDir, source);
}
