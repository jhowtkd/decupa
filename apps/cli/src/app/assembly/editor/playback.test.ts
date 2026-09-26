import { describe, expect, it } from "vitest";
import { coverageComplete, coveredSeconds, newCoverage, playbackReading } from "./playback.js";

type Range = [number, number];
type Coverage = ReturnType<typeof newCoverage>;
const DURATION = 73.12;
const SOURCE = "7";

function addRange(ranges: Range[], a: number, b: number): Range[] {
  const merged: Range[] = [];
  let from = a;
  let to = b;
  for (const [s, e] of ranges) {
    if (e < from || s > to) merged.push([s, e]);
    else { from = Math.min(from, s); to = Math.max(to, e); }
  }
  return [...merged, [from, to] as Range].sort((x, y) => x[0] - y[0]);
}

/**
 * Player simulado: `play` anda e o played cresce junto, como no navegador;
 * `seek` avisa o salto; `jump` salta sem evento (o played não cresce);
 * `read` é uma leitura parada (pausa, stall).
 */
function player(start: Coverage = newCoverage(0, { source: SOURCE })) {
  let cov = start;
  let played: Range[] = [];
  let at = cov.at;
  let rate = 1;
  const reading = (t: number, seek: boolean, source = SOURCE) => {
    const r = playbackReading(cov, t, { played, rate, seek, source });
    cov = r.coverage;
    return r;
  };
  return {
    get cov() { return cov; },
    get played() { return played; },
    setRate(next: number) { rate = next; return reading(at, false); },
    play(to: number, step = 0.25 * rate) {
      for (let t = Math.min(at + step, to); ; t = Math.min(t + step, to)) {
        played = addRange(played, at, t);
        at = t;
        reading(t, false);
        if (t >= to) break;
      }
    },
    seek(t: number) { at = t; return reading(t, true); },
    jump(t: number) { at = t; return reading(t, false); },
    read(source = SOURCE) { return reading(at, false, source); },
  };
}

describe("cobertura da prévia (#103): só o que o player tocou de fato", () => {
  it("seek direto para o fim, sem play: nada tocado, continua travado", () => {
    const p = player();
    expect(p.seek(73.1).reset).toBe(false);
    expect(coveredSeconds(p.cov, DURATION)).toBe(0);
    expect(coverageComplete(p.cov, DURATION)).toBe(false);
  });

  it("seek até a metade e play até o fim: falta a primeira metade", () => {
    const p = player();
    p.seek(DURATION / 2);
    p.play(DURATION);
    expect(coveredSeconds(p.cov, DURATION)).toBeCloseTo(DURATION / 2, 5);
    expect(coverageComplete(p.cov, DURATION)).toBe(false);
  });

  it("play contínuo do início ao fim: libera", () => {
    const p = player();
    p.play(DURATION);
    expect(coveredSeconds(p.cov, DURATION)).toBeCloseTo(DURATION, 5);
    expect(coverageComplete(p.cov, DURATION)).toBe(true);
  });

  it("play com pausas e retomadas, sem saltos: libera", () => {
    const p = player();
    p.play(20);
    p.read();
    p.play(51.3);
    p.read();
    p.play(DURATION);
    expect(coverageComplete(p.cov, DURATION)).toBe(true);
  });

  it("voltar no meio do play zera a contagem (decisão de produto)", () => {
    const p = player();
    p.play(40);
    const back = p.seek(20);
    expect(back.reset).toBe(true);
    expect(coveredSeconds(p.cov, DURATION)).toBe(0);
    // O played ainda lembra de 0–40 s, mas a contagem recomeçou em 20 s.
    p.play(DURATION);
    expect(coverageComplete(p.cov, DURATION)).toBe(false);
    // Voltar sem o aviso de seek também zera.
    const q = player();
    q.play(40);
    expect(q.jump(20).reset).toBe(true);
  });

  it("seek para a frente no meio abre um buraco que o fim não fecha", () => {
    const p = player();
    p.play(30);
    p.seek(45);
    p.play(DURATION);
    expect(coveredSeconds(p.cov, DURATION)).toBeCloseTo(DURATION - 15, 5);
    expect(coverageComplete(p.cov, DURATION)).toBe(false);
  });

  it("salto sem evento, a 16×, sobre trecho que o played não cobre: não credita (nem no ended)", () => {
    const p = player();
    p.setRate(16);
    p.jump(73.1);
    expect(coveredSeconds(p.cov, DURATION)).toBe(0);
    p.jump(DURATION);
    expect(coverageComplete(p.cov, DURATION)).toBe(false);
  });

  it("avanços pequenos repetidos sem played: não credita", () => {
    const p = player();
    for (let t = 0.24; t <= DURATION; t += 0.24) p.jump(t);
    p.jump(DURATION);
    expect(coveredSeconds(p.cov, DURATION)).toBe(0);
    expect(coverageComplete(p.cov, DURATION)).toBe(false);
  });

  it("16× legítimo, com o played cobrindo: credita e libera", () => {
    const p = player();
    p.setRate(16);
    p.play(DURATION);
    expect(coverageComplete(p.cov, DURATION)).toBe(true);
  });

  it("stall/waiting não infla: leituras paradas não abrem orçamento para um salto", () => {
    const p = player();
    p.play(10);
    for (let i = 0; i < 40; i++) p.read();
    p.jump(11.5);
    expect(coveredSeconds(p.cov, DURATION)).toBeCloseTo(10, 5);
    // Retomado dali, o trecho 10–11,5 s que não tocou fica faltando.
    p.play(DURATION);
    expect(coverageComplete(p.cov, DURATION)).toBe(false);
  });

  it("a velocidade vale por trecho: 16× lido só no fim não retroage", () => {
    const start = player();
    start.play(10);
    // Um avanço de 4 s com a velocidade de 1× em vigor passa do teto por leitura.
    const r = playbackReading(start.cov, 14, { played: [[0, 14]], rate: 16, source: SOURCE });
    expect(coveredSeconds(r.coverage, DURATION)).toBeCloseTo(10, 5);
    // Depois dessa leitura, 16× passa a valer para os próximos trechos.
    const next = playbackReading(r.coverage, 18, { played: [[0, 18]], rate: 16, source: SOURCE });
    expect(coveredSeconds(next.coverage, DURATION)).toBeCloseTo(14, 5);
  });

  it("troca de src zera a contagem", () => {
    const p = player();
    p.play(30);
    const swap = p.read("8");
    expect(swap.reset).toBe(true);
    expect(coveredSeconds(p.cov, DURATION)).toBe(0);
  });

  it("página travada por um instante ainda conta, se o played cobre", () => {
    const p = player();
    p.play(10);
    p.play(11.5, 1.5);
    p.play(DURATION);
    expect(coverageComplete(p.cov, DURATION)).toBe(true);
  });

  it("duração que cresce depois de assistida deixa de estar coberta", () => {
    const p = player();
    p.play(DURATION);
    expect(coverageComplete(p.cov, DURATION)).toBe(true);
    expect(coverageComplete(p.cov, 100)).toBe(false);
    expect(coveredSeconds(p.cov, 100)).toBeCloseTo(DURATION, 5);
  });

  it("bordas: fim a menos de uma leitura da duração ainda completa; duração inválida nunca", () => {
    const almost = player();
    almost.play(DURATION - 0.2);
    expect(coverageComplete(almost.cov, DURATION)).toBe(true);
    const short = player();
    short.play(DURATION - 1);
    expect(coverageComplete(short.cov, DURATION)).toBe(false);
    expect(coverageComplete(short.cov, Number.NaN)).toBe(false);
    expect(coveredSeconds(newCoverage(), Number.NaN)).toBe(0);
  });
});
