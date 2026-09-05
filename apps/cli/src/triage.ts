import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  acceptedDropIds,
  applyDensityBudget,
  applyInspect,
  buildUnitsBlock,
  cacheKey,
  DEFAULT_MODEL,
  flagsWithoutSubstitute,
  GeminiTriageModel,
  keepListFrom,
  mechanicalClaims,
  parseSpeechIndex,
  parseVisualIndex,
  PROMPT_VERSION,
  readCache,
  renderReport,
  verifyClaims,
  writeCache,
  ZAI_DEFAULT_MODEL,
  ZaiTriageModel,
  type DensityCandidate,
  type InspectFlag,
  type InspectVerdict,
  type ReportInput,
  type StructureClaim,
  type TriageModel,
  type Verdict,
  type VisualUnitFlags,
} from "@decupa/triage";

export interface TriageOptions {
  indexPath: string;
  videoPath: string;
  outDir: string;
  targetSeconds?: number;
  /** Injetável para teste; em produção vem de `provider`. */
  model?: TriageModel;
  modelName?: string;
  /** Qual motor responde. Default: gemini. */
  provider?: "gemini" | "zai";
  /** Injetável: testes não dependem de ffmpeg. */
  extractFrames?: (unit: { id: string; start: number; end: number }) => Promise<string[]>;
  visual?: VisualUnitFlags[];
}

export interface TriageJson {
  keepList: string;
  drop: { unit_ids: string[]; reason: string; note: string; source: string; restated_by: string | null }[];
  reviewFlags: InspectFlag[];
}

export interface TriageResult {
  keepList: string;
  verdicts: Verdict[];
  reportPath: string;
  drop: TriageJson["drop"];
  reviewFlags: InspectFlag[];
}

async function sha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

async function hashFrames(paths: string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const p of paths) hash.update(await readFile(p));
  return hash.digest("hex");
}

async function loadVisual(opts: TriageOptions): Promise<VisualUnitFlags[] | undefined> {
  if (opts.visual) return opts.visual;
  const candidates = [
    join(dirname(opts.indexPath), "visual_index.json"),
    join(opts.outDir, "visual_index.json"),
  ];
  for (const path of candidates) {
    try {
      return parseVisualIndex(JSON.parse(await readFile(path, "utf8")));
    } catch {
      // Ausente ou inválido: segue sem visual.
    }
  }
  return undefined;
}

/** 3–4 JPEGs da unidade, via ffmpeg. Falha → lista vazia (inspect não roda). */
export async function extractUnitFrames(
  videoPath: string,
  unit: { id: string; start: number; end: number },
  destDir: string,
): Promise<string[]> {
  await mkdir(destDir, { recursive: true });
  const n = 4;
  const span = Math.max(unit.end - unit.start, 0.25);
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = unit.start + (span * (i + 0.5)) / n;
    const path = join(destDir, `${unit.id}_${i}.jpg`);
    const code = await new Promise<number>((resolve) => {
      const child = spawn("ffmpeg", [
        "-hide_banner", "-loglevel", "error",
        "-ss", t.toFixed(3), "-i", videoPath,
        "-frames:v", "1", "-q:v", "4", "-y", path,
      ]);
      child.on("close", (c) => resolve(c ?? 1));
      child.on("error", () => resolve(1));
    });
    if (code === 0) out.push(path);
  }
  return out;
}

export async function runTriage(opts: TriageOptions): Promise<TriageResult> {
  const provider = opts.provider ?? "gemini";
  const modelName = opts.modelName ?? (provider === "zai" ? ZAI_DEFAULT_MODEL : DEFAULT_MODEL);
  const model = opts.model ?? (provider === "zai"
    ? new ZaiTriageModel({ model: modelName })
    : new GeminiTriageModel(modelName));
  const index = parseSpeechIndex(JSON.parse(await readFile(opts.indexPath, "utf8")));
  const unitsBlock = buildUnitsBlock(index);
  const visual = await loadVisual(opts);
  const visualMap = visual ? new Map(visual.map((u) => [u.id, u] as const)) : undefined;

  const cacheDir = join(opts.outDir, "triage_cache");
  await mkdir(cacheDir, { recursive: true });
  const shas = { videoSha: await sha256(opts.videoPath), indexSha: await sha256(opts.indexPath) };
  const keyOf = (pass: "structure" | "density", budgetSeconds?: number) =>
    cacheKey({ ...shas, promptVersion: PROMPT_VERSION, model: modelName, pass, budgetSeconds });

  // Passe 0 — mecânico (retakes, pré/pós-rolo, ar morto). Sem LLM.
  const mechanicalVerdicts = verifyClaims(mechanicalClaims(index, visualMap), index);
  const dropped = acceptedDropIds(mechanicalVerdicts);

  // Passe 1 — estrutura
  const structureKey = keyOf("structure");
  let claims = await readCache<StructureClaim[]>(cacheDir, structureKey);
  if (claims === null) {
    claims = await model.structure({ unitsBlock, videoPath: opts.videoPath });
    await writeCache(cacheDir, structureKey, claims);
  }
  const modelVerdicts = verifyClaims(claims, index);
  for (const id of acceptedDropIds(modelVerdicts)) dropped.add(id);
  const verdicts: Verdict[] = [...mechanicalVerdicts, ...modelVerdicts];

  // Inspect: só faixa ambígua, só unidades que ainda ficam.
  const inspectVerdicts: InspectVerdict[] = [];
  let inspectFlags: InspectFlag[] = [];
  const inspectKept = new Set<string>();
  if (visual && visual.length > 0) {
    const framesDir = join(opts.outDir, "inspect_frames");
    const extract = opts.extractFrames ?? ((unit: { id: string; start: number; end: number }) =>
      extractUnitFrames(opts.videoPath, unit, framesDir));

    for (const u of visual) {
      if (!u.ambiguous || dropped.has(u.id)) continue;
      const unit = index.units.find((x) => x.id === u.id);
      if (!unit) continue;
      const frames = await extract(unit);
      if (frames.length === 0) {
        inspectFlags.push({
          unitId: u.id,
          code: "looks_away",
          source: "visual",
          message: "faixa ambígua: não deu para inspecionar os frames",
        });
        continue;
      }
      const framesSha = await hashFrames(frames);
      const inspectKey = cacheKey({
        ...shas, promptVersion: PROMPT_VERSION, model: modelName,
        pass: "inspect", unitId: u.id, framesSha,
      });
      let verdict = await readCache<InspectVerdict>(cacheDir, inspectKey);
      if (verdict === null) {
        verdict = await model.inspect({ unitId: u.id, frames });
        await writeCache(cacheDir, inspectKey, verdict);
      }
      inspectVerdicts.push(verdict);
      if (verdict.decision === "keep") inspectKept.add(u.id);
    }

    const outcome = applyInspect(inspectVerdicts, index, dropped);
    inspectFlags = [...inspectFlags, ...outcome.flags];
    const inspectVerified = verifyClaims(outcome.claims, index);
    for (const id of acceptedDropIds(inspectVerified)) dropped.add(id);
    verdicts.push(...inspectVerified);
  }

  const reviewFlags = flagsWithoutSubstitute(visual ?? [], dropped, inspectFlags, inspectKept);

  // Passe 2 — densidade, só com alvo
  let density: ReportInput["density"] = null;
  if (opts.targetSeconds !== undefined) {
    const floor = index.losslessFloorSeconds > 0 ? index.losslessFloorSeconds : index.sourceDurationSeconds;
    const budgetSeconds = Math.max(0, floor - opts.targetSeconds);
    const densityKey = keyOf("density", budgetSeconds);
    let candidates = await readCache<DensityCandidate[]>(cacheDir, densityKey);
    if (candidates === null) {
      candidates = await model.density({ unitsBlock, videoPath: opts.videoPath, budgetSeconds });
      await writeCache(cacheDir, densityKey, candidates);
    }
    const applied = applyDensityBudget(candidates, index, { budgetSeconds, alreadyDropped: dropped });
    for (const id of applied.droppedIds) dropped.add(id);
    density = { budgetSeconds, applied: applied.applied, skipped: applied.skipped };
  }

  const keepList = keepListFrom(index, dropped);
  const drop = verdicts
    .filter((v) => v.accepted)
    .map((v) => ({
      unit_ids: v.claim.unit_ids,
      reason: v.claim.reason,
      note: v.claim.note,
      source: v.claim.source,
      restated_by: v.claim.restated_by,
    }));
  const payload: TriageJson = { keepList, drop, reviewFlags };
  await mkdir(opts.outDir, { recursive: true });
  const reportPath = join(opts.outDir, "triage.md");
  await writeFile(reportPath, renderReport({
    keepList, model: modelName, verdicts, density, reviewFlags, inspect: inspectVerdicts,
  }), "utf8");
  await writeFile(join(opts.outDir, "triage.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  return { keepList, verdicts, reportPath, drop, reviewFlags };
}
