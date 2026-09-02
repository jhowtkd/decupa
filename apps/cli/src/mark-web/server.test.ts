import { describe, expect, it } from "vitest";
import { parseRange } from "./server.ts";

describe("parseRange", () => {
  it("devolve null sem cabeçalho", () => {
    expect(parseRange(undefined, 1000)).toBeNull();
  });

  it("lê um intervalo fechado", () => {
    expect(parseRange("bytes=0-499", 1000)).toEqual({ start: 0, end: 499 });
  });

  it("completa o fim quando omitido", () => {
    expect(parseRange("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
  });

  it("interpreta sufixo como os últimos N bytes", () => {
    expect(parseRange("bytes=-200", 1000)).toEqual({ start: 800, end: 999 });
  });

  it("limita o fim ao último byte disponível", () => {
    expect(parseRange("bytes=0-99999", 1000)).toEqual({ start: 0, end: 999 });
  });

  it("devolve null quando o início passa do tamanho", () => {
    expect(parseRange("bytes=1000-1500", 1000)).toBeNull();
  });

  it("devolve null quando o fim vem antes do início", () => {
    expect(parseRange("bytes=500-100", 1000)).toBeNull();
  });

  it("devolve null para cabeçalho malformado", () => {
    expect(parseRange("bytes=abc", 1000)).toBeNull();
    expect(parseRange("items=0-10", 1000)).toBeNull();
    expect(parseRange("bytes=-", 1000)).toBeNull();
  });

  it("tolera espaço em volta", () => {
    expect(parseRange("  bytes=10-20  ", 1000)).toEqual({ start: 10, end: 20 });
  });
});
