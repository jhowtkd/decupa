/** @param {string} id @returns {number} */
const numberOf = (id) => Number(id.slice(1));

/**
 * Ids mantidos → a string que o `--keep` do motor consome.
 *
 * Guarda o id de fim, nunca o número: reconstruir como `"u" + padStart(3)`
 * quebraria em silêncio acima de 999 unidades — uma aula de duas horas chega
 * lá — e produziria uma faixa que corta no lugar errado sem erro nenhum.
 */
/** @param {string[]} ids @returns {string} */
export function keepListFrom(ids) {
  /** @type {string[]} */
  const ranges = [];
  /** @type {string | null} */
  let startId = null;
  /** @type {string | null} */
  let prevId = null;

  for (const id of ids) {
    if (prevId === null || numberOf(id) !== numberOf(prevId) + 1) {
      if (startId) ranges.push(startId === prevId ? startId : `${startId}-${prevId}`);
      startId = id;
    }
    prevId = id;
  }
  if (startId) ranges.push(startId === prevId ? startId : `${startId}-${prevId}`);
  return ranges.join(" ");
}

/** A string do `--keep` → os ids que ela cobre. A largura do zero-padding vem
 *  do próprio id recebido, não de um 3 fixo. */
/** @param {string} list @returns {string[]} */
export function expandKeepList(list) {
  /** @type {string[]} */
  const ids = [];
  for (const part of list.trim().split(/\s+/).filter(Boolean)) {
    const [from, to] = part.split("-");
    const width = from.length - 1;
    const first = numberOf(from);
    const last = to ? numberOf(to) : first;
    for (let n = first; n <= last; n += 1) ids.push(`u${String(n).padStart(width, "0")}`);
  }
  return ids;
}
