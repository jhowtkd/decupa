import { describe, expect, it } from "vitest";
import {
  MOTOR_DUPLICATE_THRESHOLD,
  RESTATEMENT_THRESHOLD,
  SHORT_JACCARD_THRESHOLD,
  SHORT_UNIT_TOKEN_LIMIT,
  headOverlap,
  isRestatement,
  shortUnitSimilarity,
  similarity,
} from "./similarity.ts";

describe("similarity", () => {
  it("dá 1 para texto idêntico", () => {
    expect(similarity("Isso não escala", "Isso não escala")).toBe(1);
  });

  it("ignora pontuação e caixa", () => {
    // o caso real: u032 vs u036 no material de 2026-09-04
    expect(similarity("Isso não escala", "isso não escala...")).toBe(1);
  });

  it("passa do limiar em retomada quase-verbatim", () => {
    const s = similarity(
      "Isso não escala de jeito nenhum aqui.",
      "Isso não escala de jeito nenhum.",
    );
    expect(s).toBeGreaterThanOrEqual(RESTATEMENT_THRESHOLD);
  });

  it("mede retomada com variação interna (u026 vs u027 dá 0.6)", () => {
    // O motor mediu 0.881 com SequenceMatcher de caracteres, mas em bigramas
    // de tokens a inserção de duas palavras quebra ambos os lados e resulta em 0.6.
    const s = similarity(
      "E quem contrata quer sentir o resultado.",
      "E quem contrata quer resultado.",
    );
    expect(s).toBeCloseTo(0.6, 2);
  });

  it("fica bem abaixo do limiar em frases de assuntos diferentes", () => {
    const s = similarity(
      "Isso não escala",
      "Dessa forma, não escala a comunicação e dilui muito o seu poder de conversão.",
    );
    expect(s).toBeLessThan(RESTATEMENT_THRESHOLD);
  });

  it("cai para Dice de token quando não há bigrama", () => {
    // uma palavra só não tem bigrama; sem o fallback isso seria 0
    expect(similarity("Entende?", "entende")).toBe(1);
    expect(similarity("Entende?", "escala")).toBe(0);
  });

  it("dá 0 quando um dos lados é vazio", () => {
    expect(similarity("", "Isso não escala")).toBe(0);
  });
});

describe("shortUnitSimilarity", () => {
  it("dá 1 para o mesmo conjunto de tokens em ordem diferente (u012/u013)", () => {
    expect(shortUnitSimilarity("empresas, entre outras.", "entre outras empresas,")).toBe(1);
  });

  it("fica em 5/7 no par u026/u027 (inserção de duas palavras)", () => {
    expect(shortUnitSimilarity(
      "E quem contrata quer sentir o resultado.",
      "E quem contrata quer resultado.",
    )).toBeCloseTo(5 / 7, 5);
  });
});

describe("headOverlap", () => {
  it("é true quando a unidade seguinte começa com o fim da anterior (u009/u010)", () => {
    expect(headOverlap("futuro aluno, ex-aluno,", "ex-aluno, pais, responsáveis,")).toBe(true);
  });

  it("é true no par u012/u013 (entre outras)", () => {
    expect(headOverlap("empresas, entre outras.", "entre outras empresas,")).toBe(true);
  });

  it("é false em frases sem sufixo/prefixo compartilhado", () => {
    expect(headOverlap(
      "Dicas pra você parar de ser chatão nas redes sociais.",
      "Assim, é pra instituição de ensino, mas serve pra todo mundo.",
    )).toBe(false);
  });
});

describe("isRestatement", () => {
  it("é true no par u026/u027 mesmo com Dice 0.6, via motor 0.881", () => {
    // similarity() deste par fica em 0.6 (teste acima); o motor mediu 0.881.
    expect(similarity(
      "E quem contrata quer sentir o resultado.",
      "E quem contrata quer resultado.",
    )).toBeCloseTo(0.6, 2);
    expect(isRestatement(
      "E quem contrata quer sentir o resultado.",
      "E quem contrata quer resultado.",
      0.881,
    )).toBe(true);
  });

  it("é true no par u012/u013 via Jaccard curto / headOverlap", () => {
    expect(isRestatement("empresas, entre outras.", "entre outras empresas,")).toBe(true);
  });

  it("não dispara só por headOverlap no par u009/u010 (Jaccard baixo, sem motor)", () => {
    expect(headOverlap("futuro aluno, ex-aluno,", "ex-aluno, pais, responsáveis,")).toBe(true);
    expect(isRestatement("futuro aluno, ex-aluno,", "ex-aluno, pais, responsáveis,")).toBe(false);
  });

  it("fica abaixo em frases de assuntos diferentes", () => {
    expect(isRestatement(
      "Isso não escala",
      "Dessa forma, não escala a comunicação e dilui muito o seu poder de conversão.",
    )).toBe(false);
  });

  it("expõe constantes nomeadas do limiar", () => {
    expect(SHORT_UNIT_TOKEN_LIMIT).toBe(6);
    expect(MOTOR_DUPLICATE_THRESHOLD).toBe(0.74);
    expect(RESTATEMENT_THRESHOLD).toBe(0.8);
    expect(SHORT_JACCARD_THRESHOLD).toBeGreaterThan(0.4);
    expect(SHORT_JACCARD_THRESHOLD).toBeLessThanOrEqual(5 / 7);
  });
});
