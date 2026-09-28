// Cobertura de reprodução real da prévia (pura, sem DOM; #103). A prévia só
// conta como assistida quando os trechos tocados de fato cobrem a revisão
// inteira. A prova de que um trecho tocou vem do próprio player
// (HTMLMediaElement.played): cada leitura credita só a interseção do avanço
// desde a leitura anterior com os ranges de played. Salto (seek) não entra,
// voltar zera a contagem e trocar de src também. A cobertura é guardada aqui,
// e não lida direto de played, porque played não zera quando se volta. O
// contexto.js só alimenta estas funções com os eventos do player;
// watched.js continua recebendo { revision, ended }.

/**
 * Teto de avanço por leitura, em segundos de mídia a 1×, multiplicado pela
 * velocidade em vigor desde a leitura anterior. O timeupdate chega a cada
 * 15–250 ms (cerca de 1 s numa aba em segundo plano), e 2 s cobrem isso e uma
 * página travada por um instante. A prova de reprodução é o played; o teto só
 * impede um salto sem evento de recreditar, depois de voltar, um trecho que o
 * played ainda lembra de antes.
 */
export const STEP = 2;
/** Recuo que conta como voltar e zera a contagem (o mesmo limiar de antes). */
export const BACK = 0.25;
/** Folga nas bordas: o primeiro e o último timeupdate caem até uma leitura (250 ms) do 0 e da duração. */
export const EDGE = 0.25;
/** Trechos a menos disto um do outro são o mesmo trecho (arredondamento). */
const JOIN = 1e-3;

/**
 * @typedef {[number, number]} Span
 * @typedef {{ at: number, rate: number, source: string | null, spans: Span[] }} Coverage
 */

/** @param {number} rate */
function speedOf(rate) {
  return Number.isFinite(rate) && rate > 0 ? rate : 1;
}

/**
 * Cobertura vazia: a última posição lida (`at`), a velocidade em vigor desde
 * ela (`rate`), a fonte lida (`source`, a revisão da prévia) e os trechos
 * creditados, em ordem.
 * @param {number} [at]
 * @param {{ rate?: number, source?: string | null }} [options]
 * @returns {Coverage}
 */
export function newCoverage(at = 0, { rate = 1, source = null } = {}) {
  return { at, rate: speedOf(rate), source, spans: [] };
}

/**
 * Uma leitura do player: a posição `time`, os ranges de `played` agora
 * (pares [início, fim]), a velocidade atual (`rate`, que passa a valer para o
 * próximo trecho), se a posição veio de um salto (`seek`, dos eventos seeking
 * e seeked) e a fonte (`source`). Devolve a cobertura nova e se a leitura
 * zerou a contagem (voltou ou trocou de fonte).
 * @param {Coverage} coverage
 * @param {number} time
 * @param {{ played?: Span[], rate?: number, seek?: boolean, source?: string | null }} [options]
 * @returns {{ coverage: Coverage, reset: boolean }}
 */
export function playbackReading(coverage, time, { played = [], rate = 1, seek = false, source = coverage.source } = {}) {
  if (!Number.isFinite(time)) return { coverage, reset: false };
  const speed = speedOf(rate);
  if (source !== coverage.source || time < coverage.at - BACK) {
    return { coverage: newCoverage(time, { rate: speed, source }), reset: true };
  }
  const step = time - coverage.at;
  let spans = coverage.spans;
  // O teto usa a velocidade da leitura anterior: 16× lido agora não retroage.
  if (!seek && step > 0 && step <= STEP * coverage.rate) {
    for (const [start, end] of played) {
      const from = Math.max(coverage.at, start);
      const to = Math.min(time, end);
      if (to > from) spans = joinSpan(spans, from, to);
    }
  }
  return { coverage: { at: time, rate: speed, source, spans }, reset: false };
}

/**
 * @param {Span[]} spans
 * @param {number} start
 * @param {number} end
 * @returns {Span[]}
 */
function joinSpan(spans, start, end) {
  let from = start;
  let to = end;
  /** @type {Span[]} */
  const rest = [];
  for (const [a, b] of spans) {
    if (b < from - JOIN || a > to + JOIN) rest.push([a, b]);
    else {
      from = Math.min(from, a);
      to = Math.max(to, b);
    }
  }
  return [...rest, [from, to]].sort((x, y) => x[0] - y[0]);
}

/**
 * Segundos da prévia tocados de fato (a união dos trechos), para o anel.
 * @param {Coverage} coverage
 * @param {number} duration
 */
export function coveredSeconds(coverage, duration) {
  if (!Number.isFinite(duration) || !(duration > 0)) return 0;
  return coverage.spans.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(b, duration) - Math.max(a, 0)), 0);
}

/**
 * Assistida de verdade para esta duração: um trecho contínuo do início ao fim,
 * com a folga nas bordas. Reavaliar quando a duração muda revoga o assistido.
 * @param {Coverage} coverage
 * @param {number} duration
 */
export function coverageComplete(coverage, duration) {
  if (!Number.isFinite(duration) || !(duration > 0)) return false;
  return coverage.spans.some(([a, b]) => a <= EDGE && b >= duration - EDGE);
}
