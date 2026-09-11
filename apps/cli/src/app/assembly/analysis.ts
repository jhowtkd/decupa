import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PROMPT_VERSION, ZAI_DEFAULT_MODEL, parseSpeechIndex } from "@decupa/triage";
import type { Executor } from "../pipeline.ts";
import { runIngest } from "../pipeline.ts";
import type { Analysis, Source, Span } from "./types.ts";

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

async function readCached(projectDir: string, source: Source): Promise<Analysis | null> {
  try {
    const raw = JSON.parse(await readFile(resultPath(projectDir, source.sha256), "utf8")) as Analysis;
    if (raw.key !== analysisKey(source.sha256) || raw.status !== "ready") return null;
    return adaptAnalysis(raw, source);
  } catch {
    return null;
  }
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
  };
}

async function saveAnalysis(projectDir: string, sourceSha: string, analysis: Analysis): Promise<void> {
  const dir = analysisCacheDir(projectDir, sourceSha);
  await mkdir(dir, { recursive: true });
  await writeFile(resultPath(projectDir, sourceSha), `${JSON.stringify(analysis, null, 2)}\n`, "utf8");
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

export async function analyzeSource(
  source: Source,
  dir: string,
  exec: Executor,
): Promise<Analysis> {
  const key = analysisKey(source.sha256);
  const cached = await readCached(dir, source);
  if (cached) return cached;

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
  } catch (err) {
    const analysis: Analysis = {
      sourceId: source.id,
      key,
      speech: [],
      visual: [],
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
    await saveAnalysis(dir, source.sha256, analysis);
    return analysis;
  }

  try {
    const raw = JSON.parse(await readFile(join(workDir, "out", "speech_index.json"), "utf8"));
    const analysis: Analysis = {
      sourceId: source.id,
      key,
      speech: spansFromIndex(source, raw),
      visual: [],
      status: "ready",
    };
    await saveAnalysis(dir, source.sha256, analysis);
    return analysis;
  } catch (err) {
    const analysis: Analysis = {
      sourceId: source.id,
      key,
      speech: [],
      visual: [],
      status: "partial",
      error: err instanceof Error ? err.message : String(err),
    };
    await saveAnalysis(dir, source.sha256, analysis);
    return analysis;
  }
}

export async function loadAnalysis(projectDir: string, source: Source): Promise<Analysis | null> {
  return readCached(projectDir, source);
}
