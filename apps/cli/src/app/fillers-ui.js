/** DOM usa textContent: texto de transcrição e nota nunca vira HTML executável. */
const node = (tag, text, className) => { const n = document.createElement(tag); if (text) n.textContent = text; if (className) n.className = className; return n; };
const secondsLabel = value => value.toFixed(1).replace(".", ",") + " s";
const clock = s => { const n = Math.floor(Math.max(0, s || 0)); return Math.floor(n / 60) + ":" + String(n % 60).padStart(2, "0"); };
const reasonText = { content_loss: "corte perderia conteúdo", below_floor: "abaixo da duração mínima", tight_boundary: "fronteira sem corredor livre" };

export function fillerAudition(item, units) {
  const i = units.findIndex(u => u.id === item.unitId), unit = units[i];
  if (!unit) return [];
  if (["abstain", "skipped"].includes(item.status)) return [[unit.start, unit.end]];
  const ranges = [];
  // Cada lado tem orçamento próprio. Faixas separadas nunca reproduzem unidades descartadas.
  for (const direction of [-1, 1]) {
    let remaining = 1.5;
    const side = [];
    for (let at = i; at >= 0 && at < units.length && remaining > 0; at += direction) {
      const neighbor = units[at];
      if (!neighbor.kept) continue;
      let start = neighbor.start, end = neighbor.end;
      if (at === i) { if (direction < 0) end = item.start; else start = item.end; }
      if (end <= start) continue;
      const words = (neighbor.words ?? []).filter(w => w.start >= start && w.end <= end).sort((a, b) => a.start - b.start);
      if (words.length) {
        if (direction < 0) {
          end = words.at(-1).end;
          start = (words.find(w => w.start >= end - remaining) ?? words.at(-1)).start;
        } else {
          start = words[0].start;
          end = (words.filter(w => w.end <= start + remaining).at(-1) ?? words[0]).end;
        }
      } else {
        if ((neighbor.words ?? []).length) continue;
        if (direction < 0) start = Math.max(start, end - remaining); else end = Math.min(end, start + remaining);
      }
      remaining -= end - start;
      if (direction < 0) side.unshift([start, end]); else side.push([start, end]);
    }
    ranges.push(...side);
  }
  return ranges;
}

export function renderFillerCard(target, review, notes, change, hear) {
  target.replaceChildren();
  const fillers = review.fillers;
  target.hidden = !fillers || (!fillers.groups.length && (!fillers.supported || !fillers.warnings.length));
  if (target.hidden) return;
  target.append(node("h2", "Cacoetes"));
  for (const warning of fillers.warnings) target.append(node("p", warning, "hint"));
  const action = (label, items, kind, disabled) => {
    const b = node("button", label, "small"); b.type = "button"; b.disabled = disabled;
    b.onclick = () => change({ [kind]: items.map(i => ({ candidateId: i.id, wordIds: i.wordIds })) }); return b;
  };
  for (const group of fillers.groups) {
    const block = node("div", null, "sub"), list = node("ul", null, "plain triage-list");
    block.append(node("h3", group.token));
    const canAct = i => !["abstain", "skipped"].includes(i.status) && review.units.some(u => u.id === i.unitId && u.kept);
    const cut = group.items.filter(i => canAct(i) && i.status !== "cut");
    const keep = group.items.filter(i => canAct(i) && i.status === "cut");
    if (cut.length) block.append(action("Cortar todos", cut, "cut", !fillers.supported));
    if (keep.length) block.append(action("Manter todos", keep, "kept", !fillers.supported));
    for (const item of group.items) {
      const li = node("li"), unit = review.units.find(u => u.id === item.unitId);
      const status = !fillers.supported ? "o motor atual decide estes cortes"
        : { cut: "Vai cair", kept: "Mantido", signal: "Sinalizado", abstain: "Preservado", skipped: "Preservado pelo motor" }[item.status];
      li.append(node("p", `${item.texts.join(" ") || item.token} · ${status} · ${unit?.text ?? ""}`));
      if (item.reason) li.append(node("p", reasonText[item.reason] ?? item.reason, "hint"));
      const note = notes.find(n => n.candidateId === item.id);
      if (note) li.append(node("p", note.score === null ? (note.decisionFailure ?? "Sem nota do Jev") : `Jev: ${(note.score * 100).toFixed(0)}% de indicação de cacoete (dica)`, "hint"));
      const listen = node("button", "Ouvir", "small"); listen.type = "button";
      listen.onclick = () => hear(fillerAudition(item, review.units)); li.append(listen);
      if (canAct(item)) li.append(item.status === "cut"
        ? action("Manter esta palavra", [item], "kept", !fillers.supported)
        : action("Cortar", [item], "cut", !fillers.supported));
      list.append(li);
    }
    block.append(list); target.append(block);
  }
}

export function renderFillerCuts(target, review, sideLink, seek) {
  const joins = review.joins.map((join, i) => ({ join, i }));
  const link = ({ join, i }) => sideLink(`Corte ${i + 1} · −${secondsLabel(join.removedSeconds)}`, clock(join.sourceOut), () => seek(join, i), (join.flags ?? []).length > 0);
  target.replaceChildren(...joins.filter(x => !x.join.isFiller).map(link));
  const fillers = joins.filter(x => x.join.isFiller);
  if (fillers.length) {
    const li = node("li"), details = node("details"), summary = node("summary", `Cacoetes · ${review.fillers.count} · −${secondsLabel(review.fillers.totalSeconds)}`);
    const list = node("ol", null, "plain"); list.append(...fillers.map(link)); details.append(summary, list); li.append(details); target.append(li);
  }
  if (!joins.length) target.append(node("li", "Nenhum corte ainda", "side-empty"));
}
