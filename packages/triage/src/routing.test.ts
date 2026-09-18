import { describe, expect, it } from "vitest";
import { collectSink, createTracer } from "@decupa/trace";
import { TypeSafeHttpError } from "@decupa/typesafe";
import { CircuitBreaker, routeTriage, type FastDecision } from "./routing.ts";
import { mechanicalKeepList } from "./mechanical.ts";
import { parseSpeechIndex, type SpeechIndex } from "./speech-index.ts";
import { FakeTriageModel } from "./model.ts";
import { buildUnitsBlock } from "./prompt.ts";
import type { StructureClaim } from "./claims.ts";

function index(): SpeechIndex {
  return parseSpeechIndex({
    source_duration: 9,
    budget: { lossless_floor_seconds: 4 },
    topic_runs: [{ keyword: "tema", unit_ids: ["u002"] }],
    trim_candidates: [],
    units: [
      { id: "u001", index: 0, start: 0, end: 2, duration: 2, text: "Tá gravando?", has_terminal_punct: true, word_count: 2 },
      { id: "u002", index: 1, start: 3, end: 5, duration: 2, text: "O gancho do vídeo começa aqui.", has_terminal_punct: true, word_count: 6 },
      { id: "u003", index: 2, start: 6, end: 8, duration: 2, text: "Ficou bom?", has_terminal_punct: true, word_count: 2, is_question: true },
    ],
  });
}

function protectedIndex(): SpeechIndex {
  return parseSpeechIndex({
    source_duration: 9,
    budget: { lossless_floor_seconds: 4 },
    topic_runs: [{ keyword: "tema", unit_ids: ["u001", "u002", "u003"] }],
    trim_candidates: [],
    units: [
      { id: "u001", index: 0, start: 0, end: 2, duration: 2, text: "Isso não vale para quem já pagou.", has_terminal_punct: true, word_count: 7 },
      { id: "u002", index: 1, start: 3, end: 5, duration: 2, text: "Foram 15 minutos de espera.", has_terminal_punct: true, word_count: 5 },
      { id: "u003", index: 2, start: 6, end: 8, duration: 2, text: "Funciona, mas só depois do login.", has_terminal_punct: true, word_count: 6 },
    ],
  });
}

const preroll: StructureClaim = {
  unit_ids: ["u001"],
  reason: "preroll",
  restated_by: null,
  note: "legado",
  source: "model",
};

describe("routeTriage", () => {
  it("off reproduz o keep-list legado", async () => {
    const speech = index();
    const model = new FakeTriageModel([preroll]);
    const result = await routeTriage({
      mode: "off",
      index: speech,
      model,
      unitsBlock: buildUnitsBlock(speech),
      videoPath: "clip.mp4",
    });
    expect(result.keepList).toBe(mechanicalKeepList(speech));
    expect(model.calls.filter((c) => c.kind === "structure")).toHaveLength(1);
    expect(model.calls.filter((c) => c.kind === "inspect")).toHaveLength(0);
  });

  it("hybrid com fonte resolvida faz 0 structure; não resolvida faz 1", async () => {
    const speech = index();
    const resolved = new FakeTriageModel([preroll]);
    const fast: FastDecision = { applyIds: ["prefix:u001"] };
    const hit = await routeTriage({
      mode: "hybrid",
      index: speech,
      model: resolved,
      unitsBlock: buildUnitsBlock(speech),
      videoPath: "clip.mp4",
      decide: () => fast,
    });
    expect(resolved.calls.filter((c) => c.kind === "structure")).toHaveLength(0);
    expect(hit.source).toBe("fast");
    expect(hit.keepList).toBe(mechanicalKeepList(speech));

    const unresolved = new FakeTriageModel([preroll]);
    const miss = await routeTriage({
      mode: "hybrid",
      index: speech,
      model: unresolved,
      unitsBlock: buildUnitsBlock(speech),
      videoPath: "clip.mp4",
      decide: () => null,
    });
    expect(unresolved.calls.filter((c) => c.kind === "structure")).toHaveLength(1);
    expect(miss.source).toBe("fallback");
  });

  it("claims reconstruídas passam nos validadores e protegidos nunca saem", async () => {
    const speech = protectedIndex();
    const model = new FakeTriageModel([]);
    const result = await routeTriage({
      mode: "hybrid",
      index: speech,
      model,
      decide: (catalog) => ({ applyIds: catalog.candidates.map((c) => c.id) }),
    });
    expect(result.verdicts.filter((v) => !v.accepted)).toEqual([]);
    expect(result.keepList).toBe(mechanicalKeepList(speech));
    expect(result.keepList).toBe("u001-u003");
    expect(model.calls.filter((c) => c.kind === "structure")).toHaveLength(0);
  });

  it("circuit breaker em indisponibilidade cai no legado uma vez", async () => {
    const speech = index();
    const model = new FakeTriageModel([preroll]);
    const circuit = new CircuitBreaker({ threshold: 1 });
    const result = await routeTriage({
      mode: "hybrid",
      index: speech,
      model,
      unitsBlock: buildUnitsBlock(speech),
      videoPath: "clip.mp4",
      circuit,
      decide: () => {
        throw new TypeSafeHttpError(429, "rate limited");
      },
    });
    expect(circuit.open).toBe(true);
    expect(model.calls.filter((c) => c.kind === "structure")).toHaveLength(1);
    expect(result.source).toBe("fallback");
    expect(result.circuitOpen).toBe(true);

    const again = new FakeTriageModel([preroll]);
    const skipped = await routeTriage({
      mode: "hybrid",
      index: speech,
      model: again,
      unitsBlock: buildUnitsBlock(speech),
      videoPath: "clip.mp4",
      circuit,
      decide: () => {
        throw new Error("não deveria chamar TypeSafe com circuito aberto");
      },
    });
    expect(again.calls.filter((c) => c.kind === "structure")).toHaveLength(1);
    expect(skipped.source).toBe("fallback");
  });

  it("tempo total da rota é o da substituição, não a soma com o legado", async () => {
    const speech = index();
    const sink = collectSink();
    const tracer = createTracer(sink);
    const clock = { t: 1_000 };
    const result = await routeTriage({
      mode: "hybrid",
      index: speech,
      model: new FakeTriageModel([preroll]),
      tracer,
      now: () => clock.t,
      decide: async () => {
        clock.t += 40;
        return { applyIds: ["prefix:u001"] };
      },
    });
    expect(result.elapsedMs).toBe(40);
    expect(result.structureCalls).toBe(0);
    const finished = sink.events.find((e) => e.stage === "route" && e.phase === "finished");
    expect(finished?.category).toBe("ok");
  });

  it("observe consulta a rota rápida mas aplica o legado uma vez", async () => {
    const speech = index();
    const model = new FakeTriageModel([preroll]);
    let decideCalls = 0;
    const result = await routeTriage({
      mode: "observe",
      index: speech,
      model,
      unitsBlock: buildUnitsBlock(speech),
      videoPath: "clip.mp4",
      decide: () => {
        decideCalls += 1;
        return { applyIds: ["prefix:u001"] };
      },
    });
    expect(decideCalls).toBe(1);
    expect(model.calls.filter((c) => c.kind === "structure")).toHaveLength(1);
    expect(result.source).toBe("legacy");
    expect(result.structureCalls).toBe(1);
    expect(result.keepList).toBe(mechanicalKeepList(speech));
  });
});
