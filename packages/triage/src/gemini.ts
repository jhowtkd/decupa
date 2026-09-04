import { GoogleGenAI } from "@google/genai";
import type { StructureClaim } from "./claims.ts";
import type { DensityCandidate, DensityRequest, StructureRequest, TriageModel } from "./model.ts";
import { DENSITY_INSTRUCTIONS } from "./density.ts";
import { STRUCTURE_INSTRUCTIONS } from "./prompt.ts";

export const DEFAULT_MODEL = "gemini-3.8-flash";

const STRUCTURE_SCHEMA = {
  type: "object",
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: {
          unit_ids: { type: "array", items: { type: "string" } },
          reason: { type: "string", enum: ["preroll", "postroll", "aside", "restart_block"] },
          restated_by: { type: "string", nullable: true },
          note: { type: "string" },
        },
        required: ["unit_ids", "reason", "note"],
      },
    },
  },
  required: ["claims"],
} as const;

const DENSITY_SCHEMA = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          unit_ids: { type: "array", items: { type: "string" } },
          note: { type: "string" },
          rank: { type: "integer" },
        },
        required: ["unit_ids", "note", "rank"],
      },
    },
  },
  required: ["candidates"],
} as const;

export class GeminiTriageModel implements TriageModel {
  private readonly client: GoogleGenAI;
  private readonly model: string;
  private uploaded: { uri: string; mimeType: string } | null = null;

  constructor(model: string = DEFAULT_MODEL, apiKey = process.env.GEMINI_API_KEY) {
    if (!apiKey) {
      throw new Error(
        "GEMINI_API_KEY não está setada. A triagem precisa dela para ler o vídeo. " +
        "Sem a chave, monte o keep-list na mão e passe direto pro `condense.py plan`.",
      );
    }
    this.model = model;
    this.client = new GoogleGenAI({ apiKey });
  }

  /** Sobe o vídeo uma vez só e reusa entre os dois passes. */
  private async video(path: string): Promise<{ uri: string; mimeType: string }> {
    if (this.uploaded) return this.uploaded;
    let file = await this.client.files.upload({ file: path });
    const stateOf = (f: { state?: unknown }) =>
      typeof f.state === "object" && f.state !== null && "name" in f.state
        ? (f.state as { name: string }).name
        : f.state;

    const MAX_ATTEMPTS = 60; // 60 * 5s = 5 minutos
    let attempts = 0;
    while (stateOf(file) !== "ACTIVE") {
      if (stateOf(file) === "FAILED") throw new Error(`o Gemini falhou ao processar ${path}`);
      if (++attempts >= MAX_ATTEMPTS) {
        throw new Error("tempo limite excedido aguardando processamento do vídeo no Gemini");
      }
      await new Promise((r) => setTimeout(r, 5000));
      file = await this.client.files.get({ name: file.name! });
    }
    this.uploaded = { uri: file.uri!, mimeType: file.mimeType! };
    return this.uploaded;
  }

  private async ask<T>(videoPath: string, instructions: string, text: string, schema: unknown, key: string): Promise<T[]> {
    const video = await this.video(videoPath);
    const interaction = await this.client.interactions.create({
      model: this.model,
      input: [
        // O SDK @google/genai utiliza a string "agentic" diretamente (ProcessingEnum = "static" | "agentic" | string),
        // em vez de um objeto { type: "agentic" }.
        { type: "video", uri: video.uri, mime_type: video.mimeType, processing: "agentic" },
        { type: "text", text: `${instructions}\n\n---\n\n${text}` },
      ],
      response_format: { type: "text", mime_type: "application/json", schema: schema as Record<string, unknown> },
      generation_config: {
        seed: 0,
      },
    });
    const parsed = JSON.parse(interaction.output_text ?? "{}") as Record<string, T[]>;
    return parsed[key] ?? [];
  }

  async structure(req: StructureRequest): Promise<StructureClaim[]> {
    const claims = await this.ask<StructureClaim>(
      req.videoPath, STRUCTURE_INSTRUCTIONS, req.unitsBlock, STRUCTURE_SCHEMA, "claims",
    );
    // `restated_by` é opcional no schema; normalizar para o que claims.ts espera.
    return claims.map((c) => ({ ...c, restated_by: c.restated_by ?? null }));
  }

  async density(req: DensityRequest): Promise<DensityCandidate[]> {
    return this.ask<DensityCandidate>(
      req.videoPath,
      `${DENSITY_INSTRUCTIONS}\n\nOrçamento: ${req.budgetSeconds.toFixed(1)} segundos.`,
      req.unitsBlock, DENSITY_SCHEMA, "candidates",
    );
  }
}
