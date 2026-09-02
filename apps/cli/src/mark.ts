import { spawn, type ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { probe } from "@decupa/media";

/**
 * Marcação cega de fronteiras de palavra.
 *
 * Esta tela NUNCA exibe, lê ou importa a saída do alinhador. É o ponto
 * inteiro da ferramenta: uma verdade derivada da predição mede zero, porque
 * não se afere um preditor contra as próprias predições dele. O arquivo
 * gravado carrega `method: "blind-keyboard"` para que o `measure` e o
 * `report` consigam distinguir verdade marcada de verdade fabricada.
 */

export const NUDGE_FINE_MS = 10;
export const NUDGE_COARSE_MS = 50;
export const ACCEPT_ADVANCE_MS = 120;
export const SKIP_MS = 200;

export type MarkKey =
  | "nudgeBack"
  | "nudgeForward"
  | "nudgeBackCoarse"
  | "nudgeForwardCoarse"
  | "accept"
  | "back"
  | "skip"
  | "replay"
  | "quit"
  | "unknown";

export interface MarkState {
  cursorMs: number;
  boundaries: number[];
  durationMs: number;
  done: boolean;
}

export interface TruthFile {
  boundariesMs: number[];
  /** Procedência. Só "blind-keyboard" conta como medição válida. */
  method: "blind-keyboard";
  input: string;
  durationMs: number;
  markedAt: string;
}

const ESC = "";

export function decodeKey(sequence: string): MarkKey {
  switch (sequence) {
    case `${ESC}[D`:
    case "j":
      return "nudgeBack";
    case `${ESC}[C`:
    case "k":
      return "nudgeForward";
    case `${ESC}[1;2D`:
    case "J":
      return "nudgeBackCoarse";
    case `${ESC}[1;2C`:
    case "K":
      return "nudgeForwardCoarse";
    case "\r":
    case "\n":
      return "accept";
    case " ":
      return "replay";
    case "b":
      return "back";
    case "s":
      return "skip";
    case "q":
    case "":
      return "quit";
    default:
      return "unknown";
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function withCursor(state: MarkState, deltaMs: number): MarkState {
  return { ...state, cursorMs: clamp(state.cursorMs + deltaMs, 0, state.durationMs) };
}

/** Transição pura. Não muta o estado recebido. */
export function applyKey(state: MarkState, key: MarkKey): MarkState {
  switch (key) {
    case "nudgeBack":
      return withCursor(state, -NUDGE_FINE_MS);
    case "nudgeForward":
      return withCursor(state, NUDGE_FINE_MS);
    case "nudgeBackCoarse":
      return withCursor(state, -NUDGE_COARSE_MS);
    case "nudgeForwardCoarse":
      return withCursor(state, NUDGE_COARSE_MS);
    case "accept": {
      const boundaries = [...new Set([...state.boundaries, state.cursorMs])].sort(
        (a, b) => a - b,
      );
      return {
        ...state,
        boundaries,
        cursorMs: clamp(state.cursorMs + ACCEPT_ADVANCE_MS, 0, state.durationMs),
      };
    }
    case "back": {
      if (state.boundaries.length === 0) return state;
      const boundaries = [...state.boundaries];
      const last = boundaries.pop()!;
      return { ...state, boundaries, cursorMs: last };
    }
    case "skip":
      return withCursor(state, SKIP_MS);
    case "quit":
      return { ...state, done: true };
    default:
      return state;
  }
}

export function formatTruthFile(opts: {
  boundaries: number[];
  input: string;
  durationMs: number;
}): TruthFile {
  return {
    boundariesMs: [...new Set(opts.boundaries)].sort((a, b) => a - b),
    method: "blind-keyboard",
    input: opts.input,
    durationMs: opts.durationMs,
    markedAt: new Date().toISOString(),
  };
}

const HELP = [
  "  ←/j  −10 ms      →/k  +10 ms",
  "  ⇧←/J −50 ms      ⇧→/K +50 ms",
  "  espaço  ouvir a partir do cursor",
  "  enter   marcar fronteira aqui",
  "  b  desfazer      s  pular 200 ms      q  gravar e sair",
].join("\n");

function render(state: MarkState): void {
  const width = 46;
  const filled = Math.round((state.cursorMs / Math.max(1, state.durationMs)) * width);
  const bar = `${"─".repeat(filled)}▲${"─".repeat(Math.max(0, width - filled))}`;
  process.stdout.write(
    `[2J[H` +
      `decupa mark — marcação cega\n` +
      `esta tela nunca mostra a predição do alinhador\n\n` +
      `cursor ${String(state.cursorMs).padStart(6)} ms de ${state.durationMs} ms\n` +
      `${bar}\n\n` +
      `fronteiras marcadas: ${state.boundaries.length}\n` +
      `${state.boundaries.slice(-8).join("  ") || "(nenhuma ainda)"}\n\n` +
      `${HELP}\n`,
  );
}

/**
 * Toca uma janela curta a partir do cursor. O ouvido julga: se o cursor está
 * no ataque da palavra, ela entra limpa; cedo demais, entra silêncio antes;
 * tarde demais, a palavra entra decapitada.
 */
function playPreview(
  input: string,
  cursorMs: number,
  previewMs: number,
  current: ChildProcess | null,
): ChildProcess {
  current?.kill();
  return spawn(
    "ffplay",
    [
      "-nodisp", "-autoexit", "-loglevel", "quiet",
      "-ss", (cursorMs / 1000).toFixed(3),
      "-t", (previewMs / 1000).toFixed(3),
      input,
    ],
    { stdio: "ignore" },
  );
}

export async function runMark(opts: {
  input: string;
  outPath: string;
  previewMs?: number;
  startMs?: number;
}): Promise<TruthFile> {
  const previewMs = opts.previewMs ?? 500;
  const info = await probe(opts.input);

  let state: MarkState = {
    cursorMs: opts.startMs ?? 0,
    boundaries: [],
    durationMs: info.durationMs,
    done: false,
  };

  if (!process.stdin.isTTY) {
    throw new Error(
      "mark precisa de um terminal interativo — abra o Terminal e rode o " +
      "comando lá, não por um pipe, script ou agente",
    );
  }

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  let player: ChildProcess | null = null;
  render(state);
  player = playPreview(opts.input, state.cursorMs, previewMs, player);

  try {
    for await (const chunk of process.stdin) {
      const key = decodeKey(chunk as string);
      if (key === "unknown") continue;

      state = applyKey(state, key);
      if (state.done) break;

      render(state);
      player = playPreview(opts.input, state.cursorMs, previewMs, player);
    }
  } finally {
    player?.kill();
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  const truth = formatTruthFile({
    boundaries: state.boundaries,
    input: opts.input,
    durationMs: info.durationMs,
  });
  await writeFile(opts.outPath, `${JSON.stringify(truth, null, 2)}\n`, "utf8");
  return truth;
}
