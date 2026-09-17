import { describe, expect, it } from "vitest";
import { collectSink, createTracer } from "@decupa/trace";
import { buildEditCatalog, groupIndependentQuestions } from "./catalog.ts";
import { parseSpeechIndex, type SpeechIndex } from "./speech-index.ts";

function index(opts: {
  units: Array<{
    id: string;
    text: string;
    speaker?: string | null;
    lead_gap?: number;
    is_question?: boolean;
    near_duplicate_of?: string;
    similarity?: number;
  }>;
  topic?: string[];
  trim?: Array<{ id: string; reasons: string[] }>;
}): SpeechIndex {
  return parseSpeechIndex({
    source_duration: opts.units.length * 3,
    budget: { lossless_floor_seconds: 4 },
    topic_runs: [{ keyword: "tema", unit_ids: opts.topic ?? opts.units.map((u) => u.id) }],
    trim_candidates: (opts.trim ?? []).map((t) => ({
      id: t.id,
      seconds: 2,
      text: "",
      reasons: t.reasons,
    })),
    units: opts.units.map((u, i) => ({
      id: u.id,
      index: i,
      start: i * 3,
      end: i * 3 + 2,
      duration: 2,
      text: u.text,
      has_terminal_punct: true,
      word_count: u.text.split(/\s+/).length,
      speaker: u.speaker ?? null,
      lead_gap: u.lead_gap ?? 0.2,
      is_question: u.is_question ?? false,
      near_duplicate_of: u.near_duplicate_of,
      similarity: u.similarity,
    })),
  });
}

function kinds(catalog: Awaited<ReturnType<typeof buildEditCatalog>>) {
  return catalog.candidates.map((c) => `${c.kind}:${c.unitIds.join("+")}`);
}

describe("buildEditCatalog — casos", () => {
  it("emite prefixo e sufixo a partir das heurísticas de pré/pós-rolo", async () => {
    const catalog = await buildEditCatalog(index({
      units: [
        { id: "u001", text: "Tá gravando?" },
        { id: "u002", text: "O gancho do vídeo começa aqui." },
        { id: "u003", text: "Ficou bom?" },
      ],
      topic: ["u002"],
    }));
    expect(kinds(catalog)).toEqual(expect.arrayContaining([
      "prefix:u001",
      "suffix:u003",
    ]));
  });

  it("emite retomada com replacement no take que fica", async () => {
    const catalog = await buildEditCatalog(index({
      units: [
        { id: "u001", text: "Agora vai." },
        { id: "u002", text: "Agora vai.", near_duplicate_of: "u001", similarity: 0.99 },
        { id: "u003", text: "Dicas pra você parar de ser chatão nas redes sociais." },
      ],
      topic: ["u003"],
    }));
    const retake = catalog.candidates.find((c) => c.kind === "retake");
    expect(retake?.unitIds).toEqual(["u001"]);
    expect(retake?.replacement).toBe("u002");
  });

  it("marca negação, número e ressalva como proteções", async () => {
    const catalog = await buildEditCatalog(index({
      units: [
        { id: "u001", text: "Isso não vale para quem já pagou." },
        { id: "u002", text: "Foram 15 minutos de espera." },
        { id: "u003", text: "Funciona, mas só depois do login." },
      ],
    }));
    expect(catalog.candidates.some((c) => c.kind === "negation" && c.unitIds.includes("u001") && c.protected)).toBe(true);
    expect(catalog.candidates.some((c) => c.kind === "number" && c.unitIds.includes("u002") && c.protected)).toBe(true);
    expect(catalog.candidates.some((c) => c.kind === "caveat" && c.unitIds.includes("u003") && c.protected)).toBe(true);
  });

  it("protege abertura, conclusão e pergunta", async () => {
    const catalog = await buildEditCatalog(index({
      units: [
        { id: "u001", text: "Hoje eu explico o recorte." },
        { id: "u002", text: "Por que isso importa?" , is_question: true },
        { id: "u003", text: "É isso, até a próxima." },
      ],
    }));
    const protectedIds = catalog.candidates.filter((c) => c.kind === "protection").flatMap((c) => c.unitIds);
    expect(protectedIds).toEqual(expect.arrayContaining(["u001", "u002", "u003"]));
  });

  it("marca troca de locutor sem inventar timestamp", async () => {
    const catalog = await buildEditCatalog(index({
      units: [
        { id: "u001", text: "Eu começo.", speaker: "a" },
        { id: "u002", text: "Eu respondo.", speaker: "b" },
        { id: "u003", text: "Eu continuo.", speaker: "b" },
      ],
    }));
    const change = catalog.candidates.find((c) => c.kind === "speaker_change");
    expect(change?.unitIds).toEqual(["u001", "u002"]);
    expect(change).not.toHaveProperty("start");
    expect(JSON.stringify(change)).not.toMatch(/\d+\.\d+/);
  });

  it("marca lacuna a partir do lead_gap já medido no índice", async () => {
    const catalog = await buildEditCatalog(index({
      units: [
        { id: "u001", text: "Primeiro ponto.", lead_gap: 0.2 },
        { id: "u002", text: "Depois de um silêncio longo.", lead_gap: 4.5 },
      ],
    }));
    expect(catalog.candidates.some((c) => c.kind === "gap" && c.unitIds.includes("u002"))).toBe(true);
  });
});

describe("buildEditCatalog — invariantes", () => {
  it("só cita unitIds conhecidos e replacement que não foi descartado", async () => {
    const catalog = await buildEditCatalog(index({
      units: [
        { id: "u001", text: "Agora vai." },
        { id: "u002", text: "Agora vai.", near_duplicate_of: "u001", similarity: 0.99 },
        { id: "u003", text: "calma aí" },
        { id: "u004", text: "Dicas pra você parar de ser chatão nas redes sociais." },
      ],
      topic: ["u004"],
      trim: [{ id: "u002", reasons: ["very slow (1.1 chars/s) — dead air inside the sentence"] }],
    }), { alreadyDropped: new Set(["u002"]) });
    const known = new Set(["u001", "u002", "u003", "u004"]);
    for (const c of catalog.candidates) {
      expect(c.unitIds.every((id) => known.has(id))).toBe(true);
      if (c.replacement) {
        expect(known.has(c.replacement)).toBe(true);
        expect(c.replacement).not.toBe("u002");
      }
    }
    expect(catalog.candidates.some((c) => c.kind === "retake" && c.replacement === "u002")).toBe(false);
  });

  it("ausência de candidato não equivale a fonte limpa", async () => {
    const catalog = await buildEditCatalog(index({
      units: [{ id: "u001", text: "Só um recado curto." }],
    }));
    expect(catalog.sourceClean).toBe(false);
    expect(catalog.uncoveredUnitIds.length + catalog.coveredUnitIds.length).toBe(1);
  });

  it("agrupa perguntas independentes e gera IDs determinísticos", async () => {
    const input = index({
      units: [
        { id: "u001", text: "Tá gravando?" },
        { id: "u002", text: "Não faça isso em 2 passos, mas com calma.", speaker: "a" },
        { id: "u003", text: "Eu respondo depois.", speaker: "b", lead_gap: 3.2 },
        { id: "u004", text: "Ficou bom?" },
      ],
      topic: ["u002", "u003"],
    });
    const a = await buildEditCatalog(input);
    const b = await buildEditCatalog(input);
    expect(a.candidates.map((c) => c.id)).toEqual(b.candidates.map((c) => c.id));
    expect(new Set(a.candidates.map((c) => c.id)).size).toBe(a.candidates.length);
    const groups = groupIndependentQuestions(a);
    expect(groups.map((g) => g.group).sort()).toEqual(["boundary", "cut", "protect"].sort());
    for (const group of groups) {
      expect(group.candidateIds.length).toBeGreaterThan(0);
      expect(group.candidateIds).toEqual([...group.candidateIds].sort());
    }
  });

  it("traço do catálogo não leva texto privado", async () => {
    const sink = collectSink();
    const catalog = await buildEditCatalog(index({
      units: [{ id: "u001", text: "segredo da transcrição privada" }],
    }), { tracer: createTracer(sink) });
    expect(catalog.sourceClean).toBe(false);
    const blob = JSON.stringify(sink.events);
    expect(blob).not.toContain("segredo da transcrição");
    expect(sink.events.some((e) => e.stage === "catalog")).toBe(true);
  });
});
