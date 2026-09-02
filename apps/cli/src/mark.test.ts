import { describe, expect, it } from "vitest";
import {
  ACCEPT_ADVANCE_MS,
  NUDGE_COARSE_MS,
  NUDGE_FINE_MS,
  SKIP_MS,
  applyKey,
  decodeKey,
  formatTruthFile,
  type MarkState,
} from "./mark.ts";

const state = (over: Partial<MarkState> = {}): MarkState => ({
  cursorMs: 1000,
  boundaries: [],
  durationMs: 3000,
  done: false,
  ...over,
});

describe("decodeKey", () => {
  it("reconhece as setas", () => {
    expect(decodeKey("[D")).toBe("nudgeBack");
    expect(decodeKey("[C")).toBe("nudgeForward");
    expect(decodeKey("[1;2D")).toBe("nudgeBackCoarse");
    expect(decodeKey("[1;2C")).toBe("nudgeForwardCoarse");
  });

  it("reconhece as teclas vim equivalentes", () => {
    expect(decodeKey("j")).toBe("nudgeBack");
    expect(decodeKey("k")).toBe("nudgeForward");
    expect(decodeKey("J")).toBe("nudgeBackCoarse");
    expect(decodeKey("K")).toBe("nudgeForwardCoarse");
  });

  it("reconhece os comandos de sessão", () => {
    expect(decodeKey("\r")).toBe("accept");
    expect(decodeKey("\n")).toBe("accept");
    expect(decodeKey(" ")).toBe("replay");
    expect(decodeKey("b")).toBe("back");
    expect(decodeKey("s")).toBe("skip");
    expect(decodeKey("q")).toBe("quit");
    expect(decodeKey("")).toBe("quit");
  });

  it("devolve unknown para o resto", () => {
    expect(decodeKey("z")).toBe("unknown");
    expect(decodeKey("")).toBe("unknown");
  });
});

describe("applyKey", () => {
  it("empurra o cursor pelo passo fino", () => {
    expect(applyKey(state(), "nudgeForward").cursorMs).toBe(1000 + NUDGE_FINE_MS);
    expect(applyKey(state(), "nudgeBack").cursorMs).toBe(1000 - NUDGE_FINE_MS);
  });

  it("empurra o cursor pelo passo grosso", () => {
    expect(applyKey(state(), "nudgeForwardCoarse").cursorMs).toBe(1000 + NUDGE_COARSE_MS);
    expect(applyKey(state(), "nudgeBackCoarse").cursorMs).toBe(1000 - NUDGE_COARSE_MS);
  });

  it("prende o cursor entre zero e a duração", () => {
    expect(applyKey(state({ cursorMs: 5 }), "nudgeBackCoarse").cursorMs).toBe(0);
    expect(applyKey(state({ cursorMs: 2990 }), "nudgeForwardCoarse").cursorMs).toBe(3000);
  });

  it("aceita a fronteira e avança o cursor", () => {
    const next = applyKey(state(), "accept");
    expect(next.boundaries).toEqual([1000]);
    expect(next.cursorMs).toBe(1000 + ACCEPT_ADVANCE_MS);
  });

  it("mantém as fronteiras ordenadas e sem repetição", () => {
    let s = state({ cursorMs: 2000, boundaries: [1500] });
    s = applyKey(s, "accept");
    s = applyKey(state({ ...s, cursorMs: 500 }), "accept");
    expect(s.boundaries).toEqual([500, 1500, 2000]);
  });

  it("não duplica ao aceitar a mesma posição duas vezes", () => {
    const s = applyKey(state({ cursorMs: 1000, boundaries: [1000] }), "accept");
    expect(s.boundaries).toEqual([1000]);
  });

  it("desfaz a última fronteira e volta o cursor para ela", () => {
    const s = applyKey(state({ cursorMs: 2500, boundaries: [800, 1600] }), "back");
    expect(s.boundaries).toEqual([800]);
    expect(s.cursorMs).toBe(1600);
  });

  it("back em lista vazia não quebra", () => {
    const s = applyKey(state({ boundaries: [] }), "back");
    expect(s.boundaries).toEqual([]);
    expect(s.cursorMs).toBe(1000);
  });

  it("pula sem registrar fronteira", () => {
    const s = applyKey(state(), "skip");
    expect(s.boundaries).toEqual([]);
    expect(s.cursorMs).toBe(1000 + SKIP_MS);
  });

  it("marca done ao sair", () => {
    expect(applyKey(state(), "quit").done).toBe(true);
  });

  it("replay e unknown não mudam nada", () => {
    const base = state({ boundaries: [500] });
    expect(applyKey(base, "replay")).toEqual(base);
    expect(applyKey(base, "unknown")).toEqual(base);
  });

  it("não muta o estado recebido", () => {
    const base = state({ boundaries: [500] });
    applyKey(base, "accept");
    expect(base.boundaries).toEqual([500]);
    expect(base.cursorMs).toBe(1000);
  });
});

describe("formatTruthFile", () => {
  it("carimba a procedência como marcação cega", () => {
    const file = formatTruthFile({
      boundaries: [120, 460],
      input: "trecho.wav",
      durationMs: 3000,
    });
    expect(file.method).toBe("blind-keyboard");
    expect(file.boundariesMs).toEqual([120, 460]);
    expect(file.input).toBe("trecho.wav");
    expect(file.durationMs).toBe(3000);
    expect(typeof file.markedAt).toBe("string");
  });

  it("ordena e remove repetição antes de gravar", () => {
    const file = formatTruthFile({
      boundaries: [460, 120, 460],
      input: "trecho.wav",
      durationMs: 3000,
    });
    expect(file.boundariesMs).toEqual([120, 460]);
  });
});
