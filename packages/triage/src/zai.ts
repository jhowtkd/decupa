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

export function parseStructureClaims(text: string): StructureClaim[] {
  const payload = parseJsonPayload(text);
  const claims = Array.isArray(payload.claims) ? payload.claims : [];

  return claims
    .filter((c: any) => Array.isArray(c?.unit_ids) && c.unit_ids.length > 0)
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
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];

  return candidates
    .filter((c: any) => Array.isArray(c?.unit_ids) && c.unit_ids.length > 0)
    .map((c: any) => {
      const rank = Number(c.rank);
      return {
        unit_ids: c.unit_ids.map(String),
        note: String(c.note ?? ""),
        rank: Number.isFinite(rank) ? rank : Number.MAX_SAFE_INTEGER,
      };
    });
}

export class ZaiTriageModel implements TriageModel {
  private readonly client: ZaiClient;
  private videoDataUrl: string | null = null;

  constructor(opts: ConstructorParameters<typeof ZaiClient>[0] = {}) {
    this.client = new ZaiClient(opts);
  }

  private async video(path: string): Promise<string> {
    if (this.videoDataUrl) return this.videoDataUrl;
    const bytes = await readFile(path);
    this.videoDataUrl = `data:video/mp4;base64,${bytes.toString("base64")}`;
    return this.videoDataUrl;
  }

  private async ask(videoPath: string, instructions: string, text: string): Promise<string> {
    const dataUrl = await this.video(videoPath);
    const payloadMb = (dataUrl.length * 3) / 4 / 1024 / 1024;
    try {
      return await this.client.send([
        { type: "video_url", video_url: { url: dataUrl } },
        { type: "text", text: `${instructions}\n\n---\n\n${text}` },
      ]);
    } catch (err) {
      const hint = payloadMb > 5
        ? ` (o vídeo virou ${payloadMb.toFixed(1)} MB em base64 — corpo grande já causou erro genérico aqui; ` +
          "gere um proxy mais leve com `-vf fps=1,scale=270:480 -crf 32`)"
        : "";
      throw new Error(`${err instanceof Error ? err.message : String(err)}${hint}`);
    }
  }

  usage() {
    return this.client.usage();
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
    const text = await this.client.send([
      ...images,
      { type: "text", text: `${INSPECT_INSTRUCTIONS}\n\n${INSPECT_SHAPE}\n\n---\n\nunidade: ${req.unitId}` },
    ]);
    return parseInspectVerdict(text, req.unitId);
  }
}
