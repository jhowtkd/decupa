import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { analysisClientOptions, createAnalysisClient, readCredentials } from "@decupa/triage";
import type { Executor } from "../pipeline.ts";
import { SpawnExecutor } from "../pipeline.ts";
import type { Source, VisualSpan } from "./types.ts";
import { analysisCacheDir } from "./analysis.ts";
import { createVisualPools, sharedVisualPools, type VisualPools } from "./visual-pool.ts";
import { mergeAdjacent, validateVisual, visualWindows } from "./visual.ts";
import { extractVisualFrames } from "./frames.ts";
import { parseModelJson, requestValidated } from "./model-response.ts";
import type { VisualFrame, VisualWindow } from "./frames.ts";

export const VISUAL_PROMPT = `Você recebe frames JPEG timestampados (amostrados a 1 fps), não um vídeo contínuo.
Cada frame é rotulado como FRAME fonte=0s local=0s: fonte é o segundo absoluto da fonte e local é o segundo deste trecho.
Descreva o que é observável por segundo: ações, objetos, enquadramento e incerteza.
Não identifique pessoas por nome sem essa informação no pedido.
Responda só sobre a mídia recebida, em JSON:

{"spans":[{"id":"local-0","start":0,"end":1,"text":"descrição","confidence":"observed","tags":["objeto"]}]}

start/end são segundos locais deste trecho (origem 0). confidence é observed, uncertain ou unavailable.
Não invente o que não aparece. Se um segundo não for observável, confidence unavailable.`;

/** Variante compacta: mesma evidência (1 fps), menos geração — intervalos por cena. */
export const VISUAL_PROMPT_COMPACT = `Você recebe frames JPEG timestampados (amostrados a 1 fps), não um vídeo contínuo.
Cada frame é rotulado como FRAME fonte=0s local=0s: fonte é o segundo absoluto da fonte e local é o segundo deste trecho.
Agrupe intervalos consecutivos quando as imagens amostradas mostram o mesmo conteúdo. Use uma descrição curta por intervalo, sem repetir cenário. Preserve mudanças de ação, enquadramento e incerteza. Não preencha segundos sem evidência; não presuma continuidade de uma ação entre frames. Retorne spans com início/fim locais.
Não identifique pessoas por nome sem essa informação no pedido.
Responda só sobre a mídia recebida, em JSON:

{"spans":[{"id":"local-0","start":0,"end":1,"text":"descrição","confidence":"observed","tags":["objeto"]}]}

start/end são segundos locais deste trecho (origem 0). confidence é observed, uncertain ou unavailable.
Não invente o que não aparece. Se um segundo não for observável, confidence unavailable.`;

/**
 * Variante esparsa (só o ensaio isolado usa): declara amostragem a cada 3
 * segundos e proíbe observed/uncertain em segundos sem imagem. O ensaio
 * ainda restringe os spans aos segundos enviados, caso o modelo desobedeça.
 */
export const VISUAL_PROMPT_SPARSE = `Você recebe frames JPEG timestampados (amostrados a cada 3 segundos — os segundos intermediários NÃO têm imagem), não um vídeo contínuo.
Cada frame é rotulado como FRAME fonte=0s local=0s: fonte é o segundo absoluto da fonte e local é o segundo deste trecho.
Agrupe intervalos consecutivos quando as imagens amostradas mostram o mesmo conteúdo. Use uma descrição curta por intervalo, sem repetir cenário. Preserve mudanças de ação, enquadramento e incerteza.
Descreva como observed ou uncertain SOMENTE segundos com imagem. Segundos sem frame não foram observados: marque unavailable, sem presumir continuidade entre frames espaçados. Retorne spans com início/fim locais.
Não identifique pessoas por nome sem essa informação no pedido.
Responda só sobre a mídia recebida, em JSON:

{"spans":[{"id":"local-0","start":0,"end":1,"text":"descrição","confidence":"observed","tags":["objeto"]}]}

start/end são segundos locais deste trecho (origem 0). confidence é observed, uncertain ou unavailable.
Não invente o que não aparece.`;

/** Versão do prompt (invalida o cache) e do envelope de cache em disco. */
export const VISUAL_PROMPT_VERSION = 3;
export const VISUAL_CACHE_VERSION = "visual-v4";

export type VisualMetric = {
  sourceId: string; windowStart: number; windowEnd: number;
  phase: "extract" | "request" | "total";
  outcome: "ok" | "error" | "cancelled" | "cache-hit";
  elapsedMs: number; queueMs: number; frames: number; attempt: number;
};

export type VisualProfile = "baseline" | "compact";

/**
 * Transporte visual com identidade opcional. Sem model+providerKey o cliente
 * segue funcional, mas não lê nem escreve cache persistente: sem saber quem
 * respondeu, reaproveitar seria servir análise de outra configuração.
 */
export type VisualClient = {
  send(content: unknown[], signal?: AbortSignal): Promise<string>;
  model?: string;
  providerKey?: string;
};

export type DescribeDeps = {
  client: VisualClient;
  exec?: Executor;
  ffmpegLimit?: number;
  networkLimit?: number;
  pools?: VisualPools;
  isCurrent?: () => boolean;
  onMetric?: (metric: VisualMetric) => void;
  now?: () => number;
  profile?: VisualProfile;
};

/**
 * Normaliza baseURL (ou chave pronta) para identidade de cache: sem
 * credenciais, query ou fragmento. Idempotente para entradas já limpas.
 */
export function sanitizeProviderKey(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.split("?")[0]!.split("#")[0]!;
  }
}

type VisualConfigIdentity = { model: string; providerKey: string };

function clientConfigIdentity(client: VisualClient): VisualConfigIdentity | null {
  if (!client.model || !client.providerKey) return null;
  return { model: client.model, providerKey: sanitizeProviderKey(client.providerKey) };
}

function transportConfigIdentity(opts: ReturnType<typeof analysisClientOptions>): VisualConfigIdentity {
  return { model: opts.model, providerKey: sanitizeProviderKey(opts.baseUrl) };
}

function visualIdentityKey(config: VisualConfigIdentity, profile: VisualProfile): string {
  const identity = {
    version: "visual-v4",
    providerKey: config.providerKey,
    model: config.model,
    profile,
    promptVersion: VISUAL_PROMPT_VERSION,
    sampleFps: 1,
    frameMaxSize: 480,
  };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

/**
 * Fatia spans compactos em células de até 1s, sem estender o fim fracionário
 * nem preencher lacunas: cada resposta vira cobertura por célula, como o
 * catálogo de b-roll espera. Chamar após validação e conversão local→fonte;
 * os IDs posicionais são atribuídos depois, por célula.
 */
export function normalizeCompactSpans(spans: VisualSpan[]): VisualSpan[] {
  return spans.flatMap((span) => {
    const cells: VisualSpan[] = [];
    for (let start = span.start; start < span.end;) {
      const end = Math.min(span.end, Math.floor(start) + 1);
      cells.push({ ...span, start, end });
      start = end;
    }
    return cells;
  });
}

/** Args do recorte de janela (M1): o describe usa frames, isto segue cobrindo os fixtures de seek. */
export function visualWindowClipArgs(
  sourcePath: string,
  window: VisualWindow,
  output: string,
): string[] {
  const duration = window.end - window.fetchStart;
  return [
    "-n",
    "-ss", String(window.fetchStart),
    "-i", sourcePath,
    "-t", String(duration),
    "-vf", "fps=1,scale='min(480,iw)':'min(480,ih)':force_original_aspect_ratio=decrease",
    "-an",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    output,
  ];
}

type VisualWindowCache = {
  version: string;
  sha256: string;
  promptVersion: number;
  model: string;
  providerKey: string;
  identityKey: string;
  inputMode: string;
  sampleFps: number;
  window: VisualWindow;
  spans: VisualSpan[];
};

function cacheFile(cacheDir: string, window: VisualWindow): string {
  return join(cacheDir, `w-${window.start}-${window.end}.json`);
}

function parseWindowCache(
  raw: unknown,
  source: Source,
  window: VisualWindow,
  identityKey: string,
): VisualSpan[] | null {
  if (typeof raw !== "object" || raw === null) return null;
  const cache = raw as Partial<VisualWindowCache>;
  if (cache.version !== VISUAL_CACHE_VERSION) return null;
  if (cache.sha256 !== source.sha256) return null;
  if (cache.promptVersion !== VISUAL_PROMPT_VERSION) return null;
  // Identidade resolvida, nunca o default global: modelo/provedor/perfil
  // efetivos decidem o reuso, não a constante de fallback.
  if (cache.identityKey !== identityKey) return null;
  // Envelope antigo (vídeo mp4 ou outro fps) não vale como cache de frames.
  if (cache.inputMode !== "frames" || cache.sampleFps !== 1) return null;
  const bounds = cache.window;
  if (!bounds || bounds.start !== window.start || bounds.end !== window.end
    || bounds.fetchStart !== window.fetchStart) {
    return null;
  }
  if (!Array.isArray(cache.spans)) return null;
  // Mesmo hash sob outra fonte (relink): remapeia IDs como adaptAnalysis.
  const prefix = `${(cache.spans[0] as VisualSpan | undefined)?.sourceId ?? ""}:`;
  const remapped = (cache.spans as VisualSpan[]).map((span) => {
    if (span.sourceId === source.id) return span;
    const suffix = span.id.startsWith(prefix) ? span.id.slice(prefix.length) : span.id;
    return { ...span, id: `${source.id}:${suffix}`, sourceId: source.id };
  });
  return validateVisual(remapped, source);
}

/**
 * Monta a mensagem visual: prompt + rótulos por frame. Cada JPEG vem
 * etiquetado com o segundo da fonte e o local da janela, para que o
 * modelo responda em segundos locais sem somar a origem duas vezes.
 */
/**
 * Exportada para o ensaio isolado (scripts/visual-analysis-proof.ts), que
 * orquestra sparse/two-pass sem tocar o caminho de produção.
 */
export function frameMessage(
  frames: VisualFrame[],
  window: VisualWindow,
  profile: VisualProfile,
  promptOverride?: string,
): unknown[] {
  const prompt = promptOverride ?? (profile === "compact" ? VISUAL_PROMPT_COMPACT : VISUAL_PROMPT);
  return [
    {
      type: "text",
      text: prompt + "\n\n" +
        "intervalo solicitado na fonte: [" + window.start + ", " + window.end + ")\n" +
        "cada imagem abaixo está rotulada pelo segundo da fonte; " +
        "responda usando segundos locais da janela, de 0 a " +
        (window.end - window.fetchStart) + ".",
    },
    ...frames.flatMap((frame) => [
      {
        type: "text",
        text: "FRAME fonte=" + frame.sourceSecond +
          "s local=" + (frame.sourceSecond - window.fetchStart) + "s",
      },
      { type: "image_url", image_url: { url: frame.dataUrl } },
    ]),
  ];
}

/**
 * Janela concluída: cada segundo de [start, end) tem alguma evidência
 * (inclusive `unavailable` explícito). Cache parcial nunca vale como
 * janela concluída — a retomada solicita a janela de novo e conserva
 * o que já estava válido.
 */
const INTERVAL_EPS = 1e-9;

/**
 * O trecho novo substitui o anterior quando o redescreve por inteiro
 * (mesmo intervalo ou superconjunto). Posição na resposta nunca decide
 * substituição — só o intervalo efetivamente descrito.
 */
function coversInterval(fresh: VisualSpan, prev: VisualSpan): boolean {
  return fresh.start <= prev.start + INTERVAL_EPS && prev.end <= fresh.end + INTERVAL_EPS;
}

/** Mesma ordem de mergeAdjacent, sem fundir: para o retorno compact. */
function compareSpans(a: VisualSpan, b: VisualSpan): number {
  return a.start - b.start || a.end - b.end;
}

function uniqueSpanId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let n = 1;
  while (taken.has(`${base}~${n}`)) n += 1;
  return `${base}~${n}`;
}

function windowCovered(spans: VisualSpan[], window: VisualWindow): boolean {
  const clipped = spans
    .map((span) => ({ start: Math.max(span.start, window.start), end: Math.min(span.end, window.end) }))
    .filter((range) => range.start < range.end);
  for (let start = window.start; start < window.end; start += 1) {
    const end = Math.min(start + 1, window.end);
    if (!clipped.some((range) => range.start < end && start < range.end)) return false;
  }
  return true;
}

/**
 * Exportada para o ensaio isolado (scripts/visual-analysis-proof.ts), que
 * orquestra sparse/two-pass sem tocar o caminho de produção.
 */
export function parseLocalSpans(text: string, source: Source, window: VisualWindow, profile: VisualProfile): VisualSpan[] {
  const payload = parseModelJson(text) as { spans?: unknown };
  const rawSpans = Array.isArray(payload.spans) ? payload.spans : [];
  // Spans são inferidos de frames timestampados: valida os limites locais
  // ANTES de somar fetchStart — uma única soma.
  const local = validateVisual(
    rawSpans.map((span) => {
      const rec = (span && typeof span === "object") ? span as Record<string, unknown> : {};
      return { ...rec, sourceId: source.id };
    }),
    { ...source, durationSeconds: window.end - window.fetchStart },
  );
  const converted = local
    .map((span) => ({
      ...span,
      start: span.start + window.fetchStart,
      end: span.end + window.fetchStart,
    }))
    .map((span) => ({
      ...span,
      start: Math.max(span.start, window.start),
      end: Math.min(span.end, window.end),
    }))
    .filter((span) => span.end > span.start);
  const cells = profile === "compact" ? normalizeCompactSpans(converted) : converted;
  const placed = cells.map((span, i) => ({ ...span, id: `${source.id}:w${window.start}:${i}` }));
  return validateVisual(placed, source);
}

export async function describeSource(
  source: Source,
  dir: string,
  signal: AbortSignal,
  deps?: DescribeDeps,
): Promise<VisualSpan[]> {
  if (!source.hasVideo) return [];
  if (source.durationSeconds <= 0) throw new Error(`fonte ${source.id} sem duração para descrever`);
  const stored = await readCredentials(dir).catch(() => null);
  const client = deps?.client ?? createAnalysisClient({ stored });
  const exec = deps?.exec ?? new SpawnExecutor();
  const profile = deps?.profile ?? "baseline";
  // Cliente padrão: identidade resolvida das mesmas entradas do transporte
  // (segunda resolução pura, sem rede); não se reaproveita o objeto para
  // não arrastar `who`/provedor e mudar as mensagens de erro do transporte.
  const configIdentity = deps?.client
    ? clientConfigIdentity(deps.client)
    : transportConfigIdentity(analysisClientOptions({ stored }));
  const identityKey = configIdentity ? visualIdentityKey(configIdentity, profile) : null;
  const baseCacheDir = analysisCacheDir(dir, source.sha256);
  // Hash no diretório: separa configurações e invalida caches antigos sem
  // migração; sem identidade, só rascunho efêmero (removido no finally).
  const cacheDir = identityKey ? join(baseCacheDir, `${VISUAL_CACHE_VERSION}-${identityKey}`) : baseCacheDir;
  await mkdir(cacheDir, { recursive: true });

  if (signal.aborted) throw new Error("descrição visual cancelada");
  const pool = deps?.pools ?? (deps?.ffmpegLimit != null || deps?.networkLimit != null
    ? createVisualPools({
      ffmpegLimit: deps.ffmpegLimit ?? 2,
      networkLimit: deps.networkLimit ?? 2,
    })
    : sharedVisualPools());
  const windows = visualWindows(source.durationSeconds);
  const collected: VisualSpan[][] = Array.from({ length: windows.length }, () => []);
  let firstError: unknown;
  await pool.mapWindows(windows, async (window, index) => {
    try {
      collected[index] = await describeWindow(window);
    } catch (error) {
      firstError ??= error;
    }
  }, { signal });
  if (firstError) throw firstError instanceof Error ? firstError : new Error(String(firstError));
  // Compact não funde: unir recém-fatiados destruiria os candidatos internos.
  // Ordena sem fundir, pois as janelas concluem em paralelo.
  return profile === "compact"
    ? collected.flat().sort(compareSpans)
    : mergeAdjacent(collected.flat());

  async function describeWindow(window: ReturnType<typeof visualWindows>[number]): Promise<VisualSpan[]> {
    const now = deps?.now ?? (() => performance.now());
    const windowStart = now();
    let frameCount = 0;
    let attempts = 0;
    let outcome: VisualMetric["outcome"] = "ok";
    const emit = (partial: Pick<VisualMetric, "phase" | "outcome" | "elapsedMs" | "queueMs" | "attempt">): void => {
      const onMetric = deps?.onMetric;
      if (!onMetric) return;
      try {
        onMetric({
          sourceId: source.id,
          windowStart: window.start,
          windowEnd: window.end,
          frames: frameCount,
          ...partial,
        });
      } catch {
        // Observabilidade nunca derruba a análise.
      }
    };
    try {
      if (signal.aborted) throw new Error("descrição visual cancelada");
      const file = cacheFile(cacheDir, window);
      let previous: VisualSpan[] = [];
      if (identityKey) {
        try {
          const cached = parseWindowCache(JSON.parse(await readFile(file, "utf8")), source, window, identityKey);
          if (cached && windowCovered(cached, window)) {
            outcome = "cache-hit";
            return cached;
          }
          previous = cached ?? [];
        } catch {
          // cache miss ou inválido: processa a janela
        }
      }
      const extractQueued = now();
      let extractStarted = extractQueued;
      let frames: VisualFrame[];
      try {
        frames = await pool.encode(async () => {
          extractStarted = now();
          return extractVisualFrames(source, window, exec, { signal });
        }, { signal });
        frameCount = frames.length;
        emit({
          phase: "extract", outcome: "ok",
          elapsedMs: now() - extractStarted, queueMs: extractStarted - extractQueued, attempt: 0,
        });
      } catch (error) {
        emit({
          phase: "extract", outcome: signal.aborted ? "cancelled" : "error",
          elapsedMs: now() - extractStarted, queueMs: extractStarted - extractQueued, attempt: 0,
        });
        throw error;
      }
      if (signal.aborted) throw new Error("descrição visual cancelada");
      const fresh = await requestValidated(frameMessage(frames, window, profile), async (content, requestSignal) => {
        const queued = now();
        const attempt = ++attempts;
        const text = await pool.request(async () => {
          const started = now();
          try {
            const response = await client.send(content, requestSignal);
            emit({
              phase: "request", outcome: "ok",
              elapsedMs: now() - started, queueMs: started - queued, attempt,
            });
            return response;
          } catch (error) {
            emit({
              phase: "request", outcome: requestSignal?.aborted ? "cancelled" : "error",
              elapsedMs: now() - started, queueMs: started - queued, attempt,
            });
            throw error;
          }
        }, { signal: requestSignal });
        if (deps?.isCurrent && !deps.isCurrent()) throw new Error("descrição visual obsoleta");
        return text;
      }, (text) => parseLocalSpans(text, source, window, profile), signal);
      signal.throwIfAborted();
      if (deps?.isCurrent && !deps.isCurrent()) throw new Error("descrição visual obsoleta");
      const kept = previous.filter((prev) => !fresh.some((f) => coversInterval(f, prev)));
      const taken = new Set(kept.map((span) => span.id));
      const placed = fresh.map((span) => {
        const id = uniqueSpanId(span.id, taken);
        taken.add(id);
        return id === span.id ? span : { ...span, id };
      });
      const merged = profile === "compact"
        ? [...kept, ...placed].sort(compareSpans)
        : mergeAdjacent([...kept, ...placed]);
      if (identityKey && configIdentity) {
        const envelope: VisualWindowCache = {
          version: VISUAL_CACHE_VERSION,
          sha256: source.sha256,
          promptVersion: VISUAL_PROMPT_VERSION,
          model: configIdentity.model,
          providerKey: configIdentity.providerKey,
          identityKey,
          inputMode: "frames",
          sampleFps: 1,
          window,
          spans: merged,
        };
        const tmp = `${file}.${randomUUID()}.tmp`;
        await writeFile(tmp, `${JSON.stringify(envelope)}\n`, "utf8");
        await rename(tmp, file);
      }
      return merged;
    } catch (error) {
      outcome = signal.aborted ? "cancelled" : "error";
      throw error;
    } finally {
      // Total da janela: wall desta janela, nunca soma de paralelas.
      emit({
        phase: "total", outcome,
        elapsedMs: now() - windowStart, queueMs: 0, attempt: attempts,
      });
    }
  }
}
