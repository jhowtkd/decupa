import { readFile } from "node:fs/promises";
import type { StructureClaim } from "./claims.ts";
import { DENSITY_INSTRUCTIONS } from "./density.ts";
import type { DensityCandidate, DensityRequest, StructureRequest, TriageModel } from "./model.ts";
import { STRUCTURE_INSTRUCTIONS } from "./prompt.ts";

export const ZAI_DEFAULT_MODEL = "glm-5.3-flash";

/**
 * A Z.ai serve dois endpoints quase idênticos que cobram de formas diferentes:
 * `/api/paas/v4` é pay-as-you-go e precisa de crédito pré-carregado, enquanto
 * `/api/coding/paas/v4` é a assinatura do Coding Plan. Assinante que bate no
 * primeiro recebe `1113 — Insufficient balance`, que parece erro de conta
 * vazia e é erro de endereço.
 */
export const ZAI_DEFAULT_BASE = "https://api.z.ai/api/coding/paas/v4/chat/completions";

/**
 * O `thinking` deste modelo não pode ser desligado e consome orçamento antes de
 * qualquer resposta. Medido em 2026-09-04: 3000 caracteres de raciocínio para
 * 19 de resposta, numa pergunta trivial sobre um vídeo de 3 KB. Um teto
 * apertado devolve HTTP 200 com `content` vazio.
 */
const DEFAULT_MAX_TOKENS = 16000;

/**
 * `json_object` garante que a saída é JSON; não garante o formato. Sem
 * `json_schema` para impor o enum, o formato vai descrito no prompt — e o
 * enum é conferido depois, em `verifyClaims`, onde alegação com categoria
 * inventada cai como rejeitada e aparece no relatório.
 */
const STRUCTURE_SHAPE = `Responda com um objeto JSON desta forma exata:

{"claims": [
  {"unit_ids": ["u001","u002"], "reason": "preroll", "restated_by": null, "note": "por que isto não é o vídeo"}
]}

"reason" só pode ser um destes quatro: "preroll", "postroll", "aside", "restart_block".
"restated_by" é null exceto em "restart_block". Se nada se encaixar, "claims" é [].`;

const DENSITY_SHAPE = `Responda com um objeto JSON desta forma exata:

{"candidates": [
  {"unit_ids": ["u019"], "note": "por que esta pode sair", "rank": 1}
]}

"rank" é inteiro; 1 sai primeiro. Se nada puder sair, "candidates" é [].`;

/** Extrai o texto da resposta, ou estoura dizendo por que não deu. */
export function readChoice(raw: unknown): string {
  const body = raw as Record<string, any>;

  if (body?.error) {
    const { code, message } = body.error;
    throw new Error(`a Z.ai recusou a chamada (${code ?? "sem código"}): ${message ?? "sem mensagem"}`);
  }

  const choice = body?.choices?.[0];
  if (!choice) {
    throw new Error(`resposta da Z.ai sem \`choices\`: ${JSON.stringify(raw).slice(0, 200)}`);
  }

  const content: string = choice.message?.content ?? "";
  if (content.trim().length > 0) return content;

  // HTTP 200 com content vazio é o modo de falha perigoso: sem esta guarda o
  // adaptador devolveria zero alegações, a triagem manteria todas as unidades,
  // e o relatório diria "o modelo não reivindicou nada" — indistinguível de
  // uma análise que rodou e não achou problema.
  const reasoningChars = (choice.message?.reasoning_content ?? "").length;
  if (choice.finish_reason === "length") {
    throw new Error(
      `o modelo gastou o orçamento inteiro pensando (${reasoningChars} caracteres de raciocínio) ` +
      "e não sobrou resposta. Suba max_tokens.",
    );
  }
  throw new Error(
    `o modelo terminou com \`${choice.finish_reason}\` e devolveu resposta vazia ` +
    `(${reasoningChars} caracteres de raciocínio).`,
  );
}

/** Tira cerca de markdown, se houver, antes de parsear. */
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
      // `reason` passa como veio, mesmo fora do enum: filtrar aqui apagaria a
      // alegação em silêncio. Deixando passar, ela percorre a verificação
      // normal e aparece como rejeitada, que é onde você quer vê-la.
      reason: c.reason,
      restated_by: c.restated_by ?? null,
      note: String(c.note ?? ""),
      source: c.source === "mechanical" || c.source === "visual" ? c.source : "model",
    }));
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
        // Sem rank utilizável o candidato vai para o fim da fila. Number(NaN)
        // o colocaria em posição arbitrária no sort.
        rank: Number.isFinite(rank) ? rank : Number.MAX_SAFE_INTEGER,
      };
    });
}

export class ZaiTriageModel implements TriageModel {
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly maxTokens: number;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private videoDataUrl: string | null = null;

  constructor(opts: {
    model?: string;
    apiKey?: string;
    baseUrl?: string;
    maxTokens?: number;
    fetchImpl?: typeof fetch;
  } = {}) {
    const apiKey = opts.apiKey ?? process.env.ZAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ZAI_API_KEY não está setada. A triagem precisa dela para ler o vídeo. " +
        "Sem a chave, monte o keep-list na mão e passe direto pro `condense.py plan`.",
      );
    }
    this.apiKey = apiKey;
    this.model = opts.model ?? ZAI_DEFAULT_MODEL;
    this.baseUrl = opts.baseUrl ?? process.env.ZAI_BASE_URL ?? ZAI_DEFAULT_BASE;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Lê o vídeo do disco uma vez e reusa entre os dois passes. */
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
      return await this.post(dataUrl, instructions, text);
    } catch (err) {
      // Corpo grande demais chega como erro genérico do lado deles — medido em
      // 2026-09-04: 14,9 MB de base64 devolveu "1234 internal network
      // failure", enquanto 2,2 MB passou. Sem o tamanho junto da mensagem, a
      // correlação fica invisível e a pessoa investiga a rede.
      const hint = payloadMb > 5
        ? ` (o vídeo virou ${payloadMb.toFixed(1)} MB em base64 — corpo grande já causou erro genérico aqui; ` +
          "gere um proxy mais leve com `-vf fps=1,scale=270:480 -crf 32`)"
        : "";
      throw new Error(`${err instanceof Error ? err.message : String(err)}${hint}`);
    }
  }

  private async post(dataUrl: string, instructions: string, text: string): Promise<string> {
    const res = await this.fetchImpl(this.baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        messages: [{
          role: "user",
          content: [
            { type: "video_url", video_url: { url: dataUrl } },
            { type: "text", text: `${instructions}\n\n---\n\n${text}` },
          ],
        }],
        response_format: { type: "json_object" },
        max_tokens: this.maxTokens,
      }),
    });

    const raw = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`HTTP ${res.status} da Z.ai, corpo não-JSON: ${raw.slice(0, 200)}`);
    }
    // readChoice cobre o corpo de erro; o status entra no texto quando não há.
    if (!res.ok && !(parsed as any)?.error) {
      throw new Error(`HTTP ${res.status} da Z.ai: ${raw.slice(0, 200)}`);
    }
    return readChoice(parsed);
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
}
