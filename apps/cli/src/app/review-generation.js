/** Respostas fora de ordem e polls durante um clique pendente não desfazem a seleção. */
export function reviewGeneration() {
  let submitted = 0, applied = 0;
  const pending = new Set();
  return {
    submit() { const ticket = ++submitted; pending.add(ticket); return ticket; },
    accept(review, ticket) {
      if (ticket !== undefined) pending.delete(ticket);
      if (ticket !== undefined && ticket !== submitted) return false;
      if (ticket === undefined && pending.size) return false;
      const generation = review?.generation ?? 0;
      if (!review || generation < applied) return false;
      applied = generation; return true;
    },
    fail(ticket) { pending.delete(ticket); return ticket === submitted; },
  };
}
