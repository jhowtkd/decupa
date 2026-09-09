import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES } from "../../../tests/fixtures/global-setup.ts";
import {
  ACCEPT_ADVANCE_MS,
  JUMP_MS,
  NUDGE_COARSE_MS,
  NUDGE_FINE_MS,
  SKIP_MS,
  applyKey,
  decodeKey,
  formatTruthFile,
  type MarkState,
} from "./mark.ts";
import { runMarkWeb, type MarkWebResult } from "./mark-web/server.ts";

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

  it("reconhece o salto de um segundo", () => {
    expect(decodeKey("]")).toBe("jumpForward");
    expect(decodeKey("[")).toBe("jumpBack");
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

  it("salta um segundo para atravessar pausa longa", () => {
    expect(applyKey(state(), "jumpForward").cursorMs).toBe(1000 + JUMP_MS);
    expect(applyKey(state(), "jumpBack").cursorMs).toBe(1000 - JUMP_MS);
  });

  it("o salto também respeita os limites", () => {
    expect(applyKey(state({ cursorMs: 200 }), "jumpBack").cursorMs).toBe(0);
    expect(applyKey(state({ cursorMs: 2500 }), "jumpForward").cursorMs).toBe(3000);
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

describe("runMarkWeb: origem do POST /truth", () => {
  it("recusa POST de outra origem com 403", async () => {
    // Mesma garantia do app limpar: bind em 127.0.0.1 protege da rede, não
    // do navegador. A diferença é que aqui o POST sobrescreve o truth-file
    // da medição — dado de bancada, não só estado de tela.
    const dir = await mkdtemp(join(tmpdir(), "mark-web-"));
    let saved!: Promise<MarkWebResult>;
    const up = new Promise<number>((resolvePort) => {
      saved = runMarkWeb({
        input: join(FIXTURES, "tone-gap.wav"),
        outPath: join(dir, "truth.json"),
        cacheDir: join(dir, "proxy"),
        port: 0,
        onListen: resolvePort,
      });
    });
    const port = await up;

    const stranger = await fetch(`http://127.0.0.1:${port}/truth`, {
      method: "POST",
      headers: { origin: "http://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ boundariesMs: [100] }),
    });
    expect(stranger.status).toBe(403);

    // O servidor só encerra depois que um POST legítimo salva: com a origem
    // certa a sessão fecha como na prática, e o runMarkWeb resolve.
    const fromPage = await fetch(`http://127.0.0.1:${port}/truth`, {
      method: "POST",
      headers: { origin: `http://127.0.0.1:${port}`, "content-type": "application/json" },
      body: JSON.stringify({ boundariesMs: [100] }),
    });
    expect(fromPage.status).toBe(200);
    await expect(saved).resolves.toMatchObject({ outPath: join(dir, "truth.json") });
  });
});
