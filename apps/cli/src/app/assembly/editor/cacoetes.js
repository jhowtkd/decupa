import { fillerListenRange } from "./texto.js";

export function fillerSummary(report) {
  const totals = report?.totals;
  if (!totals) return "Cacoetes: 0 encontrados · 0 cortados · −0,00 s";
  return `Cacoetes: ${totals.found} encontrados · ${totals.cut} cortados · −${totals.removedSeconds.toFixed(2).replace(".", ",")} s`;
}

export function fillerTargets(items, mode) {
  return items.filter(item => mode === "cut" ? item.state === "signal" || item.state === "kept" : item.state === "cut")
    .map(({ candidateId, sceneId, takeId }) => ({ candidateId, sceneId, takeId }));
}

function noteText(item) {
  if (item.note?.decisionFailure) return `Jev: ${item.note.decisionFailure}`;
  if (typeof item.note?.score !== "number") return "";
  return `Jev: ${item.note.score >= 0.5 ? "provável cacoete" : "preservar contexto"} · ${item.note.score.toFixed(2).replace(".", ",")}`;
}

export function mountFillerContext({ state, api, player }, root) {
  const section = document.createElement("details");
  section.id = "cacoetes"; section.className = "sub";
  const summary = document.createElement("summary");
  const content = document.createElement("div");
  section.append(summary, content); root.appendChild(section);
  section.addEventListener("toggle", () => { if (section.open) void api.call("/project"); });
  let busy = false;
  const button = (label, action) => {
    const element = document.createElement("button");
    element.type = "button"; element.className = "quiet small"; element.textContent = label;
    element.disabled = busy; element.onclick = action; return element;
  };
  async function apply(items, mode) {
    const project = state.get("project"), targets = fillerTargets(items, mode);
    if (busy || !project || !targets.length) return;
    busy = true; paint();
    try {
      await api.call(`/project/fillers-${mode === "cut" ? "cut" : "restore"}`, {
        method: "POST", label: mode === "cut" ? "cortando cacoetes…" : "restaurando cacoetes…",
        body: JSON.stringify({ baseRevision: project.revision, targets }),
      });
    } finally { busy = false; paint(); }
  }
  function paint() {
    const report = state.get("fillerReport"), project = state.get("project");
    summary.textContent = fillerSummary(report); content.replaceChildren();
    for (const group of report?.groups || []) {
      const row = document.createElement("div"); row.className = "sub";
      const title = document.createElement("strong"); title.textContent = `${group.label} ×${group.items.length}`;
      row.appendChild(title);
      const actions = document.createElement("div"); actions.className = "row";
      // Uma exceção explícita só sai pela ação individual, nunca por um lote do grupo.
      const cutItems = group.items.filter(item => item.state === "signal");
      if (cutItems.length) actions.appendChild(button("Cortar todos", () => void apply(cutItems, "cut")));
      if (fillerTargets(group.items, "restore").length) actions.appendChild(button("Restaurar todos", () => void apply(group.items, "restore")));
      row.appendChild(actions);
      for (const item of group.items) {
        const occurrence = document.createElement("div"); occurrence.className = "sub";
        const text = document.createElement("p");
        const stateText = item.previousGeneration ? `${item.reason} (${item.listen.start.toFixed(2)}–${item.listen.end.toFixed(2)} s)` : item.state === "cut" ? `cortado (${item.origin === "auto" ? "automático" : "por você"})`
          : item.state === "kept" ? "mantido por você" : item.state === "abstain" ? item.reason : "para revisar";
        text.textContent = `Cena ${item.sceneNumber} · ${item.unitText} · ${stateText}`;
        occurrence.appendChild(text);
        const hint = noteText(item);
        if (hint) { const note = document.createElement("p"); note.className = "muted"; note.textContent = hint; occurrence.appendChild(note); }
        occurrence.appendChild(button("Ouvir", () => {
          const duration = project?.assembly.sources.find(s => s.id === item.sourceId)?.durationSeconds;
          const range = fillerListenRange(item, duration);
          player.playOriginal(item.sourceId, range.start, range.end);
        }));
        if (item.state === "signal" || item.state === "kept") occurrence.appendChild(button("Cortar", () => void apply([item], "cut")));
        if (item.state === "cut") occurrence.appendChild(button("Restaurar", () => void apply([item], "restore")));
        row.appendChild(occurrence);
      }
      content.appendChild(row);
    }
    if (report?.totals.excess) {
      const excess = document.createElement("p"); excess.className = "muted";
      excess.textContent = `${report.totals.excess} candidatos além do limite de notas do Jev.`; content.appendChild(excess);
    }
    if (report?.pending) { const pending = document.createElement("p"); pending.textContent = "Jev está preparando as dicas…"; content.appendChild(pending); }
  }
  state.subscribe("fillerReport", paint); state.subscribe("project", paint); paint();
  return section;
}

export function mountFillerReview({ state }, review) {
  const link = document.createElement("button"); link.type = "button"; link.className = "quiet small";
  review.appendChild(link);
  link.onclick = () => {
    const section = document.getElementById("cacoetes");
    if (section) { section.open = true; section.scrollIntoView?.({ block: "nearest" }); }
  };
  function paint() {
    const count = state.get("fillerReport")?.totals.review || 0;
    link.hidden = count === 0; link.textContent = `${count} ${count === 1 ? "cacoete" : "cacoetes"} para revisar`;
  }
  state.subscribe("fillerReport", paint); paint();
  return link;
}
