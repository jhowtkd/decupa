import { describe, expect, it } from "vitest";
import { RESTATEMENT_THRESHOLD, similarity } from "./similarity.ts";

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
