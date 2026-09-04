import { describe, expect, it } from "vitest";
import { keepListFrom } from "./keeplist.ts";
import { parseSpeechIndex } from "./speech-index.ts";

const index = parseSpeechIndex({
  units: Array.from({ length: 8 }, (_, i) => ({
    id: `u00${i + 1}`,
    index: i,
    start: i,
    end: i + 1,
    duration: 1,
    text: `t${i}`,
  })),
});

describe("keepListFrom", () => {
  it("comprime unidades consecutivas em faixa", () => {
    expect(keepListFrom(index, new Set(["u001", "u002"]))).toBe("u003-u008");
  });

  it("produz várias faixas quando há buraco no meio", () => {
    // o formato exato que o procedimento produziu na mão em 2026-09-04
    expect(keepListFrom(index, new Set(["u001", "u005", "u006"]))).toBe("u002-u004 u007-u008");
  });

  it("escreve unidade solta sem hífen", () => {
    expect(keepListFrom(index, new Set(["u002", "u004"]))).toBe("u001 u003 u005-u008");
  });

  it("devolve tudo quando nada foi dropado", () => {
    expect(keepListFrom(index, new Set())).toBe("u001-u008");
  });

  it("estoura em vez de devolver string vazia quando tudo foi dropado", () => {
    const all = new Set(index.units.map((u) => u.id));
    expect(() => keepListFrom(index, all)).toThrow(/nenhuma unidade/);
  });
});
