#!/usr/bin/env node
/**
 * Ensaio isolado de estratégias de análise visual (Task 4).
 *
 * Um braço por execução sobre uma CÓPIA do projeto (amostra ≤60s de vídeo).
 * Nunca escreve project.json (hash antes/depois; divergência aborta).
 * Sem --allow-paid, apenas inventaria o corpus e imprime o pedido concreto
 * de autorização, sem nenhuma chamada de rede.
 *
 * Braços: baseline e compact via describeSource (cache da cópia, frio na
 * primeira repetição); sparse e two-pass orquestrados aqui (sem cache de
 * produção, sem salvar análise); low-effort marca não executado até que o
 * suporte a reasoning_effort seja confirmado na documentação oficial.
 * Concorrência de produção preservada: extração 2, rede 2.
 */
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analysisClientOptions, createAnalysisClient } from "../packages/triage/src/analysis-client.ts";
import { readCredentials } from "../packages/triage/src/credentials.ts";
import { SpawnExecutor, type Executor } from "../apps/cli/src/app/pipeline.ts";
import { loadProject } from "../apps/cli/src/app/assembly/store.ts";
import {
  describeSource,
  frameMessage,
  parseLocalSpans,
  VISUAL_PROMPT_SPARSE,
  type VisualClient,
  type VisualMetric,
  type VisualProfile,
} from "../apps/cli/src/app/assembly/model.ts";
import { extractVisualFrames, type VisualFrame, type VisualWindow } from "../apps/cli/src/app/assembly/frames.ts";
import { visualWindows } from "../apps/cli/src/app/assembly/visual.ts";
import { createVisualPools } from "../apps/cli/src/app/assembly/visual-pool.ts";
import type { Source, VisualSpan } from "../apps/cli/src/app/assembly/types.ts";

/**
 * Subamostra determinística em memória: mantém o índice 0 de cada grupo e
 * sempre o último frame (nunca fabrica timestamps). O ensaio mede benefício
 * de rede/geração, não redução de custo de extração (extrai-se a 1 fps).
 */
export function sampleFrames(frames: VisualFrame[], step: 1 | 3): VisualFrame[] {
  return frames.filter((_, i) => i % step === 0 || i === frames.length - 1);
}

export type ProofArm = "baseline" | "compact" | "sparse" | "two-pass" | "low-effort";

const ARMS: ProofArm[] = ["baseline", "compact", "sparse", "two-pass", "low-effort"];

/** Teto da amostra por execução: trava de custo antes de qualquer chamada. */
const SAMPLE_CAP_SECONDS = 60;

export type ProofHooks = {
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
  /** Cliente injetado (testes): dispensa credenciais e transporte real. */
  client?: VisualClient;
  exec?: Executor;
};

type ProofConfig = { project: string; out: string; arm: ProofArm; allowPaid: boolean };

const USAGE = `uso: visual-analysis-proof.ts --project DIR --out ARQ --arm ${ARMS.join("|")} [--allow-paid]
Ensaio isolado de um braço de análise visual sobre uma cópia do projeto.
Sem --allow-paid, só inventaria o corpus e imprime o pedido de autorização.`;

function parseArgs(argv: string[]): ProofConfig {
  const args = new Map<string, string>();
  let allowPaid = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    if (flag === "--allow-paid") {
      allowPaid = true;
      continue;
    }
    const value = argv[i + 1];
    if (!flag.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`${USAGE}\nargumento inválido: ${flag}`);
    }
    args.set(flag, value);
    i += 1;
  }
  const project = args.get("--project");
  const out = args.get("--out");
  const arm = args.get("--arm");
  if (!project || !out || !arm || !ARMS.includes(arm as ProofArm)) {
    throw new Error(USAGE);
  }
  return { project, out, arm: arm as ProofArm, allowPaid };
}

type InventoryEntry = { source: Source; windows: VisualWindow[] };

async function inventory(projectDir: string): Promise<{ entries: InventoryEntry[]; totalSeconds: number }> {
  const project = await loadProject(projectDir);
  const entries = project.assembly.sources
    .filter((source) => source.included && source.hasVideo && source.durationSeconds > 0)
    .map((source) => ({ source, windows: visualWindows(source.durationSeconds) }));
  const totalSeconds = entries.reduce((sum, entry) => sum + entry.source.durationSeconds, 0);
  return { entries, totalSeconds };
}

function estimateCalls(arm: ProofArm, windows: number): string {
  if (arm === "two-pass") return `${windows}–${2 * windows} chamadas de API em 2 passadas`;
  return `~${windows} chamadas de API (até ${2 * windows} com reparo)`;
}

type Counters = {
  sends: number;
  framesSent: number;
  httpAttempts: number;
  passes: number[];
  extractMs: number;
  requestMs: number;
  queueMs: number;
  totalMs: number;
  cacheHitWindows: number;
};

function emptyCounters(): Counters {
  return {
    sends: 0, framesSent: 0, httpAttempts: 0, passes: [],
    extractMs: 0, requestMs: 0, queueMs: 0, totalMs: 0, cacheHitWindows: 0,
  };
}

function countImages(content: unknown[]): number {
  return content.filter((part) => (part as { type?: string }).type === "image_url").length;
}

function sumMetrics(counters: Counters, events: VisualMetric[]): void {
  for (const event of events) {
    if (event.phase === "extract") counters.extractMs += event.elapsedMs;
    if (event.phase === "request") {
      counters.requestMs += event.elapsedMs;
      counters.queueMs += event.queueMs;
    }
    if (event.phase === "total") {
      counters.totalMs += event.elapsedMs;
      if (event.outcome === "cache-hit") counters.cacheHitWindows += 1;
    }
  }
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

type ArmContext = {
  exec: Executor;
  pools: ReturnType<typeof createVisualPools>;
  send: (content: unknown[], signal: AbortSignal) => Promise<string>;
  counters: Counters;
  signal: AbortSignal;
  scratchDir: string;
};

/**
 * Braços baseline/compact: describeSource de produção com transporte
 * contabilizado. O cache vive na cópia do piloto (frio na repetição 1).
 */
async function runDescribeArm(
  entries: InventoryEntry[],
  projectDir: string,
  profile: VisualProfile,
  ctx: Pick<ArmContext, "exec" | "pools" | "signal"> & { client: VisualClient; counters: Counters },
): Promise<VisualSpan[]> {
  const events: VisualMetric[] = [];
  const spans: VisualSpan[] = [];
  for (const entry of entries) {
    spans.push(...await describeSource(entry.source, projectDir, ctx.signal, {
      client: ctx.client,
      exec: ctx.exec,
      pools: ctx.pools,
      profile,
      onMetric: (metric) => events.push(metric),
    }));
  }
  sumMetrics(ctx.counters, events);
  return spans;
}

/**
 * Restringe spans aos segundos com imagem enviada: cada frame cobre [s,s+1)
 * e o resto é lacuna (nunca observed). Vale para qualquer passada; em
 * passada densa é identidade, pois todos os segundos têm imagem.
 */
export function constrainSpansToSampled(spans: VisualSpan[], sampledSeconds: number[] | Set<number>): VisualSpan[] {
  const sampled = sampledSeconds instanceof Set ? sampledSeconds : new Set(sampledSeconds);
  const out: VisualSpan[] = [];
  for (const span of spans) {
    for (let second = Math.floor(span.start); second < span.end; second += 1) {
      if (!sampled.has(second)) continue;
      const start = Math.max(span.start, second);
      const end = Math.min(span.end, second + 1);
      if (end > start) out.push({ ...span, start, end });
    }
  }
  return out;
}

/**
 * Uma janela com frames já extraídos: tentativa única; resposta inválida
 * falha o braço (medição descartada, não dado). O caminho de produção tem
 * reparo (initial+1); se um reparo ocorrer num braço describeSource, aparece
 * em sends/tentativas e a comparação anota a assimetria.
 * Amostragem esparsa usa prompt próprio (declara 3s) e tem os spans
 * restringidos aos segundos enviados, mesmo que o modelo desobedeça.
 */
async function requestSampledWindow(
  frames: VisualFrame[],
  source: Source,
  window: VisualWindow,
  ctx: ArmContext,
  sampling: "sparse" | "dense",
): Promise<VisualSpan[]> {
  const sampled = sampling === "sparse" ? sampleFrames(frames, 3) : frames;
  const prompt = sampling === "sparse" ? VISUAL_PROMPT_SPARSE : undefined;
  const queued = performance.now();
  const text = await ctx.pools.request(async () => {
    const started = performance.now();
    const response = await ctx.send(frameMessage(sampled, window, "compact", prompt), ctx.signal);
    ctx.counters.requestMs += performance.now() - started;
    ctx.counters.queueMs += started - queued;
    return response;
  }, { signal: ctx.signal });
  const parsed = parseLocalSpans(text, source, window, "compact");
  const kept = constrainSpansToSampled(parsed, sampled.map((frame) => frame.sourceSecond));
  return kept.map((span, i) => ({ ...span, id: `${source.id}:w${window.start}:${i}` }));
}

async function extractCounted(
  source: Source,
  window: VisualWindow,
  ctx: ArmContext,
): Promise<VisualFrame[]> {
  const queued = performance.now();
  let started = queued;
  const frames = await ctx.pools.encode(async () => {
    started = performance.now();
    const extracted = await extractVisualFrames(source, window, ctx.scratchDir, ctx.exec, { signal: ctx.signal });
    ctx.counters.extractMs += performance.now() - started;
    return extracted;
  }, { signal: ctx.signal });
  ctx.counters.queueMs += started - queued;
  return frames;
}

const windowKey = (source: Source, window: VisualWindow): string =>
  `${source.id}:${window.start}-${window.end}-${window.fetchStart}`;

/**
 * Braço sparse: descrição compacta com frames subamostrados (só speech;
 * support/both seguem a 1 fps). Resultado só no relatório, jamais em
 * project.analyses ou cache de produção.
 */
async function runSparse(
  entries: InventoryEntry[],
  ctx: ArmContext,
): Promise<{ spans: VisualSpan[]; frameCache: Map<string, VisualFrame[]> }> {
  const spans: VisualSpan[] = [];
  const frameCache = new Map<string, VisualFrame[]>();
  for (const entry of entries) {
    const collected: VisualSpan[][] = [];
    const sampling = entry.source.role === "speech" ? "sparse" : "dense";
    await ctx.pools.mapWindows(entry.windows, async (window) => {
      const frames = await extractCounted(entry.source, window, ctx);
      frameCache.set(windowKey(entry.source, window), frames);
      collected.push(await requestSampledWindow(frames, entry.source, window, ctx, sampling));
    }, { signal: ctx.signal });
    spans.push(...collected.flat().sort((a, b) => a.start - b.start || a.end - b.end));
  }
  return { spans, frameCache };
}

/**
 * Braço two-pass: passada geral esparsa + detalhamento a 1 fps das janelas
 * sugeridas. Regra padrão de sugestão (revisável no piloto): janela cujo
 * panorama contém incerteza declarada pelo modelo. Custo soma as 2 passadas;
 * a passada 2 reutiliza os frames da 1 em memória (sem re-extrair).
 */
async function runTwoPass(entries: InventoryEntry[], ctx: ArmContext): Promise<VisualSpan[]> {
  const overview = new Map<string, VisualSpan[]>();
  const locate = new Map<string, { source: Source; window: VisualWindow }>();
  const spans: VisualSpan[] = [];
  const frameCache = new Map<string, VisualFrame[]>();
  const before = ctx.counters.sends;
  for (const entry of entries) {
    const collected: { window: VisualWindow; spans: VisualSpan[] }[] = [];
    const sampling = entry.source.role === "speech" ? "sparse" : "dense";
    await ctx.pools.mapWindows(entry.windows, async (window) => {
      const frames = await extractCounted(entry.source, window, ctx);
      frameCache.set(windowKey(entry.source, window), frames);
      collected.push({ window, spans: await requestSampledWindow(frames, entry.source, window, ctx, sampling) });
    }, { signal: ctx.signal });
    for (const item of collected) {
      const key = windowKey(entry.source, item.window);
      overview.set(key, item.spans);
      locate.set(key, { source: entry.source, window: item.window });
    }
  }
  ctx.counters.passes.push(ctx.counters.sends - before);
  const suggested = [...overview.entries()].filter(([, spans]) => spans.some((span) => span.confidence === "uncertain"));
  const detail = new Map<string, VisualSpan[]>();
  const detailStart = ctx.counters.sends;
  for (const [key] of suggested) {
    const located = locate.get(key);
    if (!located) continue;
    const frames = frameCache.get(key) ?? [];
    detail.set(key, await requestSampledWindow(frames, located.source, located.window, ctx, "dense"));
  }
  ctx.counters.passes.push(ctx.counters.sends - detailStart);
  for (const entry of entries) {
    const composed = entry.windows.flatMap((window) => {
      const key = windowKey(entry.source, window);
      return detail.get(key) ?? overview.get(key) ?? [];
    });
    spans.push(...composed.sort((a, b) => a.start - b.start || a.end - b.end));
  }
  return spans;
}

async function shaFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function main(argv: string[], hooks: ProofHooks = {}): Promise<number> {
  const log = hooks.log ?? console.log;
  let config: ProofConfig;
  try {
    config = parseArgs(argv);
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    return 1;
  }
  // Nunca sobrescrever: --out precisa ser caminho livre, verificado antes de
  // qualquer leitura, chamada ou escrita. lstat enxerga o próprio link, então
  // symlink/hardlink para arquivo existente (ex. project.json) também recusa.
  try {
    await lstat(config.out);
    log(`--out recusado: '${config.out}' já existe. Nada foi executado; apague ou escolha outro caminho.`);
    return 1;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const projectJson = join(config.project, "project.json");
  const shaBefore = await shaFile(projectJson).catch(() => null);
  if (!shaBefore) {
    log(`projeto ilegível: ${config.project}`);
    return 1;
  }
  const { entries, totalSeconds } = await inventory(config.project);
  const windowCount = entries.reduce((sum, entry) => sum + entry.windows.length, 0);
  const framesApprox = Math.round(entries.reduce(
    (sum, entry) => sum + entry.windows.reduce((wsum, w) => wsum + (w.end - w.fetchStart), 0),
    0,
  ));
  log(`corpus: ${config.project}`);
  log(`fontes com vídeo incluídas: ${entries.length} (total ${totalSeconds.toFixed(1)}s, teto ${SAMPLE_CAP_SECONDS}s)`);
  for (const entry of entries) {
    log(`- ${entry.source.id} role=${entry.source.role} dur=${entry.source.durationSeconds} janelas=${entry.windows.length}`);
  }
  log(`braço: ${config.arm} → ${estimateCalls(config.arm, windowCount)}, ~${framesApprox} frames a 1 fps`);
  if (!config.allowPaid) {
    log("AUTORIZAÇÃO NECESSÁRIA — nada foi executado, nenhuma chamada de rede feita.");
    log(`para executar: repita o comando com --allow-paid sobre uma cópia do projeto.`);
    return 2;
  }
  if (entries.length === 0) {
    log("nada para ensaiar: nenhuma fonte com vídeo incluída.");
    return 1;
  }
  if (totalSeconds > SAMPLE_CAP_SECONDS) {
    log(`amostra acima do teto: ${totalSeconds.toFixed(1)}s > ${SAMPLE_CAP_SECONDS}s; reduza a cópia do piloto.`);
    return 1;
  }
  if (config.arm === "low-effort") {
    const report = {
      arm: config.arm,
      status: "not-run",
      reason: "reasoning_effort sem suporte confirmado: o transporte não expõe o parâmetro; confirmar na documentação oficial do modelo durante o piloto. Sem trocar modelo ou endpoint.",
      project: config.project,
      sends: 0,
      framesSent: 0,
      httpAttempts: 0,
      projectShaBefore: shaBefore,
      projectShaAfter: await shaFile(projectJson),
    };
    await writeFile(config.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    log(`braço low-effort não executado (ver ${config.out}).`);
    return 0;
  }

  const counters = emptyCounters();
  const fetchImpl = hooks.fetchImpl ?? fetch;
  const countingFetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    counters.httpAttempts += 1;
    return fetchImpl(url, init);
  }) as typeof fetch;
  let client: VisualClient;
  let usage: (() => unknown) | null = null;
  if (hooks.client) {
    client = hooks.client;
  } else {
    const stored = await readCredentials(config.project).catch(() => null);
    const transport = createAnalysisClient({ stored, fetchImpl: countingFetch });
    const meta = analysisClientOptions({ stored });
    client = { model: meta.model, providerKey: meta.baseUrl, send: (content, signal) => transport.send(content, signal) };
    usage = () => transport.usage();
  }
  const countingClient: VisualClient = {
    ...client,
    send: async (content, signal) => {
      counters.sends += 1;
      counters.framesSent += countImages(content);
      return client.send(content, signal);
    },
  };
  const exec = hooks.exec ?? new SpawnExecutor();
  const pools = createVisualPools({ ffmpegLimit: 2, networkLimit: 2 });
  const controller = new AbortController();
  const scratchDir = await mkdtemp(join(tmpdir(), "visual-proof-scratch-"));
  const wallStart = performance.now();
  try {
    const ctx: ArmContext = {
      exec, pools,
      send: (content, signal) => countingClient.send(content, signal),
      counters, signal: controller.signal, scratchDir,
    };
    let spans: VisualSpan[];
    if (config.arm === "baseline" || config.arm === "compact") {
      const sendsBefore = counters.sends;
      spans = await runDescribeArm(entries, config.project, config.arm, {
        exec, pools, signal: controller.signal, client: countingClient, counters,
      });
      counters.passes.push(counters.sends - sendsBefore);
    } else if (config.arm === "sparse") {
      const sendsBefore = counters.sends;
      spans = (await runSparse(entries, ctx)).spans;
      counters.passes.push(counters.sends - sendsBefore);
    } else {
      spans = await runTwoPass(entries, ctx);
    }
    const report = {
      arm: config.arm,
      status: "ok",
      project: config.project,
      sources: entries.map((entry) => ({
        id: entry.source.id,
        role: entry.source.role,
        durationSeconds: entry.source.durationSeconds,
        windows: entry.windows.length,
      })),
      wallMs: round2(performance.now() - wallStart),
      httpAttempts: counters.httpAttempts,
      usage: usage ? usage() : null,
      framesSent: counters.framesSent,
      sends: counters.sends,
      passes: counters.passes,
      metrics: {
        extractMs: round2(counters.extractMs),
        requestMs: round2(counters.requestMs),
        queueMs: round2(counters.queueMs),
        totalMs: round2(counters.totalMs),
        cacheHitWindows: counters.cacheHitWindows,
      },
      windows: windowCount,
      spans,
      projectShaBefore: shaBefore,
      projectShaAfter: await shaFile(projectJson),
    };
    if (report.projectShaAfter !== report.projectShaBefore) {
      throw new Error("project.json mudou durante o ensaio — bug no isolamento.");
    }
    await writeFile(config.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    log(`braço ${config.arm}: ${spans.length} spans, ${counters.sends} chamadas, relatório em ${config.out}.`);
    return 0;
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

const invokedDirectly = (() => {
  try {
    return fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "");
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
