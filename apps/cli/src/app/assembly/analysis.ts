import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { inspectArtifact, publishAtomic } from "@decupa/cache";
import type { FileCoordinator } from "@decupa/coordinator";
import { CancelledError, createLimitedQueue, isCancelledError } from "@decupa/queue";
import { PROMPT_VERSION, ZAI_DEFAULT_MODEL, parseSpeechIndex } from "@decupa/triage";
import type { Executor, IngestSpeech } from "../pipeline.ts";
import { runIngest, transcriptPath } from "../pipeline.ts";
import type { Analysis, Source, Span, Word } from "./types.ts";

export const TRANSCRIBE_LANGUAGE = "pt";

export type AnalysisPurpose = "asr" | "visual-1fps" | "visual-4fps";

export type AnalyzeOptions = {
  signal?: AbortSignal;
  storeDir?: string;
  purpose?: AnalysisPurpose;
  now?: () => number;
  ttlMs?: number;
  coordinator?: FileCoordinator;
  speech?: IngestSpeech;
};

export function analysisKey(sourceSha: string, purpose: AnalysisPurpose = "asr"): string {
  return createHash("sha256")
    .update(JSON.stringify({
      sha: sourceSha,
      language: TRANSCRIBE_LANGUAGE,
      promptVersion: PROMPT_VERSION,
      model: ZAI_DEFAULT_MODEL,
      ...(purpose === "asr" ? {} : { purpose }),
    }))
    .digest("hex");
}

export function analysisCacheDir(
  projectDir: string,
  sourceSha: string,
  opts: { storeDir?: string; purpose?: AnalysisPurpose } = {},
): string {
  const root = opts.storeDir ?? join(projectDir, "analysis");
  return join(root, sourceSha, analysisKey(sourceSha, opts.purpose ?? "asr"));
}

function resultPath(projectDir: string, sourceSha: string, opts: AnalyzeOptions = {}): string {
  return join(analysisCacheDir(projectDir, sourceSha, opts), "analysis.json");
}

const EMPTY_COVERAGE = { requested: [], returned: [], missing: [] } as Analysis["visualCoverage"];
const analysisBuilds = createLimitedQueue(4);
const ENVELOPE = "analysis-v2";

type StoredAnalysis = {
  version: string;
  createdAt: number;
  refs: string[];
  analysis: Analysis;
};

function unwrapStored(raw: unknown): StoredAnalysis | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (rec.version === ENVELOPE && rec.analysis && typeof rec.analysis === "object") {
    return {
      version: ENVELOPE,
      createdAt: Number(rec.createdAt) || 0,
      refs: Array.isArray(rec.refs) ? rec.refs.map(String) : [],
      analysis: rec.analysis as Analysis,
    };
  }
  if (typeof rec.key === "string" && rec.status) {
    return { version: ENVELOPE, createdAt: 0, refs: [], analysis: rec as unknown as Analysis };
  }
  return null;
}

async function readCached(
  projectDir: string,
  source: Source,
  opts: AnalyzeOptions = {},
): Promise<Analysis | null> {
  const purpose = opts.purpose ?? "asr";
  const inspection = await inspectArtifact(resultPath(projectDir, source.sha256, opts));
  if (inspection.status !== "ready") return null;
  const stored = unwrapStored(inspection.value);
  if (!stored || stored.analysis.key !== analysisKey(source.sha256, purpose) || stored.analysis.status !== "ready") {
    return null;
  }
  const ttlMs = opts.ttlMs;
  const stamp = opts.now ?? Date.now;
  if (ttlMs !== undefined && stored.createdAt > 0 && stamp() - stored.createdAt > ttlMs
    && !stored.refs.includes(projectDir)) {
    return null;
  }
  const raw = stored.analysis;
  const normalized: Analysis = {
    ...raw,
    words: Array.isArray(raw.words) ? raw.words : [],
    wordsStatus: raw.wordsStatus === "ready" ? "ready" : "missing",
    visualCoverage: raw.visualCoverage ?? { ...EMPTY_COVERAGE },
  };
  const adapted = adaptAnalysis(normalized, source);
  if (adapted.wordsStatus === "missing") {
    const derived = await wordsFromCache(join(analysisCacheDir(projectDir, source.sha256, opts), "work"), source);
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

async function saveAnalysis(
  projectDir: string,
  sourceSha: string,
  analysis: Analysis,
  opts: AnalyzeOptions = {},
): Promise<void> {
  const dir = analysisCacheDir(projectDir, sourceSha, opts);
  await mkdir(dir, { recursive: true });
  const path = resultPath(projectDir, sourceSha, opts);
  const existing = unwrapStored((await inspectArtifact(path)).value);
  const refs = new Set(existing?.refs ?? []);
  refs.add(projectDir);
  await publishAtomic(path, `${JSON.stringify({
    version: ENVELOPE,
    createdAt: (opts.now ?? Date.now)(),
    refs: [...refs],
    analysis,
  } satisfies StoredAnalysis, null, 2)}\n`);
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
  opts: AnalyzeOptions = {},
): Promise<Analysis> {
  const purpose = opts.purpose ?? "asr";
  const key = analysisKey(source.sha256, purpose);
  const cached = await readCached(dir, source, opts);
  if (cached) {
    await pinAnalysis(dir, source, opts).catch(() => undefined);
    return cached;
  }
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
    await saveAnalysis(dir, source.sha256, analysis, opts);
    return analysis;
  }

  const workDir = join(analysisCacheDir(dir, source.sha256, opts), "work");
  await mkdir(join(workDir, "out"), { recursive: true });
  try {
    await runIngest(
      { id: source.id, videoPath: source.path, workDir },
      exec,
      () => undefined,
      undefined,
      undefined,
      opts.speech,
      opts.signal,
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
    await saveAnalysis(dir, source.sha256, analysis, opts);
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
    await saveAnalysis(dir, source.sha256, analysis, opts);
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
    await saveAnalysis(dir, source.sha256, analysis, opts);
    return analysis;
  }
}

function flightKey(dir: string, sourceSha: string, opts: AnalyzeOptions = {}): string {
  return `${opts.storeDir ?? dir}:${analysisKey(sourceSha, opts.purpose ?? "asr")}`;
}

export async function analyzeSource(
  source: Source,
  dir: string,
  exec: Executor,
  opts: AnalyzeOptions = {},
): Promise<Analysis> {
  const run = (): Promise<Analysis> => buildAnalysis(source, dir, exec, opts);
  if (opts.coordinator) {
    return opts.coordinator.run({
      id: flightKey(dir, source.sha256, opts),
      stage: opts.purpose ?? "asr",
      signal: opts.signal,
      build: run,
    });
  }
  return analysisBuilds.run(run, { key: flightKey(dir, source.sha256, opts), signal: opts.signal });
}

export async function loadAnalysis(
  projectDir: string,
  source: Source,
  opts: AnalyzeOptions = {},
): Promise<Analysis | null> {
  return readCached(projectDir, source, opts);
}

export async function pinAnalysis(
  projectDir: string,
  source: Source,
  opts: AnalyzeOptions = {},
): Promise<void> {
  const path = resultPath(projectDir, source.sha256, opts);
  const stored = unwrapStored((await inspectArtifact(path)).value);
  if (!stored) return;
  if (stored.refs.includes(projectDir)) return;
  await publishAtomic(path, `${JSON.stringify({
    ...stored,
    refs: [...stored.refs, projectDir],
  } satisfies StoredAnalysis, null, 2)}\n`);
}

export async function unpinAnalysis(
  storeDir: string,
  projectDir: string,
  source: Source,
  opts: AnalyzeOptions = {},
): Promise<void> {
  const path = resultPath(projectDir, source.sha256, { ...opts, storeDir });
  const stored = unwrapStored((await inspectArtifact(path)).value);
  if (!stored) return;
  const refs = stored.refs.filter((ref) => ref !== projectDir);
  if (refs.length === stored.refs.length) return;
  await publishAtomic(path, `${JSON.stringify({
    ...stored,
    refs,
  } satisfies StoredAnalysis, null, 2)}\n`);
}

export async function pruneAnalysisStore(
  storeDir: string,
  opts: { now?: () => number; ttlMs?: number } = {},
): Promise<void> {
  const ttlMs = opts.ttlMs;
  if (ttlMs === undefined) return;
  const stamp = opts.now ?? Date.now;
  const now = stamp();
  let shas: string[];
  try {
    shas = await readdir(storeDir);
  } catch {
    return;
  }
  for (const sha of shas) {
    const shaDir = join(storeDir, sha);
    let keys: string[];
    try {
      keys = await readdir(shaDir);
    } catch {
      continue;
    }
    for (const key of keys) {
      const keyDir = join(shaDir, key);
      const stored = unwrapStored((await inspectArtifact(join(keyDir, "analysis.json"))).value);
      if (!stored || stored.refs.length > 0) continue;
      if (stored.createdAt <= 0 || now - stored.createdAt <= ttlMs) continue;
      await rm(keyDir, { recursive: true, force: true });
    }
  }
}
