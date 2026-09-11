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
/** Palavras selecionadas (ids) para as ações explícitas. */
const selectedWords = new Set();
let activeSceneId = null;

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
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "content-type": "application/json", ...(opts.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    statusEl.textContent = body.error || ("erro " + res.status);
  } else {
    statusEl.textContent = "revisão " + (body.project ? body.project.revision : (project && project.revision));
  }
  if (body.project) {
    project = body.project;
    operation = body.operation || null;
    render();
  } else if (body.operation !== undefined) {
    operation = body.operation;
  }
  return { res, body };
}

function visualById(id) {
  for (const analysis of project.analyses) {
    const span = analysis.visual.find((item) => item.id === id);
    if (span) return span;
  }
  return null;
}

function wordsOf(sourceId) {
  const analysis = project.analyses.find((item) => item.sourceId === sourceId);
  return analysis ? analysis.words : [];
}

function inRanges(ranges, start, end) {
  return ranges.some((range) => range.start < end && start < range.end);
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
  const fixed = new Map();
  for (const correction of project.corrections) {
    if (correction.sourceId !== take.sourceId) continue;
    for (const word of correction.words) fixed.set(word.id, correction.text);
  }
  return kept.map((word) => (fixed.has(word.id) ? { ...word, corrected: true, display: fixed.get(word.id) } : word));
}

function sceneWords(scene) {
  return scene.takes.flatMap((take) => takeWords(scene, take));
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
    role.addEventListener("change", () => api("/project/source-role", {
      method: "POST",
      body: JSON.stringify({ baseRevision: project.revision, sourceIds: [source.id], role: role.value }),
    }));
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.textContent = source.included ? "Excluir" : "Incluir";
    toggle.addEventListener("click", () => api("/project/source-selection", {
      method: "POST",
      body: JSON.stringify({ baseRevision: project.revision, sourceIds: [source.id], included: !source.included }),
    }));
    const relink = document.createElement("button");
    relink.type = "button";
    relink.textContent = "Relink";
    relink.addEventListener("click", () => api("/project/relink", {
      method: "POST",
      body: JSON.stringify({ baseRevision: project.revision, sourceId: source.id }),
    }));
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
  document.getElementById("batchSupport").disabled = !any;
  document.getElementById("batchInclude").disabled = !any;
  document.getElementById("batchExclude").disabled = !any;
}

async function importFiles(files) {
  for (const file of files) {
    statusEl.textContent = "enviando " + file.name + "…";
    const res = await fetch(
      "/project/import?baseRevision=" + project.revision + "&name=" + encodeURIComponent(file.name),
      { method: "POST", headers: { "x-file-size": String(file.size) }, body: file },
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      statusEl.textContent = body.error || ("erro " + res.status);
      return;
    }
    project = body.project;
  }
  render();
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
  const focusedWord = document.activeElement?.dataset?.wordId;
  const cards = document.getElementById("sceneCards");
  cards.replaceChildren();
  project.scenes.forEach((scene, index) => {
    const card = document.createElement("div");
    card.className = "card scene" + (scene.id === activeSceneId ? " active" : "");
    const title = document.createElement("strong");
    title.textContent = (index + 1) + ". " + scene.id + " · " + scene.objective;
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
      src.textContent = take.sourceId + " · " + take.start.toFixed(1) + "s–" + take.end.toFixed(1) + "s";
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
        btn.dataset.wordId = word.id;
        btn.textContent = word.display || word.text;
        btn.setAttribute("aria-pressed", selectedWords.has(word.id) ? "true" : "false");
        btn.setAttribute("aria-label", word.text + (word.removed ? " (removida)" : ""));
        btn.addEventListener("click", () => {
          if (selectedWords.has(word.id)) selectedWords.delete(word.id);
          else selectedWords.add(word.id);
          btn.setAttribute("aria-pressed", selectedWords.has(word.id) ? "true" : "false");
        });
        para.appendChild(btn);
        para.appendChild(document.createTextNode(" "));
      }
      block.appendChild(para);
      card.appendChild(block);
    }
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
    up.addEventListener("click", () => moveScene(index, -1));
    const down = document.createElement("button");
    down.type = "button";
    down.textContent = "Descer";
    down.disabled = index === project.scenes.length - 1;
    down.addEventListener("click", () => moveScene(index, 1));
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "Excluir cena";
    del.addEventListener("click", () => deleteScene(index));
    actions.append(up, down, del);
    card.appendChild(actions);
    cards.appendChild(card);
  });
  if (focusedWord) cards.querySelector(`[data-word-id="${CSS.escape(focusedWord)}"]`)?.focus();
  const seq = document.getElementById("sequence");
  seq.replaceChildren();
  project.scenes.forEach((scene) => {
    const li = document.createElement("li");
    if (scene.id === activeSceneId) li.className = "active";
    li.textContent = scene.id;
    seq.appendChild(li);
  });
  document.getElementById("deliveryMeta").textContent =
    "prévia " + project.previewRevision + " · final " + project.finalApprovedRevision
    + " · " + project.assembly.width + "×" + project.assembly.height
    + " @ " + project.assembly.fps.num + "/" + project.assembly.fps.den;
  const current = project.previewRevision != null && project.previewRevision === project.revision;
  if (project.previewRevision != null) {
    const src = "/project/output/" + project.previewRevision + "/mp4";
    if (previewPlayer.getAttribute("data-rev") !== String(project.previewRevision)) {
      const time = previewPlayer.currentTime;
      previewPlayer.src = src;
      previewPlayer.setAttribute("data-rev", String(project.previewRevision));
      previewPlayer.currentTime = time;
    }
  } else {
    previewPlayer.removeAttribute("src");
    previewPlayer.removeAttribute("data-rev");
  }
  document.getElementById("approveFinal").disabled = !current;
  document.getElementById("refreshPreview").disabled = project.scenes.length === 0
    || (current && project.previewArtifact?.revision === project.revision);
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

function selectedTake() {
  const groups = new Map();
  for (const scene of project.scenes) {
    for (const take of scene.takes) {
      for (const word of takeWords(scene, take)) {
        if (selectedWords.has(word.id)) {
          const key = scene.id + "\0" + take.id;
          if (!groups.has(key)) groups.set(key, { scene, take, words: [] });
          groups.get(key).words.push(word);
        }
      }
    }
  }
  return groups.size === 1 ? groups.values().next().value : null;
}

async function wordAction(type) {
  const group = selectedTake();
  if (!group) {
    statusEl.textContent = "Selecione palavras de um mesmo trecho.";
    return;
  }
  const ordered = group.words.slice().sort((a, b) => a.start - b.start);
  await api("/project/edit", {
    method: "POST",
    body: JSON.stringify({
      baseRevision: project.revision,
      action: { type, sceneId: group.scene.id, takeId: group.take.id, wordIds: ordered.map((w) => w.id) },
    }),
  });
}

async function correctSelection() {
  const group = selectedTake();
  const text = document.getElementById("correctText").value.trim();
  if (!group) {
    statusEl.textContent = "Selecione palavras de um mesmo trecho.";
    return;
  }
  if (!text) {
    statusEl.textContent = "Digite o texto corrigido.";
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
  });
  document.getElementById("correctText").value = "";
}

async function proposeThenApply(scenes, changedSceneIds, explanation) {
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
  });
  if (!proposed.res.ok || !proposed.body.project.proposal) return;
  await api("/project/apply", {
    method: "POST",
    body: JSON.stringify({ baseRevision: project.revision, proposalId: proposed.body.project.proposal.id }),
  });
}

function moveScene(index, delta) {
  const scenes = project.scenes.map((scene) => ({ ...scene }));
  const next = index + delta;
  const [item] = scenes.splice(index, 1);
  scenes.splice(next, 0, item);
  proposeThenApply(scenes, [item.id, scenes[index].id], "reordenar " + item.id);
}

function deleteScene(index) {
  const scenes = project.scenes.map((scene) => ({ ...scene }));
  const [removed] = scenes.splice(index, 1);
  proposeThenApply(scenes, [removed.id], "excluir " + removed.id);
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

function render() {
  if (!project) return;
  document.getElementById("kind").value = project.input.kind;
  document.getElementById("inputText").value = project.input.text;
  document.getElementById("target").value = String(project.input.targetSeconds);
  renderSources();
  renderPreparation();
  renderReview();
  showMain();
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

document.getElementById("select").onclick = () => api("/project/select", {
  method: "POST", body: JSON.stringify({ baseRevision: project.revision }),
});
document.getElementById("batchSupport").onclick = () => api("/project/source-role", {
  method: "POST",
  body: JSON.stringify({ baseRevision: project.revision, sourceIds: checkedSourceIds(), role: "support" }),
});
document.getElementById("batchInclude").onclick = () => api("/project/source-selection", {
  method: "POST",
  body: JSON.stringify({ baseRevision: project.revision, sourceIds: checkedSourceIds(), included: true }),
});
document.getElementById("batchExclude").onclick = () => api("/project/source-selection", {
  method: "POST",
  body: JSON.stringify({ baseRevision: project.revision, sourceIds: checkedSourceIds(), included: false }),
});
document.getElementById("saveInput").onclick = () => api("/project/input", {
  method: "POST",
  body: JSON.stringify({
    baseRevision: project.revision,
    kind: document.getElementById("kind").value,
    text: document.getElementById("inputText").value,
    targetSeconds: Number(document.getElementById("target").value),
  }),
});

function paidFlags() {
  return {
    modelOptIn: document.getElementById("modelOptIn").checked,
    visualOptIn: document.getElementById("visualOptIn").checked,
  };
}

document.getElementById("prepare").onclick = () => {
  api("/project/prepare", {
    method: "POST",
    body: JSON.stringify({ baseRevision: project.revision, request: "", ...paidFlags() }),
  }).then(({ res }) => {
    if (res.status === 202) {
      document.getElementById("preparation").hidden = false;
      watchPreparation();
    }
  });
};
document.getElementById("cancelPrep").onclick = () => api("/project/cancel", { method: "POST", body: "{}" });
document.getElementById("resume").onclick = () => {
  api("/project/prepare", {
    method: "POST",
    body: JSON.stringify({ baseRevision: project.revision, request: "", ...paidFlags() }),
  }).then(({ res }) => {
    if (res.status === 202) watchPreparation();
  });
};
document.getElementById("adjust").onclick = () => {
  api("/project/adjust", {
    method: "POST",
    body: JSON.stringify({
      baseRevision: project.revision,
      request: document.getElementById("request").value,
      ...paidFlags(),
    }),
  }).then(({ res }) => {
    if (res.status === 202) watchPreparation();
  });
};

document.getElementById("actRemove").onclick = () => void wordAction("remove");
document.getElementById("actRestore").onclick = () => void wordAction("restore");
document.getElementById("actProtect").onclick = () => void wordAction("protect");
document.getElementById("actUnprotect").onclick = () => void wordAction("unprotect");
document.getElementById("actCorrect").onclick = () => void correctSelection();

document.getElementById("refreshPreview").onclick = () => api("/project/preview", {
  method: "POST", body: JSON.stringify({ baseRevision: project.revision }),
});
document.getElementById("approveFinal").onclick = () => api("/project/approve-final", {
  method: "POST",
  body: JSON.stringify({ baseRevision: project.revision, watchedRevision: project.previewRevision }),
});
document.getElementById("export").onclick = () => api("/project/export", {
  method: "POST", body: JSON.stringify({ baseRevision: project.revision }),
});
document.getElementById("undo").onclick = () => {
  if (project.revision === 0) return;
  api("/project/undo", {
    method: "POST", body: JSON.stringify({ baseRevision: project.revision, revision: project.revision - 1 }),
  });
};

api("/project").then(({ body }) => {
  project = body.project;
  operation = body.operation || null;
  if (project?.preparation?.status === "running") watchPreparation();
  render();
});
