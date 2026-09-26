// Cobertura de reprodução real da prévia (pura, sem DOM; #103). A prévia só
// conta como assistida quando os trechos tocados de fato cobrem a revisão
// inteira: salto para a frente (seek) não entra na cobertura, e voltar
// reinicia a contagem, como antes. O contexto.js só alimenta estas funções
// com os eventos do player; watched.js continua recebendo { revision, ended }.

/**
 * Folga de uma leitura, em segundos de mídia. O timeupdate chega a cada
 * 15–250 ms e o relógio da mídia não anda cravado com o da página: um avanço
 * de até o relógio decorrido (vezes a velocidade) mais 0,25 s é reprodução;
 * além disso é salto. Medir pelo relógio, e não por um passo fixo, mantém
 * contando uma página travada por um instante e o playbackRate alto. A mesma
 * folga vale nas bordas: o primeiro e o último timeupdate caem até uma
 * leitura do 0 e da duração.
 */
export const SLACK = 0.25;
/** Recuo que conta como voltar e reinicia a contagem (o mesmo limiar de antes). */
export const BACK = 0.25;
/** Trechos a menos disto um do outro são o mesmo trecho (arredondamento). */
const JOIN = 1e-3;

/** Cobertura vazia: a última posição lida (`at`) e os trechos tocados, em ordem. */
export function newCoverage(at = 0) {
  return { at, spans: [] };
}

/**
 * Uma leitura do player: a posição `time`, o relógio decorrido desde a
 * leitura anterior com a mídia tocando (`elapsed`, em s), a velocidade
 * (`rate`) e se a posição veio de um salto (`seek`, dos eventos seeking e
 * seeked). Devolve a cobertura nova e se a leitura reiniciou a contagem.
 */
export function playbackReading(coverage, time, { elapsed = 0, rate = 1, seek = false } = {}) {
  if (!Number.isFinite(time)) return { coverage, reset: false };
  if (time < coverage.at - BACK) return { coverage: newCoverage(time), reset: true };
  const step = time - coverage.at;
  const speed = Number.isFinite(rate) && rate > 0 ? rate : 1;
  const wall = Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
  const played = !seek && step > 0 && step <= wall * speed + SLACK;
  return {
    coverage: { at: time, spans: played ? joinSpan(coverage.spans, coverage.at, time) : coverage.spans },
    reset: false,
  };
}

function joinSpan(spans, start, end) {
  let from = start;
  let to = end;
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

/** Segundos da prévia tocados de fato (a união dos trechos), para o anel. */
export function coveredSeconds(coverage, duration) {
  if (!Number.isFinite(duration) || !(duration > 0)) return 0;
  return coverage.spans.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(b, duration) - Math.max(a, 0)), 0);
}

/** Assistida de verdade: um trecho contínuo do início ao fim, com a folga nas bordas. */
export function coverageComplete(coverage, duration) {
  if (!Number.isFinite(duration) || !(duration > 0)) return false;
  return coverage.spans.some(([a, b]) => a <= SLACK && b >= duration - SLACK);
}
