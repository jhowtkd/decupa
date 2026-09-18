import { homedir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { TypeSafeClient } from "@decupa/typesafe";
import {
  acceptedDropIds,
  applyDensityBudget,
  applyInspect,
  buildEditCatalog,
  buildUnitsBlock,
  cacheKey,
  flagsWithoutSubstitute,
  keepListFrom,
  mechanicalClaims,
  parseSpeechIndex,
  parseVisualIndex,
  presetConfig,
  providerIdentity,
  PROMPT_VERSION,
  readCache,
  renderReport,
  readCredentials,
  resolveProvider,
  decideWithTypeSafe,
  routeTriage,
  unitsById,
  verifyClaims,
  writeCache,
  ZaiTriageModel,
  type DensityCandidate,
  type EditCatalog,
  type FastDecision,
  type InspectFlag,
  type InspectVerdict,
  type ReportInput,
  type RouteMode,
  type StructureClaim,
  type TriageModel,
  type TypeSafeDecideClient,
  type Verdict,
  type VisualUnitFlags,
  type ZaiUsage,
} from "@decupa/triage";
import { bootProjectDecision } from "./app/assembly/decision-boot.ts";
import { sharedVisualPools, type VisualPools } from "./app/assembly/visual-pool.ts";

export interface TriageOptions {
  indexPath: string;
  videoPath: string;
  outDir: string;
  targetSeconds?: number;
  /** Injetável para teste; em produção vem de `provider`. */
  model?: TriageModel;
  modelName?: string;
  /** Qual motor responde. Resolvido pela chave quando ausente. */
  provider?: string;
  /** Pasta com `.decupa/credentials`, se houver. */
  projectDir?: string;
  /** Teto de tokens por chamada; default 16000. O thinking do GLM consome
   *  antes da resposta — chamadas com unitsBlock grande podem precisar de mais. */
  maxTokens?: number;
  /** Injetável: testes não dependem de ffmpeg. */
  extractFrames?: (unit: { id: string; start: number; end: number }) => Promise<string[]>;
  visual?: VisualUnitFlags[];
  /** Orçamento compartilhado com janelas visuais (FFmpeg + rede). */
  visualPools?: VisualPools;
  /** Cancelamento da triagem: mata o ffmpeg do inspect e libera a vaga. */
  signal?: AbortSignal;
  /** Injetável: testes não dependem do ffmpeg real. */
  spawn?: ExtractFramesDeps["spawn"];
  /** `off` (padrão) reproduz o passe structure legado. */
  routeMode?: RouteMode;
  decide?: (catalog: EditCatalog) => FastDecision | null | Promise<FastDecision | null>;
  /** Cliente TypeSafe; hybrid/observe usam o catálogo fechado sem texto privado. */
  typeSafeClient?: TypeSafeDecideClient;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

export interface TriageJson {
  keepList: string;
  drop: { unit_ids: string[]; reason: string; note: string; source: string; restated_by: string | null }[];
  reviewFlags: InspectFlag[];
  usage?: ZaiUsage;
}

export interface TriageResult {
  keepList: string;
  verdicts: Verdict[];
  reportPath: string;
  drop: TriageJson["drop"];
  reviewFlags: InspectFlag[];
}

export function parseRouteMode(raw?: string): RouteMode {
  const mode = raw ?? "off";
  if (mode === "off" || mode === "observe" || mode === "hybrid") return mode;
  throw new Error(`rota inválida: ${mode}`);
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

/**
 * Inspect lê JPEGs: `visual-proxy.mp4` (4 fps) se existir no work dir,
 * senão o vídeo da triagem (triage-proxy / original).
 */
export async function resolveInspectVideoPath(videoPath: string, outDir: string): Promise<string> {
  const candidates = [
    join(dirname(videoPath), "visual-proxy.mp4"),
    join(dirname(outDir), "visual-proxy.mp4"),
  ];
  const seen = new Set<string>();
  for (const p of candidates) {
    if (seen.has(p)) continue;
    seen.add(p);
    try {
      await access(p);
      return p;
    } catch {
      // próximo candidato
    }
  }
  return videoPath;
}

export type ExtractFramesDeps = {
  pool?: VisualPools;
  spawn?: (
    command: string,
    args: string[],
    options?: { signal?: AbortSignal },
  ) => ChildProcess;
  signal?: AbortSignal;
};

/** 3–4 JPEGs da unidade, via ffmpeg. Falha → lista vazia (inspect não roda). */
export async function extractUnitFrames(
  videoPath: string,
  unit: { id: string; start: number; end: number },
  destDir: string,
  deps: ExtractFramesDeps = {},
): Promise<string[]> {
  const spawnFn = deps.spawn ?? spawn;
  const pool = deps.pool ?? sharedVisualPools();
  await mkdir(destDir, { recursive: true });
  const n = 4;
  const span = Math.max(unit.end - unit.start, 0.25);
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    if (deps.signal?.aborted) break;
    const t = unit.start + (span * (i + 0.5)) / n;
    const path = join(destDir, `${unit.id}_${i}.jpg`);
    const code = await pool.encode(() => new Promise<number>((resolve) => {
      const child = spawnFn("ffmpeg", [
        "-hide_banner", "-loglevel", "error",
        "-ss", t.toFixed(3), "-i", videoPath,
        "-frames:v", "1", "-q:v", "4", "-y", path,
      ], { signal: deps.signal });
      child.on("close", (c) => resolve(c ?? 1));
      child.on("error", () => resolve(1));
    }), { signal: deps.signal });
    if (code === 0) out.push(path);
  }
  return out;
}

/** Base64 acima disso já devolveu erro genérico na Z.ai (medido: 14,9 MB
 *  falhou com "1234 internal network failure", 2,2 MB passou). O app sempre
 *  manda o proxy leve; o perigo é o `decupa triage` standalone com o
 *  vídeo original. */
const MAX_DIRECT_VIDEO_MB = 8;

export async function ensureLightVideo(
  videoPath: string,
  outDir: string,
  deps: {
    fileSize?: (p: string) => Promise<number>;
    transcode?: (src: string, dst: string) => Promise<void>;
    sourceSha?: (p: string) => Promise<string>;
  } = {},
): Promise<string> {
  // O app entrega o proxy com este nome exato; re-transcodificar o proxy
  // seria gastar minuto para piorar o arquivo.
  if (basename(videoPath) === "triage-proxy.mp4") return videoPath;

  const fileSize = deps.fileSize ?? (async (p: string) => (await stat(p)).size);
  if ((await fileSize(videoPath)) / 1024 / 1024 <= MAX_DIRECT_VIDEO_MB) return videoPath;

  const proxy = join(outDir, "triage-proxy.mp4");
  const sidecar = join(outDir, "triage-proxy.source.sha256");
  const sourceSha = deps.sourceSha ?? sha256;

  if (await access(proxy).then(() => true, () => false)) {
    // Reuso só com prova de procedência: o sidecar precisa conter o sha do
    // vídeo atual. Sem sidecar, ilegível ou de outro vídeo, regenera — um
    // proxy de A não pode triar B em silêncio.
    try {
      if ((await readFile(sidecar, "utf8")).trim() === (await sourceSha(videoPath))) return proxy;
    } catch {
      // sidecar ausente ou ilegível → re-transcodifica
    }
  }

  const transcode = deps.transcode ?? defaultTranscode;
  await mkdir(outDir, { recursive: true });
  // Escrita atômica: um ffmpeg morto no meio não pode deixar proxy parcial
  // que seria reusado para sempre.
  const partial = join(outDir, "triage-proxy.partial.mp4");
  try {
    await transcode(videoPath, partial);
    await writeFile(sidecar, `${await sourceSha(videoPath)}\n`, "utf8");
    await rename(partial, proxy);
  } catch (err) {
    await rm(partial, { force: true });
    throw err;
  }
  return proxy;
}

export async function defaultTranscode(src: string, dst: string): Promise<void> {
  // Os mesmos parâmetros de pipeline.makeTriageProxy: o vídeo entra pro
  // modelo dar contexto visual, não detalhe.
  const code = await new Promise<number>((resolve) => {
    const child = spawn("ffmpeg", [
      "-i", src,
      "-vf", "fps=1,scale='min(270,iw)':'min(480,ih)':force_original_aspect_ratio=decrease",
      "-c:v", "libx264", "-crf", "32", "-preset", "veryfast",
      "-c:a", "aac", "-b:a", "24k", "-ac", "1",
      "-y", dst,
    ]);
    child.on("close", (c) => resolve(c ?? 1));
    child.on("error", () => resolve(1));
  });
  if (code !== 0) throw new Error(`não consegui gerar o proxy leve em ${dst} (ffmpeg código ${code})`);
}

export async function runTriage(opts: TriageOptions): Promise<TriageResult> {
  const stored = await readCredentials(opts.projectDir ?? process.cwd()).catch(() => null)
    ?? await readCredentials(homedir()).catch(() => null);
  const provider = resolveProvider(opts.provider, process.env, stored);
  const cfg = presetConfig(provider, process.env, stored);
  const modelName = opts.modelName ?? cfg.model;
  const model = opts.model ?? new ZaiTriageModel({
    provider,
    stored,
    model: modelName,
    maxTokens: opts.maxTokens,
  });
  const videoPath = await ensureLightVideo(opts.videoPath, opts.outDir);
  const index = parseSpeechIndex(JSON.parse(await readFile(opts.indexPath, "utf8")));
  const byId = unitsById(index);
  const unitsBlock = buildUnitsBlock(index);
  const visual = await loadVisual(opts);
  const visualMap = visual ? new Map(visual.map((u) => [u.id, u] as const)) : undefined;

  const cacheDir = join(opts.outDir, "triage_cache");
  await mkdir(cacheDir, { recursive: true });
  const shas = { videoSha: await sha256(videoPath), indexSha: await sha256(opts.indexPath) };
  const providerId = providerIdentity({ provider, model: modelName, baseUrl: cfg.baseUrl });
  const keyOf = (pass: "structure" | "density", budgetSeconds?: number) =>
    cacheKey({ ...shas, promptVersion: PROMPT_VERSION, model: modelName, providerId, pass, budgetSeconds });

  const env = opts.env ?? process.env;
  let routeMode = opts.routeMode;
  let typeSafeClient = opts.typeSafeClient;
  if (!typeSafeClient && routeMode !== "off") {
    const boot = await bootProjectDecision({
      projectDir: opts.projectDir ?? process.cwd(),
      env,
      fetchImpl: opts.fetchImpl,
      log: (line) => console.log(line),
    });
    routeMode = routeMode ?? boot.mode;
    if (boot.enabled && env.TYPESAFE_API_KEY) {
      typeSafeClient = new TypeSafeClient({
        apiKey: env.TYPESAFE_API_KEY,
        fetchImpl: opts.fetchImpl,
      });
    }
  }
  routeMode = routeMode ?? "off";
  if (
    !typeSafeClient
    && (routeMode === "hybrid" || routeMode === "observe")
    && env.DECUPA_TYPESAFE === "1"
    && env.TYPESAFE_API_KEY
  ) {
    typeSafeClient = new TypeSafeClient({
      apiKey: env.TYPESAFE_API_KEY,
      fetchImpl: opts.fetchImpl,
    });
  }
  let dropped: Set<string>;
  let verdicts: Verdict[];

  if (routeMode === "off") {
    // Passe 0 — mecânico (retakes, pré/pós-rolo, ar morto). Sem LLM.
    const mechanicalVerdicts = verifyClaims(mechanicalClaims(index, visualMap), index);
    dropped = acceptedDropIds(mechanicalVerdicts);

    // Passe 1 — estrutura (legado: cache + uma chamada)
    const structureKey = keyOf("structure");
    let claims = await readCache<StructureClaim[]>(cacheDir, structureKey);
    if (claims === null) {
      claims = await model.structure({ unitsBlock, videoPath });
      await writeCache(cacheDir, structureKey, claims);
    }
    const modelVerdicts = verifyClaims(claims, index, dropped);
    for (const id of acceptedDropIds(modelVerdicts)) dropped.add(id);
    verdicts = [...mechanicalVerdicts, ...modelVerdicts];
  } else {
    const routed = await routeTriage({
      mode: routeMode,
      index,
      model,
      unitsBlock,
      videoPath,
      decide: opts.decide ?? (typeSafeClient
        ? (catalog) => decideWithTypeSafe(catalog, typeSafeClient)
        : undefined),
    });
    verdicts = routed.verdicts;
    dropped = acceptedDropIds(verdicts);
  }

  // Inspect: só faixa ambígua, só unidades que ainda ficam.
  const inspectVerdicts: InspectVerdict[] = [];
  let inspectFlags: InspectFlag[] = [];
  const inspectKept = new Set<string>();
  if (visual && visual.length > 0) {
    const framesDir = join(opts.outDir, "inspect_frames");
    const inspectVideo = await resolveInspectVideoPath(videoPath, opts.outDir);
    const pools = opts.visualPools ?? sharedVisualPools();
    const extract = opts.extractFrames ?? ((unit: { id: string; start: number; end: number }) =>
      extractUnitFrames(inspectVideo, unit, framesDir, {
        pool: pools,
        signal: opts.signal,
        spawn: opts.spawn,
      }));

    for (const u of visual) {
      if (!u.ambiguous || dropped.has(u.id)) continue;
      const unit = byId.get(u.id);
      if (!unit) continue;
      const inspectKey = cacheKey({
        ...shas, promptVersion: PROMPT_VERSION, model: modelName, providerId,
        pass: "inspect", unitId: u.id,
      });
      let verdict = await readCache<InspectVerdict>(cacheDir, inspectKey);
      if (verdict === null) {
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
        try {
          verdict = await pools.request(() => model.inspect({ unitId: u.id, frames }), {
            signal: opts.signal,
          });
        } catch {
          inspectFlags.push({
            unitId: u.id,
            code: "looks_away",
            source: "visual",
            message: "inspect: resposta inválida, para revisão",
          });
          continue;
        }
        await writeCache(cacheDir, inspectKey, verdict);
      }
      inspectVerdicts.push(verdict);
      if (verdict.decision === "keep") inspectKept.add(u.id);
    }

    const outcome = applyInspect(inspectVerdicts, index, dropped);
    inspectFlags = [...inspectFlags, ...outcome.flags];
    const inspectVerified = verifyClaims(outcome.claims, index, dropped);
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
      candidates = await model.density({ unitsBlock, videoPath, budgetSeconds });
      await writeCache(cacheDir, densityKey, candidates);
    }
    const applied = applyDensityBudget(candidates, index, { budgetSeconds, alreadyDropped: dropped });
    for (const id of applied.droppedIds) dropped.add(id);
    density = { budgetSeconds, applied: applied.applied, skipped: applied.skipped };
  }

  const keepList = keepListFrom(index, dropped);
  // Só o adaptador da Z.ai sabe o que gastou; um modelo injetado de teste não.
  // `usage()` devolve cópia, então capturar aqui congela o total de todos os
  // passes que já rodaram (estrutura, inspect, densidade).
  const usage = model instanceof ZaiTriageModel ? model.usage() : undefined;
  const drop = verdicts
    .filter((v) => v.accepted)
    .map((v) => ({
      unit_ids: v.claim.unit_ids,
      reason: v.claim.reason,
      note: v.claim.note,
      source: v.claim.source,
      restated_by: v.claim.restated_by,
    }));
  // `usage: undefined` some do JSON.stringify — triage.json só traz a chave
  // quando houve chamada de verdade.
  const payload: TriageJson = { keepList, drop, reviewFlags, usage };
  await mkdir(opts.outDir, { recursive: true });
  const reportPath = join(opts.outDir, "triage.md");
  await writeFile(reportPath, renderReport({
    keepList, model: modelName, verdicts, density, reviewFlags, inspect: inspectVerdicts, usage,
  }), "utf8");
  await writeFile(join(opts.outDir, "triage.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const catalog = await buildEditCatalog(index);
  await writeFile(join(opts.outDir, "catalog.json"), `${JSON.stringify({
    sourceClean: catalog.sourceClean,
    coveredUnitIds: catalog.coveredUnitIds,
    uncoveredUnitIds: catalog.uncoveredUnitIds,
    candidates: catalog.candidates,
  }, null, 2)}\n`, "utf8");

  return { keepList, verdicts, reportPath, drop, reviewFlags };
}
