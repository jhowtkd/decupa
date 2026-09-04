import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  acceptedDropIds,
  applyDensityBudget,
  buildUnitsBlock,
  cacheKey,
  DEFAULT_MODEL,
  GeminiTriageModel,
  keepListFrom,
  parseSpeechIndex,
  PROMPT_VERSION,
  readCache,
  renderReport,
  verifyClaims,
  writeCache,
  ZAI_DEFAULT_MODEL,
  ZaiTriageModel,
  type DensityCandidate,
  type ReportInput,
  type StructureClaim,
  type TriageModel,
  type Verdict,
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
}

export interface TriageResult {
  keepList: string;
  verdicts: Verdict[];
  reportPath: string;
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

export async function runTriage(opts: TriageOptions): Promise<TriageResult> {
  const provider = opts.provider ?? "gemini";
  const modelName = opts.modelName ?? (provider === "zai" ? ZAI_DEFAULT_MODEL : DEFAULT_MODEL);
  const model = opts.model ?? (provider === "zai"
    ? new ZaiTriageModel({ model: modelName })
    : new GeminiTriageModel(modelName));
  const index = parseSpeechIndex(JSON.parse(await readFile(opts.indexPath, "utf8")));
  const unitsBlock = buildUnitsBlock(index);

  const cacheDir = join(opts.outDir, "triage_cache");
  await mkdir(cacheDir, { recursive: true });
  const shas = { videoSha: await sha256(opts.videoPath), indexSha: await sha256(opts.indexPath) };
  const keyOf = (pass: "structure" | "density", budgetSeconds?: number) =>
    cacheKey({ ...shas, promptVersion: PROMPT_VERSION, model: modelName, pass, budgetSeconds });

  // Passe 1 — estrutura
  const structureKey = keyOf("structure");
  let claims = await readCache<StructureClaim[]>(cacheDir, structureKey);
  if (claims === null) {
    claims = await model.structure({ unitsBlock, videoPath: opts.videoPath });
    await writeCache(cacheDir, structureKey, claims);
  }
  const verdicts = verifyClaims(claims, index);
  const dropped = acceptedDropIds(verdicts);

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
  const reportPath = join(opts.outDir, "triage.md");
  await writeFile(reportPath, renderReport({ keepList, model: modelName, verdicts, density }), "utf8");

  return { keepList, verdicts, reportPath };
}
