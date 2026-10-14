import { describe, expect, it } from "vitest";
import {
  classifyFillers as classifyWithGap, FILLER_AUTO_CATEGORIES, FILLER_CATEGORIES, FILLER_MIN_GAP_SECONDS, isFillerAligned,
  normalizeFillerText, opensWithFillerAnswer, type FillerCategory, type FillerToken,
} from "./fillers.ts";

const all = new Set(FILLER_CATEGORIES);

// Os casos de regra usam a folga mais conservadora; os limites por fluxo
// são exercitados explicitamente nos testes de corredor.
const classifyFillers = (tokens: FillerToken[], auto: ReadonlySet<FillerCategory>) =>
  classifyWithGap(tokens, auto, FILLER_MIN_GAP_SECONDS.montagem);

function words(text: string, confidence: number | null = 1): FillerToken[] {
  const parts = text.split(" ");
  return parts.map((text, i) => ({
    wordId: `w${i}`, text, start: i + 0.1, end: i + 0.5,
    aligned: isFillerAligned(confidence), unitId: "u1", unitEndsWithQuestion: text.endsWith("?") || parts.at(-1)!.endsWith("?"),
    isLastInUnit: i === parts.length - 1, unitWordCount: parts.length,
    nextUnitOpensWithAnswer: false,
    separatorBefore: i ? (parts[i - 1]!.match(/[,.;!?]+$/)?.[0] ?? "") + " " : "",
    prevEnd: i ? i - 0.5 : null, nextStart: i + 1 < parts.length ? i + 1.1 : null,
  }));
}

describe("classificador de cacoetes", () => {
  it("cada hesitação repetida tem precedência e continua no relatório", () => {
    for (const flow of ["montagem", "limpeza"] as const) {
      const candidates = classifyWithGap(words("eu hã hã acho"), FILLER_AUTO_CATEGORIES[flow], FILLER_MIN_GAP_SECONDS[flow]);
      expect(candidates).toEqual([
        expect.objectContaining({ id: "hesitation:w1", category: "hesitation", wordIds: ["w1"], verdict: "cut" }),
        expect.objectContaining({ id: "hesitation:w2", category: "hesitation", wordIds: ["w2"], verdict: "cut" }),
      ]);
    }
  });

  it("folga por fluxo aceita igualdade e rejeita qualquer fronteira abaixo do limite", () => {
    expect(FILLER_MIN_GAP_SECONDS).toEqual({ montagem: 0.05, limpeza: 0.02 });
    for (const flow of ["montagem", "limpeza"] as const) {
      const gap = FILLER_MIN_GAP_SECONDS[flow];
      const tokens = words("eu hã acho");
      const target = tokens[1]!;
      target.prevEnd = 100;
      target.start = 100 + gap;
      target.end = 101;
      target.nextStart = 101 + gap;
      expect(classifyWithGap(tokens, all, gap)[0]!.verdict).toBe("cut");
      for (const field of ["prevEnd", "nextStart"] as const) {
        const smaller = structuredClone(tokens);
        smaller[1]![field]! += field === "prevEnd" ? 0.001 : -0.001;
        expect(classifyWithGap(smaller, all, gap)[0]!.verdict).toBe("abstain");
      }
      const micros = structuredClone(tokens);
      micros[1]!.nextStart! -= 0.000001;
      expect(classifyWithGap(micros, all, gap)[0]!.verdict).toBe("abstain");
    }
    expect(() => classifyWithGap([], all, -0.01)).toThrow(/negativo/);
    expect(() => classifyWithGap([], all, NaN)).toThrow(/número finito/);
  });

  it("ordena candidatos por tempo e depois por wordId, sem depender da categoria", () => {
    const tokens = words("é então");
    Object.assign(tokens[0]!, { wordId: "z", unitId: "u1", start: 10, end: 10.2, prevEnd: null, nextStart: null });
    Object.assign(tokens[1]!, { wordId: "a", unitId: "u2", start: 10, end: 10.2, prevEnd: null, nextStart: null });
    const unit = { ...words("Entende?")[0]!, wordId: "u", start: 20, end: 20.2, unitId: "u3" };
    expect(classifyFillers([unit, ...tokens], all).map(candidate => candidate.wordIds[0])).toEqual(["a", "z", "u"]);
  });

  it("hesitação pura corta nos dois fluxos, mas unidade inteira só sinaliza", () => {
    for (const auto of Object.values(FILLER_AUTO_CATEGORIES)) {
      expect(classifyFillers(words("eu hã acho"), auto)).toEqual([expect.objectContaining({
        id: "hesitation:w1", category: "hesitation", verdict: "cut", wordIds: ["w1"],
      })]);
      expect(classifyFillers(words("Hã?"), auto)[0]).toMatchObject({ category: "unit_only_filler", verdict: "signal" });
      expect(classifyFillers(words("Hum."), auto)[0]).toMatchObject({ category: "unit_only_filler", verdict: "signal" });
      expect(classifyFillers(words("Entende?"), auto)[0]).toMatchObject({ category: "unit_only_filler", verdict: "signal" });
      for (const text of ["hum hum", "hã hum"]) {
        expect(classifyFillers(words(text), auto)).toEqual([expect.objectContaining({ category: "unit_only_filler", verdict: "signal", wordIds: ["w0", "w1"] })]);
      }
    }
  });

  it("repetição deixa a última ocorrência e não duplica categorias", () => {
    const tokens = words("muito muito muito importante");
    expect(classifyFillers(tokens, FILLER_AUTO_CATEGORIES.limpeza)).toEqual([expect.objectContaining({
      category: "repetition", wordIds: ["w0", "w1"], start: 0.1, end: 1.5, verdict: "cut",
    })]);
    expect(classifyFillers(tokens, FILLER_AUTO_CATEGORIES.montagem)[0]!.verdict).toBe("signal");
    expect(classifyFillers(words("é é importante"), all).map(candidate => candidate.wordIds)).toEqual([["w0"]]);
  });

  it("vírgula e pontuação preservam ênfase, mesmo com separator incompleto", () => {
    expect(classifyFillers(words("muito, muito importante"), all)).toEqual([]);
    const tokens = words("muito, muito importante"); tokens[1]!.separatorBefore = " ";
    expect(classifyFillers(tokens, all)).toEqual([]);
    expect(classifyFillers(words("muito. muito importante"), all)).toEqual([]);
    const withoutSpace = words("muito muito importante"); withoutSpace[1]!.separatorBefore = "";
    expect(classifyFillers(withoutSpace, all)).toEqual([]);
  });

  it("não junta repetições através de unidades", () => {
    const tokens = words("muito muito importante"); tokens[0]!.unitId = "u0";
    expect(classifyFillers(tokens, all)).toEqual([]);
  });

  it("tags finais aguardam ensaio, e resposta posterior força abstenção", () => {
    for (const text of ["funciona né?", "funciona tá?"]) {
      const tokens = words(text);
      expect(classifyFillers(tokens, FILLER_AUTO_CATEGORIES.montagem)[0]).toMatchObject({ category: "tag_final", verdict: "signal" });
      tokens[1]!.nextUnitOpensWithAnswer = true;
      expect(classifyFillers(tokens, all)[0]).toMatchObject({ verdict: "abstain", abstainReason: "pergunta seguida de resposta" });
    }
    expect(classifyFillers(words("ele tá trabalhando"), FILLER_AUTO_CATEGORIES.limpeza)[0]).toMatchObject({ category: "ambiguous", verdict: "signal" });
  });

  it("negativos obrigatórios só sinalizam: é, sim, hã, hum e né com resposta", () => {
    expect(classifyFillers(words("é importante"), FILLER_AUTO_CATEGORIES.limpeza)[0]).toMatchObject({ category: "ambiguous", verdict: "signal" });
    expect(classifyFillers(words("Sim."), FILLER_AUTO_CATEGORIES.limpeza)[0]).toMatchObject({ category: "ambiguous", verdict: "signal" });
    for (const text of ["Hã?", "Hum."]) {
      expect(classifyFillers(words(text), FILLER_AUTO_CATEGORIES.limpeza)[0]!.verdict).toBe("signal");
    }
    expect(classifyFillers(words("então seguimos"), FILLER_AUTO_CATEGORIES.limpeza)[0]!.category).toBe("ambiguous");
    expect(classifyFillers(words("seguimos então"), all)).toEqual([]);
    expect(classifyFillers(words("isso né funciona"), FILLER_AUTO_CATEGORIES.limpeza)[0]!.category).toBe("ambiguous");
  });

  it.each([null, 0])("confiança %s se abstém sem perder texto, tempo ou ID", confidence => {
    const tokens = words("eu hã acho", confidence);
    const snapshot = structuredClone(tokens);
    expect(classifyFillers(tokens, all)[0]).toMatchObject({
      verdict: "abstain", abstainReason: "tempo estimado sem alinhamento", start: 1.1, end: 1.5, wordIds: ["w1"],
    });
    expect(tokens).toEqual(snapshot);
    expect(isFillerAligned(confidence)).toBe(false);
  });

  it("abstém com fronteiras coladas ou sobrepostas e intervalo vazio", () => {
    for (const change of [{ prevEnd: 1.1 }, { nextStart: 1.5 }, { end: 1.1 }]) {
      const tokens = words("eu hã acho"); Object.assign(tokens[1]!, change);
      expect(classifyFillers(tokens, all)[0]!.verdict).toBe("abstain");
    }
  });

  it("falha alto com números não finitos e IDs duplicados", () => {
    const tokens = words("eu hã acho"); tokens[1]!.start = NaN;
    expect(() => classifyFillers(tokens, all)).toThrow(/número finito/);
    const duplicate = words("eu hã acho"); duplicate[1]!.wordId = "w0";
    expect(() => classifyFillers(duplicate, all)).toThrow(/duplicado/);
  });

  it("normaliza bordas sem perder acentos e reconhece respostas por palavras", () => {
    expect(normalizeFillerText("“NÉ?”")).toBe("né");
    for (const text of ["Sim, claro", "Isso mesmo.", "Claro!", "Com certeza, sim", "Exatamente."]) expect(opensWithFillerAnswer(text)).toBe(true);
    for (const text of ["similar", "isso muda", "com certidão", ""]) expect(opensWithFillerAnswer(text)).toBe(false);
    expect(isFillerAligned(undefined)).toBe(false);
    expect(isFillerAligned(0.9)).toBe(true);
  });
});
