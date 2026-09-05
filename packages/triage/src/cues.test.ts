import { describe, expect, it } from "vitest";
import { hasDirectorCue } from "./cues.ts";

describe("hasDirectorCue", () => {
  it("é true em u001 (esqueci / perdão)", () => {
    expect(hasDirectorCue("Eu esqueci o começo, perdão.")).toBe(true);
  });

  it("é true em u002 (agora vai, calma aí)", () => {
    expect(hasDirectorCue("Agora vai, calma aí, calma aí, calma aí, tá vindo aqui, tá vindo aqui, tá ligando, tá dum boot.")).toBe(true);
  });

  it("casa frase isolada com acento (calma aí / corta aí)", () => {
    expect(hasDirectorCue("calma aí")).toBe(true);
    expect(hasDirectorCue("corta aí")).toBe(true);
  });

  it("é false no gancho u005", () => {
    expect(hasDirectorCue("Dicas pra você parar de ser chatão nas redes sociais.")).toBe(false);
  });

  it("é true no pós-rolo u042 (Ih, foi!)", () => {
    expect(hasDirectorCue("Ih, foi!")).toBe(true);
  });

  it("não casa 'foi' no meio de conteúdo", () => {
    expect(hasDirectorCue("Dessa forma, não escala a comunicação e dilui muito o seu poder de conversão.")).toBe(false);
    expect(hasDirectorCue("Quem está escolhendo o curso quer ter uma visão de futuro.")).toBe(false);
  });
});
