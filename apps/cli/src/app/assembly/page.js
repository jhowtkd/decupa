"use strict";
/* Interface A: materiais → preparação → revisão (vídeo à esquerda, texto à direita).
 * Estado canônico é o projeto do servidor; seleção de palavras e playhead
 * vivem no navegador e sobrevivem às atualizações. */
const statusEl = document.getElementById("status");
const previewPlayer = document.getElementById("previewPlayer");
const ROLES = { speech: "Fala", support: "Apoio", both: "Fala+apoio" };

let project = null;
let operation = null;
let pollTimer = 0;
/** Última revisão com vídeo conhecido no player (prévia anterior). */
let lastPreviewRev = null;
let previewTimer = 0;
let previewInflight = false;
let previewPending = false;
let correctPoll = 0;
/** Ações do usuário em voo: rótulo visível no status até a resposta chegar. */
let inflight = 0;
let inflightLabel = null;
let lastError = null;
/** Palavras selecionadas (ids) para as ações explícitas. */
const selectedWords = new Set();
let activeSceneId = null;

const OP_LABEL = {
  analyzing: "Analisando mídia",
  preparing: "Preparando montagem",
  rendering: "Renderizando prévia",
  proposing: "Propondo cenas",
};

function sourceName(id) {
  const found = project && project.assembly.sources.find((item) => item.id === id);
  return found ? found.name : id;
}

function setStatus(text, busy) {
  statusEl.textContent = text;
  statusEl.classList.toggle("busy", !!busy);
  if (busy) statusEl.setAttribute("aria-busy", "true");
  else statusEl.removeAttribute("aria-busy");
}

function backgroundBusy() {
  if (operation && OP_LABEL[operation.stage]) return true;
  if (project && project.preparation && project.preparation.status === "running") return true;
  if (previewInflight || previewPending) return true;
  return false;
}

/** Texto único do cabeçalho: erro > ação em voo > operação do servidor > revisão. */
function renderStatus() {
  if (lastError) {
    setStatus(lastError, false);
    return;
  }
  if (inflightLabel) {
    setStatus(inflightLabel, true);
    return;
  }
  if (operation && OP_LABEL[operation.stage]) {
    const detail = operation.progress ? " · " + operation.progress
      : operation.sourceId ? " · " + sourceName(operation.sourceId) : "";
    setStatus(OP_LABEL[operation.stage] + "…" + detail, true);
    return;
  }
  if (operation && operation.stage === "error") {
    setStatus("Erro: " + (operation.error || "falha no processamento"), false);
    return;
  }
  if (project && project.preparation && project.preparation.status === "running") {
    setStatus("Preparando… etapa " + project.preparation.stage, true);
    return;
  }
  if (previewInflight || previewPending) {
    setStatus("Atualizando prévia…", true);
    return;
  }
  if (project && (project.corrections || []).some((item) => item.status === "pending")) {
    setStatus("Alinhando correção…", true);
    return;
  }
  if (project) {
    setStatus("revisão " + project.revision, false);
    return;
  }
  setStatus("carregando…", true);
}

/** Desabilita sem reabilitar um botão que ainda tem spinner próprio. */
function setDisabled(el, value) {
  if (!el) return;
  if (el.classList && el.classList.contains("is-loading")) {
    el.disabled = true;
    return;
  }
  el.disabled = !!value;
}

function trackStart(label, button) {
  inflight += 1;
  inflightLabel = label;
  lastError = null;
  if (button && button.classList) {
    button.classList.add("is-loading");
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
  }
  renderStatus();
}

function trackEnd(button) {
  inflight = Math.max(0, inflight - 1);
  if (inflight === 0) inflightLabel = null;
  if (button && button.classList) {
    button.classList.remove("is-loading");
    button.removeAttribute("aria-busy");
    button.disabled = false;
  }
  // O render do api() rodou ainda com o spinner (disabled forçado): é este
  // segundo render, já sem is-loading, que devolve a cada botão o disabled
  // correto (lote sem seleção, prévia atualizada, fundo ocupado…).
  if (project) render();
  else renderStatus();
}

function showMain() {
  const hasScenes = project && project.scenes.length > 0;
  const preparing = project && project.preparation
    && project.preparation.status === "running";
  document.getElementById("preparation").hidden = !project?.preparation;
  document.getElementById("review").hidden = !hasScenes;
  document.getElementById("cancelPrep").hidden = !(
    preparing || (operation && operation.stage === "preparing")
  );
  document.getElementById("resume").hidden = !(
    project?.preparation && project.preparation.status !== "running"
    && project.preparation.status !== "ready"
  );
  // Preparar/ajustar disparam trabalhos longos no servidor: evita o segundo
  // clique parecer travado (o servidor cancelaria o anterior).
  const bg = backgroundBusy();
  setDisabled(document.getElementById("prepare"), bg);
  setDisabled(document.getElementById("adjust"), bg);
}

async function api(path, opts = {}, ui = {}) {
  const tracked = !!ui.label;
  const button = ui.button || null;
  if (tracked) trackStart(ui.label, button);
  try {
    const res = await fetch(path, {
      ...opts,
      headers: { "content-type": "application/json", ...(opts.headers || {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      lastError = body.error || ("erro " + res.status);
      renderStatus();
    } else {
      lastError = null;
    }
    if (body.project) {
      project = body.project;
      operation = body.operation || null;
      render();
      maybeScheduleAutoPreview(path);
    } else if (body.operation !== undefined) {
      operation = body.operation;
      renderStatus();
    } else if (res.ok) {
      renderStatus();
    }
    return { res, body };
  } finally {
    if (tracked) trackEnd(button);
  }
}

/**
 * Atualiza a prévia automaticamente após edições (V4): agrupa edições
 * próximas com debounce; a anterior segue visível até a atual chegar.
 * Resultados obsoletos não sobrescrevem edição mais nova (o servidor
 * recusa via CAS e o reagendamento só ocorre se a revisão andou).
 */
function maybeScheduleAutoPreview(path) {
  if (typeof path === "string" && /^\/(project\/(prepare|adjust|preview|cancel)|project$)/.test(path)) {
    return;
  }
  scheduleAutoPreview();
}

function scheduleAutoPreview() {
  if (!project || !project.scenes.length) return;
  if (project.previewRevision === project.revision) return;
  if (project.preparation && project.preparation.status === "running") return;
  if (operation && (operation.stage === "preparing" || operation.stage === "rendering")) return;
  previewPending = true;
  renderStatus();
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    if (previewInflight || !project) return;
    if (project.previewRevision === project.revision || !project.scenes.length) return;
    if (project.preparation && project.preparation.status === "running") return;
    if (operation && (operation.stage === "preparing" || operation.stage === "rendering")) return;
    const base = project.revision;
    previewPending = false;
    previewInflight = true;
    renderStatus();
    let ok = false;
    try {
      const result = await api("/project/preview", {
        method: "POST",
        body: JSON.stringify({ baseRevision: base }),
      });
      ok = result.res.ok;
    } finally {
      previewInflight = false;
      renderStatus();
    }
    if (!ok) {
      // Conflito por nova edição (409 sem corpo) ou erro real: reconcilia
      // com o servidor antes de decidir — a operação local pode estar
      // obsoleta e travar o reagendamento (R2).
      await api("/project");
    }
    // Reagenda só se a revisão andou (edição durante o render); erro real
    // de render não entra em loop: fica para o botão manual.
    if (project && project.revision !== base
      && project.previewRevision !== project.revision && project.scenes.length) {
      scheduleAutoPreview();
    }
  }, 900);
}

/** Rebusca o projeto até o alinhamento da correção concluir (V3). */
function watchCorrections() {
  clearTimeout(correctPoll);
  const tick = async () => {
    if (!project) return;
    if (!(project.corrections || []).some((item) => item.status === "pending")) return;
    await api("/project");
    if (project && (project.corrections || []).some((item) => item.status === "pending")) {
      correctPoll = setTimeout(tick, 800);
    }
  };
  correctPoll = setTimeout(tick, 800);
}

function visualById(id) {
  for (const analysis of project.analyses) {
    const span = analysis.visual.find((item) => item.id === id);
    if (span) return span;
  }
  return null;
}

/**
 * Catálogo efetivo de palavras da fonte (espelho de effectiveWords do
 * servidor): o reconhecido com as correções `aligned` substituídas no
 * intervalo corrigido. Correções `pending`/`error` não alteram o catálogo.
 */
function effectiveWords(sourceId) {
  const analysis = project.analyses.find((item) => item.sourceId === sourceId);
  if (!analysis) return [];
  let words = [...analysis.words];
  for (const correction of project.corrections) {
    if (correction.sourceId !== sourceId) continue;
    if (correction.status !== "aligned" || !correction.words.length) continue;
    words = words.filter(
      (word) => !(word.start < correction.end && correction.start < word.end),
    );
    words.push(...correction.words);
  }
  return words.sort((a, b) => a.start - b.start || a.end - b.end);
}

function wordsOf(sourceId) {
  return effectiveWords(sourceId);
}

function inRanges(ranges, start, end) {
  return ranges.some((range) => range.start < end && start < range.end);
}

function normalizeRanges(ranges) {
  const ordered = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const range of ordered) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ start: range.start, end: range.end });
  }
  return merged;
}

/** Intervalos retidos de um take: o take menos as remoções. */
function retainedOfTake(take) {
  const bounds = [{ start: take.start, end: take.end }];
  const inside = (take.removed || [])
    .map((range) => ({
      start: Math.max(range.start, take.start),
      end: Math.min(range.end, take.end),
    }))
    .filter((range) => range.start < range.end);
  let current = normalizeRanges(bounds);
  for (const cut of normalizeRanges(inside)) {
    const next = [];
    for (const range of current) {
      if (cut.end <= range.start || cut.start >= range.end) {
        next.push(range);
        continue;
      }
      if (cut.start > range.start) next.push({ start: range.start, end: cut.start });
      if (cut.end < range.end) next.push({ start: cut.end, end: range.end });
    }
    current = next;
  }
  return current;
}

function retainedDuration(take) {
  return retainedOfTake(take).reduce((sum, range) => sum + (range.end - range.start), 0);
}

/**
 * Posição na montagem (segundos) do início de uma palavra: soma das
 * durações retidas dos takes anteriores na ordem das cenas mais o deslocamento
 * da palavra dentro do próprio take (descontando remoções anteriores).
 */
function montageTimeOfWord(sceneId, takeId, word) {
  let elapsed = 0;
  for (const scene of project.scenes) {
    for (const take of scene.takes) {
      if (scene.id === sceneId && take.id === takeId) {
        let offset = word.start - take.start;
        for (const range of normalizeRanges(take.removed || [])) {
          if (range.end <= word.start) offset -= range.end - Math.max(range.start, take.start);
        }
        return Math.max(0, elapsed + Math.max(0, offset));
      }
      elapsed += retainedDuration(take);
    }
  }
  return null;
}

/** Palavras da fonte fora da seleção atual da cena (para inclusão). */
function omittedWords(scene, sourceId) {
  const retained = scene.takes
    .filter((take) => take.sourceId === sourceId)
    .flatMap((take) => retainedOfTake(take));
  return effectiveWords(sourceId).filter(
    (word) => !retained.some((range) => range.start < word.end && word.start < range.end),
  );
}

function seekMontage(seconds) {
  if (seconds == null) return;
  if (project.previewRevision != null) {
    const src = "/project/output/" + project.previewRevision + "/mp4";
    if (previewPlayer.getAttribute("data-rev") !== String(project.previewRevision)) {
      previewPlayer.src = src;
      previewPlayer.setAttribute("data-rev", String(project.previewRevision));
    }
  }
  const apply = () => {
    try {
      previewPlayer.currentTime = seconds;
    } catch {
      // Player ainda sem metadados; o listener de loadedmetadata tenta de novo.
    }
  };
  if (previewPlayer.readyState >= 1) apply();
  else previewPlayer.addEventListener("loadedmetadata", apply, { once: true });
}

/** Palavras do take com marcas de remoção/proteção/correção. */
function takeWords(scene, take) {
  const kept = [];
  for (const word of wordsOf(take.sourceId)) {
    if (word.start < take.start || word.end > take.end) continue;
    const removed = take.removed ? inRanges(take.removed, word.start, word.end) : false;
    const keptWord = { ...word, takeId: take.id, sceneId: scene.id, removed };
    keptWord.protected = take.protected ? inRanges(take.protected, word.start, word.end) : false;
    kept.push(keptWord);
  }
  // O catálogo acima já reflete as correções alinhadas; IDs de correção
  // têm o formato `${sourceId}:${sha}:c:${correctionId}:wNNNNNN`.
  return kept.map((word) => ({
    ...word,
    corrected: word.id.includes(":c:"),
    display: word.text,
  }));
}

function sceneWords(scene) {
  return scene.takes.flatMap((take) => takeWords(scene, take));
}

/** Fontes com fala fora da cena e suas palavras omitidas (para inclusão). */
function omittedBySource(scene) {
  const ids = new Set();
  for (const take of scene.takes) ids.add(take.sourceId);
  for (const analysis of project.analyses) ids.add(analysis.sourceId);
  const out = [];
  for (const sourceId of ids) {
    const words = omittedWords(scene, sourceId);
    if (words.length) out.push({ sourceId, words });
  }
  return out;
}

function renderOmitted(scene) {
  const groups = omittedBySource(scene);
  if (!groups.length) return null;
  const details = document.createElement("details");
  details.className = "omitted";
  const sum = document.createElement("summary");
  const total = groups.reduce((n, group) => n + group.words.length, 0);
  sum.textContent = "Incluir trecho do original (" + total + " palavra(s) fora da cena)";
  details.appendChild(sum);
  for (const group of groups) {
    const label = document.createElement("p");
    label.className = "muted";
    const grouped = project.assembly.sources.find((item) => item.id === group.sourceId);
    label.textContent = grouped ? grouped.name : group.sourceId;
    details.appendChild(label);
    const para = document.createElement("p");
    for (const word of group.words) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "word" + (word.id.includes(":c:") ? " corrected" : "");
      btn.dataset.wordId = word.id;
      btn.textContent = word.text;
      const key = selectionKey(scene.id, "", word.id);
      btn.dataset.scene = scene.id;
      btn.dataset.take = "";
      btn.setAttribute("aria-pressed", selectedWords.has(key) ? "true" : "false");
      btn.addEventListener("click", () => {
        if (selectedWords.has(key)) selectedWords.delete(key);
        else selectedWords.add(key);
        btn.setAttribute("aria-pressed", selectedWords.has(key) ? "true" : "false");
      });
      para.appendChild(btn);
      para.appendChild(document.createTextNode(" "));
    }
    details.appendChild(para);
  }
  const include = document.createElement("button");
  include.type = "button";
  include.textContent = "Incluir seleção nesta cena";
  include.addEventListener("click", (ev) => void includeSelection(scene, ev.currentTarget));
  details.appendChild(include);
  return details;
}

async function includeSelection(scene, button) {
  const groups = omittedBySource(scene).map((group) => ({
    sourceId: group.sourceId,
    wordIds: group.words
      .map((word) => word.id)
      .filter((id) => selectedWords.has(selectionKey(scene.id, "", id))),
  })).filter((group) => group.wordIds.length > 0);
  if (!groups.length) {
    lastError = "Selecione palavras do original para incluir.";
    renderStatus();
    return;
  }
  for (const group of groups) {
    const { res } = await api("/project/edit", {
      method: "POST",
      body: JSON.stringify({
        baseRevision: project.revision,
        action: {
          type: "include", sceneId: scene.id, sourceId: group.sourceId, wordIds: group.wordIds,
        },
      }),
    }, { label: "Incluindo trecho…", button });
    if (!res.ok) return;
    scene = project.scenes.find((item) => item.id === scene.id) || scene;
    for (const id of group.wordIds) selectedWords.delete(selectionKey(scene.id, "", id));
  }
  scheduleAutoPreview();
}

/* ---- Materiais ---- */

function renderSources() {
  const list = document.getElementById("sources");
  const focusedId = document.activeElement?.dataset?.sourceId;
  const checked = new Set(
    [...list.querySelectorAll("input[type=checkbox]:checked")].map((el) => el.value),
  );
  list.replaceChildren();
  for (const source of project.assembly.sources) {
    const li = document.createElement("li");
    li.className = "card source";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = source.id;
    box.checked = checked.has(source.id);
    box.setAttribute("aria-label", "selecionar " + source.name);
    box.addEventListener("change", renderBatchButtons);
    const thumb = document.createElement("img");
    thumb.alt = "";
    thumb.src = "/project/thumbnail/" + encodeURIComponent(source.id);
    const meta = document.createElement("div");
    meta.className = "meta";
    const name = document.createElement("div");
    const analysis = project.analyses.find((item) => item.sourceId === source.id);
    name.textContent = source.name + " · " + Math.round(source.durationSeconds) + "s"
      + (source.included ? "" : " · excluída")
      + (analysis ? " · " + analysis.status : "");
    const controls = document.createElement("div");
    controls.className = "controls";
    const role = document.createElement("select");
    role.dataset.sourceId = source.id;
    role.setAttribute("aria-label", "categoria de " + source.name);
    for (const value of Object.keys(ROLES)) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = ROLES[value];
      if (source.role === value) opt.selected = true;
      role.appendChild(opt);
    }
    role.addEventListener("change", (ev) => api("/project/source-role", {
      method: "POST",
      body: JSON.stringify({ baseRevision: project.revision, sourceIds: [source.id], role: role.value }),
    }, { label: "Atualizando categoria…", button: ev.currentTarget }));
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.textContent = source.included ? "Excluir" : "Incluir";
    toggle.addEventListener("click", (ev) => api("/project/source-selection", {
      method: "POST",
      body: JSON.stringify({ baseRevision: project.revision, sourceIds: [source.id], included: !source.included }),
    }, { label: source.included ? "Excluindo material…" : "Incluindo material…", button: ev.currentTarget }));
    const relink = document.createElement("button");
    relink.type = "button";
    relink.textContent = "Relink";
    relink.addEventListener("click", (ev) => api("/project/relink", {
      method: "POST",
      body: JSON.stringify({ baseRevision: project.revision, sourceId: source.id }),
    }, { label: "Relinkando material…", button: ev.currentTarget }));
    const watch = document.createElement("button");
    watch.type = "button";
    watch.textContent = "Ver original";
    watch.addEventListener("click", () => {
      previewPlayer.src = "/project/media/" + encodeURIComponent(source.id) + "?view=playback";
      previewPlayer.removeAttribute("data-rev");
      previewPlayer.play().catch(() => {});
      document.getElementById("review").hidden = false;
      previewPlayer.scrollIntoView();
    });
    controls.append(role, toggle, relink, watch);
    meta.append(name, controls);
    li.append(box, thumb, meta);
    list.appendChild(li);
  }
  if (focusedId) list.querySelector(`[data-source-id="${focusedId}"]`)?.focus();
  renderBatchButtons();
}

function checkedSourceIds() {
  return [...document.querySelectorAll("#sources input[type=checkbox]:checked")].map((el) => el.value);
}

function renderBatchButtons() {
  const any = checkedSourceIds().length > 0;
  setDisabled(document.getElementById("batchSupport"), !any);
  setDisabled(document.getElementById("batchInclude"), !any);
  setDisabled(document.getElementById("batchExclude"), !any);
}

async function importFiles(files) {
  const drop = document.getElementById("dropzone");
  drop.setAttribute("aria-disabled", "true");
  try {
    let index = 0;
    for (const file of files) {
      index += 1;
      const label = files.length > 1
        ? "Enviando " + index + "/" + files.length + " · " + file.name + "…"
        : "Enviando " + file.name + "…";
      trackStart(label, null);
      try {
        const res = await fetch(
          "/project/import?baseRevision=" + project.revision + "&name=" + encodeURIComponent(file.name),
          { method: "POST", headers: { "x-file-size": String(file.size) }, body: file },
        );
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          lastError = body.error || ("erro " + res.status);
          renderStatus();
          return;
        }
        lastError = null;
        project = body.project;
      } finally {
        trackEnd(null);
      }
    }
    render();
  } finally {
    drop.removeAttribute("aria-disabled");
  }
}

/* ---- Preparação ---- */

const STAGE_LABEL = { pending: "pendente", running: "rodando", ready: "pronta", error: "erro" };

function renderPreparation() {
  const prep = project.preparation;
  if (!prep) return;
  const rows = document.getElementById("prepRows");
  rows.replaceChildren();
  let done = 0;
  let total = 0;
  for (const source of project.assembly.sources.filter((item) => item.included)) {
    const state = prep.sources[source.id] || { media: "pending", audio: "pending", visual: "pending" };
    const tr = document.createElement("tr");
    const name = document.createElement("td");
    name.textContent = source.name;
    tr.appendChild(name);
    for (const stage of ["media", "audio", "visual"]) {
      total += 1;
      const value = state[stage] || "pending";
      if (value === "ready") done += 1;
      const td = document.createElement("td");
      td.className = "stage " + value;
      td.textContent = STAGE_LABEL[value] || value;
      tr.appendChild(td);
    }
    rows.appendChild(tr);
  }
  const summary = { running: "Preparando", ready: "Pronta", attention: "Atenção", interrupted: "Interrompida", cancelled: "Cancelada" };
  document.getElementById("prepSummary").textContent =
    (summary[prep.status] || prep.status) + " · etapa " + prep.stage + " · " + done + "/" + total + " etapas de fonte";
  const errBox = document.getElementById("prepError");
  errBox.replaceChildren();
  const problems = [];
  if (prep.error) problems.push(prep.error);
  for (const [id, state] of Object.entries(prep.sources)) {
    if (state.error) problems.push(id + ": " + state.error);
  }
  if (problems.length) {
    const details = document.createElement("details");
    const sum = document.createElement("summary");
    sum.textContent = "Detalhes do problema (" + problems.length + ")";
    details.appendChild(sum);
    for (const text of problems) {
      const p = document.createElement("p");
      p.className = "warn";
      p.textContent = text;
      details.appendChild(p);
    }
    errBox.appendChild(details);
  }
}

/* ---- Revisão ---- */

function renderReview() {
  if (!project.scenes.length) {
    document.getElementById("sceneCards").replaceChildren();
    document.getElementById("sequence").replaceChildren();
    document.getElementById("downloads").replaceChildren();
    document.getElementById("attention").hidden = true;
    return;
  }
  const attention = project.preparation && project.preparation.status === "attention";
  const attentionEl = document.getElementById("attention");
  attentionEl.hidden = !attention;
  if (attention) {
    attentionEl.textContent = "Atenção: " + (project.preparation.error || "há lacunas ou etapas com erro na preparação.");
  }
  const focused = document.activeElement?.dataset;
  const focusedKey = focused && focused.wordId !== undefined
    ? { scene: focused.scene || "", take: focused.take || "", word: focused.wordId }
    : null;
  const cards = document.getElementById("sceneCards");
  cards.replaceChildren();
  project.scenes.forEach((scene, index) => {
    const card = document.createElement("div");
    card.className = "card scene" + (scene.id === activeSceneId ? " active" : "");
    const title = document.createElement("strong");
    title.textContent = "Cena " + (index + 1) + (scene.objective ? " · " + scene.objective : "");
    title.tabIndex = 0;
    title.addEventListener("click", () => {
      activeSceneId = scene.id;
      renderReview();
    });
    card.appendChild(title);
    if (scene.rationale) {
      const rationale = document.createElement("p");
      rationale.className = "muted";
      rationale.textContent = scene.rationale;
      card.appendChild(rationale);
    }
    for (const take of scene.takes) {
      const block = document.createElement("div");
      block.className = "take";
      const src = document.createElement("div");
      src.className = "src";
      const source = project.assembly.sources.find((item) => item.id === take.sourceId);
      src.textContent = (source ? source.name : take.sourceId)
        + " · " + take.start.toFixed(1) + "s–" + take.end.toFixed(1) + "s";
      const jump = document.createElement("button");
      jump.type = "button";
      jump.textContent = "Ouvir trecho";
      jump.addEventListener("click", () => {
        previewPlayer.src = "/project/media/" + encodeURIComponent(take.sourceId) + "?view=playback#t=" + take.start;
        previewPlayer.removeAttribute("data-rev");
        previewPlayer.play().catch(() => {});
      });
      block.append(src, jump);
      const para = document.createElement("p");
      for (const word of takeWords(scene, take)) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "word"
          + (word.removed ? " removed" : "")
          + (word.protected ? " protected" : "")
          + (word.corrected ? " corrected" : "");
        const key = selectionKey(scene.id, take.id, word.id);
        btn.dataset.wordId = word.id;
        btn.dataset.scene = scene.id;
        btn.dataset.take = take.id;
        btn.textContent = word.display || word.text;
        btn.setAttribute("aria-pressed", selectedWords.has(key) ? "true" : "false");
        btn.setAttribute("aria-label", word.text + (word.removed ? " (removida)" : ""));
        btn.addEventListener("click", () => {
          if (selectedWords.has(key)) selectedWords.delete(key);
          else selectedWords.add(key);
          btn.setAttribute("aria-pressed", selectedWords.has(key) ? "true" : "false");
          // Selecionar posiciona a reprodução no trecho (V6).
          seekMontage(montageTimeOfWord(scene.id, take.id, word));
        });
        para.appendChild(btn);
        para.appendChild(document.createTextNode(" "));
      }
      block.appendChild(para);
      card.appendChild(block);
    }
    const omitted = renderOmitted(scene);
    if (omitted) card.appendChild(omitted);
    if (scene.gaps.length) {
      const gaps = document.createElement("p");
      gaps.className = "warn";
      gaps.textContent = "lacunas: " + scene.gaps.join("; ");
      card.appendChild(gaps);
    }
    const evidence = document.createElement("p");
    evidence.className = "muted";
    const validEvidence = (scene.visualEvidenceIds || []).filter((id) => visualById(id));
    evidence.textContent = "evidência visual: " + validEvidence.length + " trecho(s)";
    card.appendChild(evidence);
    const actions = document.createElement("div");
    actions.className = "row";
    const up = document.createElement("button");
    up.type = "button";
    up.textContent = "Subir";
    up.disabled = index === 0;
    up.addEventListener("click", (ev) => moveScene(index, -1, ev.currentTarget));
    const down = document.createElement("button");
    down.type = "button";
    down.textContent = "Descer";
    down.disabled = index === project.scenes.length - 1;
    down.addEventListener("click", (ev) => moveScene(index, 1, ev.currentTarget));
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "Excluir cena";
    del.addEventListener("click", (ev) => deleteScene(index, ev.currentTarget));
    actions.append(up, down, del);
    card.appendChild(actions);
    cards.appendChild(card);
  });
  if (focusedKey) {
    cards.querySelector(
      `[data-scene="${CSS.escape(focusedKey.scene)}"][data-take="${CSS.escape(focusedKey.take)}"]`
      + `[data-word-id="${CSS.escape(focusedKey.word)}"]`,
    )?.focus();
  }
  const seq = document.getElementById("sequence");
  seq.replaceChildren();
  project.scenes.forEach((scene, index) => {
    const li = document.createElement("li");
    if (scene.id === activeSceneId) li.className = "active";
    li.textContent = (index + 1) + (scene.objective ? " · " + scene.objective : "");
    li.title = scene.id;
    seq.appendChild(li);
  });
  document.getElementById("deliveryMeta").textContent =
    "prévia " + project.previewRevision + " · final " + project.finalApprovedRevision
    + " · " + project.assembly.width + "×" + project.assembly.height
    + " @ " + project.assembly.fps.num + "/" + project.assembly.fps.den;
  const current = project.previewRevision != null && project.previewRevision === project.revision;
  const noteEl = document.getElementById("previewNote");
  if (project.previewRevision != null) {
    const src = "/project/output/" + project.previewRevision + "/mp4";
    if (previewPlayer.getAttribute("data-rev") !== String(project.previewRevision)) {
      const time = previewPlayer.currentTime;
      previewPlayer.src = src;
      previewPlayer.setAttribute("data-rev", String(project.previewRevision));
      previewPlayer.removeAttribute("data-prev");
      previewPlayer.currentTime = time;
    }
    lastPreviewRev = project.previewRevision;
    if (noteEl) {
      if (!current) {
        noteEl.hidden = false;
        noteEl.textContent = "Prévia anterior (revisão " + project.previewRevision
          + ") — atualizando para a revisão " + project.revision + "…";
      } else {
        noteEl.hidden = true;
        noteEl.textContent = "";
      }
    }
  } else if (previewPlayer.hasAttribute("src")) {
    // Mantém o último vídeo válido como prévia anterior enquanto renderiza (V4).
    if (noteEl) {
      const label = lastPreviewRev != null ? "revisão " + lastPreviewRev : "anterior";
      noteEl.hidden = false;
      noteEl.textContent = "Prévia " + label + " — atualizando para a revisão " + project.revision + "…";
    }
  } else if (project.revision > 0) {
    // Recarregou com prévia invalidada: tenta a revisão anterior do disco.
    const prev = project.revision - 1;
    previewPlayer.src = "/project/output/" + prev + "/mp4";
    previewPlayer.setAttribute("data-prev", String(prev));
    lastPreviewRev = prev;
    if (noteEl) {
      noteEl.hidden = false;
      noteEl.textContent = "Prévia anterior (revisão " + prev + ") — atualizando para a revisão "
        + project.revision + "…";
    }
  } else {
    previewPlayer.removeAttribute("src");
    previewPlayer.removeAttribute("data-rev");
    if (noteEl) {
      noteEl.hidden = false;
      noteEl.textContent = "Sem prévia ainda.";
    }
  }
  setDisabled(document.getElementById("approveFinal"), !current);
  // Atualizar prévia renderiza no servidor: bloqueia o segundo clique.
  setDisabled(
    document.getElementById("refreshPreview"),
    project.scenes.length === 0
    || (current && project.previewArtifact?.revision === project.revision)
    || backgroundBusy(),
  );
  const downloads = document.getElementById("downloads");
  downloads.replaceChildren();
  if (project.finalApprovedRevision != null) {
    const rev = project.finalApprovedRevision;
    const otio = document.createElement("a");
    otio.href = "/project/output/" + rev + "/otio";
    otio.textContent = "Baixar timeline.otio";
    otio.setAttribute("download", "timeline.otio");
    const mp4 = document.createElement("a");
    mp4.href = "/project/output/" + rev + "/mp4";
    mp4.textContent = "Baixar reference.mp4";
    mp4.setAttribute("download", "reference.mp4");
    downloads.append(otio, document.createTextNode(" · "), mp4);
  }
}

/* ---- Ações ---- */

/**
 * Chave da ocorrência editorial selecionada: cena/take/palavra. A palavra
 * mantém sua identidade na fonte (wordId), mas a seleção distingue em qual
 * take ela foi clicada — o mesmo ID pode existir no take antigo (removido)
 * e no take reincluído (R3).
 */
function selectionKey(sceneId, takeId, wordId) {
  return sceneId + "\0" + takeId + "\0" + wordId;
}

function selectedTake() {
  const groups = new Map();
  for (const scene of project.scenes) {
    for (const take of scene.takes) {
      const prefix = scene.id + "\0" + take.id + "\0";
      const catalog = new Map(takeWords(scene, take).map((word) => [word.id, word]));
      const words = [];
      for (const key of selectedWords) {
        if (!key.startsWith(prefix)) continue;
        const word = catalog.get(key.slice(prefix.length));
        if (word) words.push(word);
      }
      if (words.length) groups.set(scene.id + "\0" + take.id, { scene, take, words });
    }
  }
  return groups.size === 1 ? groups.values().next().value : null;
}

const WORD_ACTION_LABEL = {
  remove: "Removendo trecho…",
  restore: "Restaurando trecho…",
  protect: "Preservando trecho…",
  unprotect: "Liberando trecho…",
};

async function wordAction(type, button) {
  const group = selectedTake();
  if (!group) {
    lastError = "Selecione palavras de um mesmo trecho.";
    renderStatus();
    return;
  }
  const ordered = group.words.slice().sort((a, b) => a.start - b.start);
  await api("/project/edit", {
    method: "POST",
    body: JSON.stringify({
      baseRevision: project.revision,
      action: { type, sceneId: group.scene.id, takeId: group.take.id, wordIds: ordered.map((w) => w.id) },
    }),
  }, { label: WORD_ACTION_LABEL[type] || "Aplicando edição…", button });
}

async function correctSelection(button) {
  const group = selectedTake();
  const text = document.getElementById("correctText").value.trim();
  if (!group) {
    lastError = "Selecione palavras de um mesmo trecho.";
    renderStatus();
    return;
  }
  if (!text) {
    lastError = "Digite o texto corrigido.";
    renderStatus();
    return;
  }
  const ordered = group.words.slice().sort((a, b) => a.start - b.start);
  await api("/project/edit", {
    method: "POST",
    body: JSON.stringify({
      baseRevision: project.revision,
      action: {
        type: "correct",
        sourceId: group.take.sourceId,
        start: ordered[0].start,
        end: ordered[ordered.length - 1].end,
        text,
      },
    }),
  }, { label: "Enviando correção…", button });
  document.getElementById("correctText").value = "";
  // O alinhamento conclui em background; atualiza o catálogo na tela (V3).
  watchCorrections();
  renderStatus();
}

async function proposeThenApply(scenes, changedSceneIds, explanation, button, label) {
  const proposed = await api("/project/propose", {
    method: "POST",
    body: JSON.stringify({
      baseRevision: project.revision,
      proposal: {
        id: crypto.randomUUID(),
        baseRevision: project.revision,
        scenes,
        changedSceneIds,
        explanation,
      },
    }),
  }, { label: label || "Atualizando cenas…", button });
  if (!proposed.res.ok || !proposed.body.project.proposal) return;
  await api("/project/apply", {
    method: "POST",
    body: JSON.stringify({ baseRevision: project.revision, proposalId: proposed.body.project.proposal.id }),
  }, { label: label || "Atualizando cenas…", button });
}

function moveScene(index, delta, button) {
  const scenes = project.scenes.map((scene) => ({ ...scene }));
  const next = index + delta;
  const [item] = scenes.splice(index, 1);
  scenes.splice(next, 0, item);
  proposeThenApply(scenes, [item.id, scenes[index].id], "reordenar " + item.id, button, "Reordenando cenas…");
}

function deleteScene(index, button) {
  const scenes = project.scenes.map((scene) => ({ ...scene }));
  const [removed] = scenes.splice(index, 1);
  proposeThenApply(scenes, [removed.id], "excluir " + removed.id, button, "Excluindo cena…");
}

function watchPreparation() {
  clearTimeout(pollTimer);
  const tick = async () => {
    const { body } = await api("/project");
    const prep = body.project && body.project.preparation;
    const op = body.operation;
    const busy = (op && op.stage && op.stage !== "ready" && op.stage !== "cancelled" && op.stage !== "error")
      || (prep && prep.status === "running");
    if (busy) {
      pollTimer = setTimeout(tick, 600);
    } else if (prep && prep.status !== "running" && (body.project.scenes || []).length > 0) {
      document.getElementById("review").scrollIntoView();
    }
  };
  pollTimer = setTimeout(tick, 600);
}

/** Estado pending/error das correções; alinhadas já estão no catálogo (V3). */
function renderCorrections() {
  const box = document.getElementById("corrections");
  if (!box) return;
  box.replaceChildren();
  for (const correction of project.corrections || []) {
    if (correction.status === "aligned") continue;
    const p = document.createElement("p");
    if (correction.status === "error") {
      p.className = "warn";
      p.textContent = "Correção com erro (" + correction.sourceId + " "
        + correction.start.toFixed(1) + "s–" + correction.end.toFixed(1) + "s): "
        + (correction.error || "falha no alinhamento") + ". O texto original segue valendo.";
    } else {
      p.className = "muted";
      p.textContent = "Alinhando correção (" + correction.sourceId + " "
        + correction.start.toFixed(1) + "s–" + correction.end.toFixed(1) + "s)… "
        + "o trecho original segue valendo e os cortes usam o catálogo atual.";
    }
    box.appendChild(p);
  }
}

/** Descarta seleções cujas ocorrências saíram do catálogo (ex.: correção alinhada). */
function pruneSelection() {
  const known = new Set();
  for (const scene of project.scenes) {
    for (const take of scene.takes) {
      for (const word of takeWords(scene, take)) {
        known.add(selectionKey(scene.id, take.id, word.id));
      }
    }
    for (const group of omittedBySource(scene)) {
      for (const word of group.words) {
        known.add(selectionKey(scene.id, "", word.id));
      }
    }
  }
  for (const key of [...selectedWords]) {
    if (!known.has(key)) selectedWords.delete(key);
  }
}

function render() {
  if (!project) return;
  if (project.previewRevision === project.revision) previewPending = false;
  document.getElementById("kind").value = project.input.kind;
  document.getElementById("inputText").value = project.input.text;
  document.getElementById("target").value = String(project.input.targetSeconds);
  renderSources();
  renderPreparation();
  renderCorrections();
  renderReview();
  pruneSelection();
  showMain();
  renderStatus();
}

/* ---- Fiação ---- */

const dropzone = document.getElementById("dropzone");
const filePicker = document.getElementById("filePicker");
dropzone.addEventListener("click", () => filePicker.click());
dropzone.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" || ev.key === " ") {
    ev.preventDefault();
    filePicker.click();
  }
});
dropzone.addEventListener("dragover", (ev) => {
  ev.preventDefault();
  dropzone.classList.add("over");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("over"));
dropzone.addEventListener("drop", (ev) => {
  ev.preventDefault();
  dropzone.classList.remove("over");
  if (ev.dataTransfer.files.length) void importFiles([...ev.dataTransfer.files]);
});
filePicker.addEventListener("change", () => {
  if (filePicker.files.length) void importFiles([...filePicker.files]);
  filePicker.value = "";
});

document.getElementById("select").onclick = (ev) => api("/project/select", {
  method: "POST", body: JSON.stringify({ baseRevision: project.revision }),
}, { label: "Abrindo seleção…", button: ev.currentTarget });
document.getElementById("batchSupport").onclick = (ev) => api("/project/source-role", {
  method: "POST",
  body: JSON.stringify({ baseRevision: project.revision, sourceIds: checkedSourceIds(), role: "support" }),
}, { label: "Categorizando como apoio…", button: ev.currentTarget });
document.getElementById("batchInclude").onclick = (ev) => api("/project/source-selection", {
  method: "POST",
  body: JSON.stringify({ baseRevision: project.revision, sourceIds: checkedSourceIds(), included: true }),
}, { label: "Incluindo seleção…", button: ev.currentTarget });
document.getElementById("batchExclude").onclick = (ev) => api("/project/source-selection", {
  method: "POST",
  body: JSON.stringify({ baseRevision: project.revision, sourceIds: checkedSourceIds(), included: false }),
}, { label: "Excluindo seleção…", button: ev.currentTarget });
document.getElementById("saveInput").onclick = (ev) => api("/project/input", {
  method: "POST",
  body: JSON.stringify({
    baseRevision: project.revision,
    kind: document.getElementById("kind").value,
    text: document.getElementById("inputText").value,
    targetSeconds: Number(document.getElementById("target").value),
  }),
}, { label: "Guardando briefing…", button: ev.currentTarget });

function paidFlags() {
  return {
    modelOptIn: document.getElementById("modelOptIn").checked,
    visualOptIn: document.getElementById("visualOptIn").checked,
  };
}

document.getElementById("prepare").onclick = (ev) => {
  api("/project/prepare", {
    method: "POST",
    body: JSON.stringify({ baseRevision: project.revision, request: "", ...paidFlags() }),
  }, { label: "Iniciando preparação…", button: ev.currentTarget }).then(({ res }) => {
    if (res.status === 202) {
      document.getElementById("preparation").hidden = false;
      watchPreparation();
    }
  });
};
document.getElementById("cancelPrep").onclick = (ev) => api(
  "/project/cancel",
  { method: "POST", body: "{}" },
  { label: "Cancelando…", button: ev.currentTarget },
);
document.getElementById("resume").onclick = (ev) => {
  api("/project/prepare", {
    method: "POST",
    body: JSON.stringify({ baseRevision: project.revision, request: "", ...paidFlags() }),
  }, { label: "Retomando preparação…", button: ev.currentTarget }).then(({ res }) => {
    if (res.status === 202) watchPreparation();
  });
};
document.getElementById("adjust").onclick = (ev) => {
  api("/project/adjust", {
    method: "POST",
    body: JSON.stringify({
      baseRevision: project.revision,
      request: document.getElementById("request").value,
      ...paidFlags(),
    }),
  }, { label: "Ajustando montagem…", button: ev.currentTarget }).then(({ res }) => {
    if (res.status === 202) watchPreparation();
  });
};

document.getElementById("actRemove").onclick = (ev) => void wordAction("remove", ev.currentTarget);
document.getElementById("actRestore").onclick = (ev) => void wordAction("restore", ev.currentTarget);
document.getElementById("actProtect").onclick = (ev) => void wordAction("protect", ev.currentTarget);
document.getElementById("actUnprotect").onclick = (ev) => void wordAction("unprotect", ev.currentTarget);
document.getElementById("actCorrect").onclick = (ev) => void correctSelection(ev.currentTarget);

document.getElementById("refreshPreview").onclick = (ev) => api("/project/preview", {
  method: "POST", body: JSON.stringify({ baseRevision: project.revision }),
}, { label: "Renderizando prévia…", button: ev.currentTarget }).then(({ res }) => {
  if (!res.ok) {
    // Preview obsoleto (409) ou erro real: reconcilia com o servidor e
    // retoma a revisão atual sem loop (R2).
    void api("/project").then(() => scheduleAutoPreview());
  }
});
document.getElementById("approveFinal").onclick = (ev) => api("/project/approve-final", {
  method: "POST",
  body: JSON.stringify({ baseRevision: project.revision, watchedRevision: project.previewRevision }),
}, { label: "Aprovando prévia…", button: ev.currentTarget });
document.getElementById("export").onclick = (ev) => api("/project/export", {
  method: "POST", body: JSON.stringify({ baseRevision: project.revision }),
}, { label: "Exportando…", button: ev.currentTarget });
document.getElementById("undo").onclick = (ev) => {
  if (project.revision === 0) return;
  api("/project/undo", {
    method: "POST", body: JSON.stringify({ baseRevision: project.revision, revision: project.revision - 1 }),
  }, { label: "Desfazendo…", button: ev.currentTarget });
};

renderStatus();
api("/project", {}, { label: "Carregando…" }).then(({ body }) => {
  project = body.project;
  operation = body.operation || null;
  if (project?.preparation?.status === "running") watchPreparation();
  render();
  if (project?.corrections?.some((item) => item.status === "pending")) watchCorrections();
  scheduleAutoPreview();
});
