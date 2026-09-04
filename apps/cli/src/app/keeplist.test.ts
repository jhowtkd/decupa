import { describe, expect, it } from "vitest";
import { expandKeepList, keepListFrom } from "./keeplist.js";

describe("keepListFrom", () => {
  it("comprime ids consecutivos numa faixa", () => {
    expect(keepListFrom(["u001", "u002", "u003"])).toBe("u001-u003");
  });

  it("separa faixas quando há buraco", () => {
    expect(keepListFrom(["u001", "u002", "u005"])).toBe("u001-u002 u005");
  });

  it("id solto sai sem hífen", () => {
    expect(keepListFrom(["u007"])).toBe("u007");
  });

  it("devolve string vazia para lista vazia", () => {
    expect(keepListFrom([])).toBe("");
  });

  it("preserva a largura do id acima de 999", () => {
    // Reconstruir o fim como "u" + padStart(3) daria "u1000" contra "u999" e
    // produziria faixa errada — corte no lugar errado, sem erro nenhum.
    expect(keepListFrom(["u0999", "u1000", "u1001"])).toBe("u0999-u1001");
  });
});

describe("expandKeepList", () => {
  it("expande faixa", () => {
    expect(expandKeepList("u001-u003")).toEqual(["u001", "u002", "u003"]);
  });

  it("expande faixas e ids soltos juntos", () => {
    expect(expandKeepList("u001-u002 u005")).toEqual(["u001", "u002", "u005"]);
  });

  it("deriva a largura do padding do id recebido", () => {
    expect(expandKeepList("u0999-u1001")).toEqual(["u0999", "u1000", "u1001"]);
  });

  it("devolve lista vazia para string vazia", () => {
    expect(expandKeepList("   ")).toEqual([]);
  });

  it("é reversível com keepListFrom", () => {
    const ids = ["u001", "u002", "u005", "u006", "u007", "u010"];
    expect(expandKeepList(keepListFrom(ids))).toEqual(ids);
  });
});
