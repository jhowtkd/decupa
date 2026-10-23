import { afterEach, describe, expect, it, vi } from "vitest";
import { installDom } from "./fake-dom.test-helper.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

function montar() {
  const document = installDom(
    `<section id="raiz"><div class="a"><span class="b"></span></div><p data-x="a, b"></p><span class="c"></span></section>`,
  );
  const raiz = document.getElementById("raiz")!;
  return {
    document,
    raiz,
    div: raiz.children[0]!,
    b: raiz.children[0]!.children[0]!,
    p: raiz.children[1]!,
    c: raiz.children[2]!,
  };
}

describe("DOM falso: lista de seletores normalizada", () => {
  it.each(["div,", " div , "])("%j vale o mesmo que \"div\"", (selector) => {
    const { document, raiz, div, b, p } = montar();
    expect(document.querySelectorAll(selector)).toEqual([div]);
    expect(raiz.querySelectorAll(selector)).toEqual([div]);
    expect(document.querySelector(selector)).toBe(div);
    expect(raiz.querySelector(selector)).toBe(div);
    expect(b.closest(selector)).toBe(div);
    expect(p.closest(selector)).toBeNull();
    expect(div.matches(selector)).toBe(true);
    expect(b.matches(selector)).toBe(false);
  });

  it("\"div, span\" une as alternativas na ordem do documento", () => {
    const { document, raiz, div, b, p, c } = montar();
    expect(document.querySelectorAll("div, span")).toEqual([div, b, c]);
    expect(raiz.querySelector("div, span")).toBe(div);
    expect(b.closest("div, span")).toBe(b);
    expect(p.closest("div, span")).toBeNull();
    expect(c.matches("div, span")).toBe(true);
    expect(p.matches("div, span")).toBe(false);
  });

  it("vírgula dentro de atributo não separa alternativas", () => {
    const { raiz, p } = montar();
    expect(raiz.querySelectorAll(`[data-x="a, b"]`)).toEqual([p]);
    expect(p.matches(`[data-x="a, b"]`)).toBe(true);
  });

  it.each(["", ",", "  ", " , , "])("%j lança SyntaxError, como no navegador", (selector) => {
    const { document, raiz, b } = montar();
    expect(() => document.querySelector(selector)).toThrow(SyntaxError);
    expect(() => document.querySelectorAll(selector)).toThrow(SyntaxError);
    expect(() => raiz.querySelector(selector)).toThrow(SyntaxError);
    expect(() => raiz.querySelectorAll(selector)).toThrow(SyntaxError);
    expect(() => b.closest(selector)).toThrow(SyntaxError);
    expect(() => b.matches(selector)).toThrow(SyntaxError);
  });
});
