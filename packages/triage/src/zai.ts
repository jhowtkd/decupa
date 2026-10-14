import { readFile } from "node:fs/promises";
import type { StructureClaim } from "./claims.ts";
import { DENSITY_INSTRUCTIONS } from "./density.ts";
import { normalizeInspectVerdict } from "./inspect.ts";
import type {
  DensityCandidate, DensityRequest, InspectRequest, InspectVerdict,
  StructureRequest, TriageModel,
} from "./model.ts";
import { INSPECT_INSTRUCTIONS, STRUCTURE_INSTRUCTIONS } from "./prompt.ts";
import { ZaiClient } from "./zai-client.ts";
import type { ZaiUsage } from "./zai-client.ts";

export {
  isRetryable,
  readChoice,
  ZAI_DEFAULT_BASE,
  ZAI_DEFAULT_MODEL,
  ZaiClient,
} from "./zai-client.ts";
export type { ZaiClientOptions, ZaiUsage } from "./zai-client.ts";

const STRUCTURE_SHAPE = `Responda com um objeto JSON desta forma exata:

{"claims": [
  {"unit_ids": ["u001","u002"], "reason": "preroll", "restated_by": null, "note": "por que isto não é o vídeo"}
]}

"reason" só pode ser um destes: "preroll", "postroll", "aside", "restart_block", "retake", "dead_air", "director_cue".
"restated_by" é null exceto em "restart_block" e "retake". Se nada se encaixar, "claims" é [].`;

const DENSITY_SHAPE = `Responda com um objeto JSON desta forma exata:

{"candidates": [
  {"unit_ids": ["u019"], "note": "por que esta pode sair", "rank": 1}
]}

"rank" é inteiro; 1 sai primeiro. Se nada puder sair, "candidates" é [].`;

const INSPECT_SHAPE = `Responda com um objeto JSON desta forma exata:

{"unitId": "u001", "decision": "unsure", "note": "por que drop, keep ou unsure"}

"decision" só pode ser "drop", "keep" ou "unsure". Nunca devolva tempo.`;

function parseJsonPayload(text: string): Record<string, unknown> {
  const unfenced = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(unfenced) as Record<string, unknown>;
  } catch {
    throw new Error(`a resposta do modelo não é JSON: ${text.slice(0, 200)}`);
  }
}

/**
 * A lista que a forma pede, ou erro. `{}` ou uma chave trocada viravam lista
 * vazia, e a lista vazia ia para o cache como "o modelo não achou nada".
 * Itens que não servem saem; se nenhum servir, a resposta inteira não serve.
 */
function listField(payload: Record<string, unknown>, key: string, text: string): unknown[] {
  const list = payload[key];
  if (!Array.isArray(list)) {
    throw new Error(`a resposta do modelo não tem a lista \`${key}\`: ${text.slice(0, 200)}`);
  }
  return list;
}

function usableItems(list: unknown[], key: string, text: string): any[] {
  const usable = list.filter((c: any) => Array.isArray(c?.unit_ids) && c.unit_ids.length > 0);
  if (list.length > 0 && usable.length === 0) {
    throw new Error(`nenhum item de \`${key}\` na resposta do modelo tem \`unit_ids\`: ${text.slice(0, 200)}`);
  }
  return usable;
}

export function parseStructureClaims(text: string): StructureClaim[] {
  const payload = parseJsonPayload(text);
  const claims = listField(payload, "claims", text);

  return usableItems(claims, "claims", text)
    .map((c: any) => ({
      unit_ids: c.unit_ids.map(String),
      reason: c.reason,
      restated_by: c.restated_by ?? null,
      note: String(c.note ?? ""),
      source: c.source === "mechanical" || c.source === "visual" ? c.source : "model",
    }));
}

export function parseInspectVerdict(text: string, unitId: string): InspectVerdict {
  return normalizeInspectVerdict(parseJsonPayload(text), unitId);
}

export function parseDensityCandidates(text: string): DensityCandidate[] {
  const payload = parseJsonPayload(text);
  const candidates = listField(payload, "candidates", text);

  return usableItems(candidates, "candidates", text)
    .map((c: any) => {
      const rank = Number(c.rank);
      return {
        unit_ids: c.unit_ids.map(String),
        note: String(c.note ?? ""),
        rank: Number.isFinite(rank) ? rank : Number.MAX_SAFE_INTEGER,
      };
    });
}

/**
 * Teto do vídeo em base64 numa chamada. Medido na Z.ai: 2,2 MB passou e
 * 14,9 MB falhou com "internal network failure"; acima de ~5 MB o erro
 * genérico já aparecia. Vídeo maior é triado em janelas (apps/cli/src/triage.ts).
 */
export const MAX_VIDEO_PAYLOAD_BYTES = 5 * 1024 * 1024;

/** Tamanho em base64 de um arquivo de `bytes` bytes. */
export function base64Bytes(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

export class ZaiTriageModel implements TriageModel {
  private readonly client: ZaiClient;
  private readonly inspectClient: { send(content: unknown[], signal?: AbortSignal): Promise<string>; usage?: () => ZaiUsage };
  private readonly inspectSignal?: AbortSignal;
  /** Por caminho: com janelas, cada trecho é um vídeo diferente. */
  private video: { path: string; dataUrl: string } | null = null;

  constructor(opts: ConstructorParameters<typeof ZaiClient>[0] & {
    visualClient?: { send(content: unknown[], signal?: AbortSignal): Promise<string>; usage?: () => ZaiUsage };
    signal?: AbortSignal;
  } = {}) {
    this.client = new ZaiClient(opts);
    this.inspectClient = opts.visualClient ?? this.client;
    this.inspectSignal = opts.signal;
  }

  private async videoDataUrl(path: string): Promise<string> {
    if (this.video?.path === path) return this.video.dataUrl;
    const bytes = await readFile(path);
    const base64 = bytes.toString("base64");
    // Recusa antes de pagar: a chamada com payload acima do teto falha no
    // provedor com erro genérico, depois de cobrada.
    if (base64.length > MAX_VIDEO_PAYLOAD_BYTES) {
      throw new Error(
        `o vídeo da triagem virou ${(base64.length / 1024 / 1024).toFixed(1)} MB em base64, acima do teto de ` +
        `${(MAX_VIDEO_PAYLOAD_BYTES / 1024 / 1024).toFixed(0)} MB por chamada; a chamada não foi feita. ` +
        "Gere um proxy mais leve com `-vf fps=1,scale='min(270,iw)':'min(480,ih)':force_original_aspect_ratio=decrease -crf 32`.",
      );
    }
    const dataUrl = `data:video/mp4;base64,${base64}`;
    this.video = { path, dataUrl };
    return dataUrl;
  }

  private async ask(videoPath: string, instructions: string, text: string): Promise<string> {
    // O teto de payload já foi conferido em `videoDataUrl`, antes de pagar.
    const dataUrl = await this.videoDataUrl(videoPath);
    return this.client.send([
      { type: "video_url", video_url: { url: dataUrl } },
      { type: "text", text: `${instructions}\n\n---\n\n${text}` },
    ]);
  }

  usage() {
    const text = this.client.usage();
    if (this.inspectClient === this.client || !this.inspectClient.usage) return text;
    const visual = this.inspectClient.usage();
    return Object.fromEntries(Object.entries(text).map(([key, value]) => [key, value + visual[key as keyof ZaiUsage]])) as unknown as ZaiUsage;
  }

  async structure(req: StructureRequest): Promise<StructureClaim[]> {
    return parseStructureClaims(
      await this.ask(req.videoPath, `${STRUCTURE_INSTRUCTIONS}\n\n${STRUCTURE_SHAPE}`, req.unitsBlock),
    );
  }

  async density(req: DensityRequest): Promise<DensityCandidate[]> {
    return parseDensityCandidates(
      await this.ask(
        req.videoPath,
        `${DENSITY_INSTRUCTIONS}\n\nOrçamento: ${req.budgetSeconds.toFixed(1)} segundos.\n\n${DENSITY_SHAPE}`,
        req.unitsBlock,
      ),
    );
  }

  async inspect(req: InspectRequest): Promise<InspectVerdict> {
    const images: { type: "image_url"; image_url: { url: string } }[] = [];
    for (const frame of req.frames) {
      const bytes = await readFile(frame);
      images.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${bytes.toString("base64")}` },
      });
    }
    const text = await this.inspectClient.send([
      ...images,
      { type: "text", text: `${INSPECT_INSTRUCTIONS}\n\n${INSPECT_SHAPE}\n\n---\n\nunidade: ${req.unitId}` },
    ], this.inspectSignal);
    return parseInspectVerdict(text, req.unitId);
  }
}
