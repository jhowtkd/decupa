// Bootstrap da casca de 4 regiões (Task 5): importa os módulos, cria
// state/api, liga o status ao rail e renderiza o centro (os dois documentos
// do spec). Sem gestos novos — a interação no ponto vem na Task 6.
import { createState } from "/editor/state.js";
import { createApi } from "/editor/api.js";
import { mountRail } from "/editor/rail.js";
import { mountContexto } from "/editor/contexto.js";
import { effectiveWords, takeWords, montageTimeOfWord } from "/editor/montage.js";

const state = createState({ project: null, operation: null, selection: new Set(), playhead: null, watched: { revision: null, ended: false } });
const ui = { busy: false, label: null, error: null };
/** Última revisão com vídeo conhecido no player (prévia anterior). */
let previewTimer = 0;
let previewInflight = false;
let previewPending = false;
let correctPoll = 0;
let pollTimer = 0;

const OP_LABEL = {
  analyzing: "Analisando mídia",
  preparing: "Preparando montagem",
  rendering: "Renderizando prévia",
  proposing: "Propondo cenas",
};

function project() {
  return state.get("project");
}

function setStatus(text, busy) {
  const statusEl = document.getElementById("status");
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.classList.toggle("busy", !!busy);
  if (busy) statusEl.setAttribute("aria-busy", "true");
  else statusEl.removeAttribute("aria-busy");
}

/** Texto único do rail: erro > ação em voo > operação do servidor > revisão. */
function renderStatus() {
  if (ui.error) {
    setStatus(ui.error, false);
    return;
  }
  if (ui.label) {
    setStatus(ui.label, true);
    return;
  }
  const operation = state.get("operation");
  const p = project();
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
  if (p && p.preparation && p.preparation.status === "running") {
    setStatus("Preparando… etapa " + p.preparation.stage, true);
    return;
  }
  if (previewInflight || previewPending) {
    setStatus("Atualizando prévia…", true);
    return;
  }
  if (p && (p.corrections || []).some((item) => item.status === "pending")) {
    setStatus("Alinhando correção…", true);
    return;
  }
  if (p) {
    setStatus("revisão " + p.revision, false);
    return;
  }
  setStatus("carregando…", true);
}

function sourceName(id) {
  const p = project();
  const found = p && p.assembly.sources.find((item) => item.id === id);
  return found ? found.name : id;
}

const client = createApi({
  onStatus: (s) => {
    ui.busy = s.busy;
    ui.label = s.label;
    renderStatus();
  },
});

// Resposta com projeto sincroniza o estado (era o corpo do api() antigo) e
// dispara a auto-prévia; erro valida ui.error como o lastError de antes.
async function call(path, opts = {}) {
  if (opts.label != null) ui.error = null;
  try {
    const { res, body } = await client.call(path, opts);
    if (!res.ok) ui.error = body.error || ("erro " + res.status);
    else ui.error = null;
    if (body.project) {
      state.set("project", body.project);
      state.set("operation", body.operation || null);
      maybeScheduleAutoPreview(path);
    } else if (body.operation !== undefined) {
      state.set("operation", body.operation);
    }
    renderStatus();
    return { res, body };
  } catch (err) {
    ui.error = (err && err.message) || String(err);
    renderStatus();
    throw err;
  }
}

const api = {
  call,
  notifyError: (message) => {
    ui.error = message;
    renderStatus();
  },
};

const player = {
  el() {
    return document.getElementById("previewPlayer");
  },
  previewBusy() {
    return previewInflight || previewPending;
  },
  playOriginal(sourceId) {
    const el = this.el();
    if (!el) return;
    el.src = "/project/media/" + encodeURIComponent(sourceId) + "?view=playback";
    el.removeAttribute("data-rev");
    el.play().catch(() => {});
  },
  seek(seconds) {
    if (seconds == null) return;
    const el = this.el();
    if (!el) return;
    const p = project();
    if (p && p.previewRevision != null) {
      const src = "/project/output/" + p.previewRevision + "/mp4";
      if (el.getAttribute("data-rev") !== String(p.previewRevision)) {
        el.src = src;
        el.setAttribute("data-rev", String(p.previewRevision));
      }
    }
    const apply = () => {
      try {
        el.currentTime = seconds;
      } catch {
        // Player ainda sem metadados; o listener de loadedmetadata tenta de novo.
      }
    };
    if (el.readyState >= 1) apply();
    else el.addEventListener("loadedmetadata", apply, { once: true });
  },
};

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
  const p = project();
  const operation = state.get("operation");
  if (!p || !p.scenes.length) return;
  if (p.previewRevision === p.revision) return;
  if (p.preparation && p.preparation.status === "running") return;
  if (operation && (operation.stage === "preparing" || operation.stage === "rendering")) return;
  previewPending = true;
  renderStatus();
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const current = project();
    const op = state.get("operation");
    if (previewInflight || !current) return;
    if (current.previewRevision === current.revision || !current.scenes.length) return;
    if (current.preparation && current.preparation.status === "running") return;
    if (op && (op.stage === "preparing" || op.stage === "rendering")) return;
    const base = current.revision;
    previewPending = false;
    previewInflight = true;
    renderStatus();
    let ok = false;
    try {
      const result = await call("/project/preview", {
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
      await call("/project");
    }
    // Reagenda só se a revisão andou (edição durante o render); erro real
    // de render não entra em loop: fica para o botão manual.
    const latest = project();
    if (latest && latest.revision !== base
      && latest.previewRevision !== latest.revision && latest.scenes.length) {
      scheduleAutoPreview();
    }
  }, 900);
}

/** Rebusca o projeto até o alinhamento da correção concluir (V3). */
function watchCorrections() {
  clearTimeout(correctPoll);
  const tick = async () => {
    const p = project();
    if (!p) return;
    if (!(p.corrections || []).some((item) => item.status === "pending")) return;
    await call("/project");
    const latest = project();
    if (latest && (latest.corrections || []).some((item) => item.status === "pending")) {
      correctPoll = setTimeout(tick, 800);
    }
  };
  correctPoll = setTimeout(tick, 800);
}

function watchPreparation() {
  clearTimeout(pollTimer);
  const tick = async () => {
    const { body } = await call("/project");
    const prep = body.project && body.project.preparation;
    const op = body.operation;
    const busy = (op && op.stage && op.stage !== "ready" && op.stage !== "cancelled" && op.stage !== "error")
      || (prep && prep.status === "running");
    if (busy) {
      pollTimer = setTimeout(tick, 600);
    } else if (prep && prep.status !== "running" && (body.project.scenes || []).length > 0) {
      document.getElementById("texto").scrollIntoView();
    }
  };
  pollTimer = setTimeout(tick, 600);
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
      ui.label = label;
      renderStatus();
      try {
        const res = await fetch(
          "/project/import?baseRevision=" + project().revision + "&name=" + encodeURIComponent(file.name),
          { method: "POST", headers: { "x-file-size": String(file.size) }, body: file },
        );
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          ui.error = body.error || ("erro " + res.status);
          renderStatus();
          return;
        }
        ui.error = null;
        if (body.project) {
          state.set("project", body.project);
          state.set("operation", body.operation || null);
        }
      } finally {
        ui.label = null;
        renderStatus();
      }
    }
    // Os renders correm pela assinatura de "project" (era render() aqui).
  } finally {
    drop.removeAttribute("aria-disabled");
  }
}

/* ---- Centro: os dois documentos do spec (ainda sem gestos novos) ---- */

function esc(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

/**
 * Chave da ocorrência editorial selecionada (mesma serialização do contexto;
 * a Task 6 unifica em texto.js): cena/take/palavra (R3).
 */
function selectionKey(sceneId, takeId, wordId) {
  return sceneId + "\0" + takeId + "\0" + wordId;
}

/** Descarta seleções cujas ocorrências saíram do catálogo (ex.: correção alinhada). */
function pruneSelection(p) {
  const selection = state.get("selection") || new Set();
  const known = new Set();
  for (const scene of p.scenes) {
    for (const take of scene.takes) {
      for (const word of takeWords(p, scene, take)) {
        known.add(selectionKey(scene.id, take.id, word.id));
      }
    }
    // Sem UI de inclusão nesta casca (Task 6): chaves de omitidas ("take
    // vazio") ainda não são criadas e caem aqui até lá.
  }
  let changed = false;
  for (const key of [...selection]) {
    if (!known.has(key)) {
      selection.delete(key);
      changed = true;
    }
  }
  if (changed) state.set("selection", new Set(selection));
}

function renderTranscript(p) {
  const running = p.preparation && p.preparation.status === "running";
  let html = "";
  for (const source of p.assembly.sources) {
    const analysis = p.analyses.find((item) => item.sourceId === source.id);
    const statusText = analysis ? analysis.status : "na fila";
    html += '<section class="doc-source"><h2>' + esc(source.name) + " · " + esc(statusText)
      + (running ? ' <span class="parcial">· parcial</span>' : "") + "</h2>";
    const words = effectiveWords(p, source.id);
    if (!words.length) {
      html += '<p class="muted">transcrição ainda não disponível.</p>';
    } else {
      html += '<p class="prose">' + words.map((w) => esc(w.text)).join(" ") + "</p>";
    }
    html += "</section>";
  }
  return html;
}

function renderProse(p) {
  const selection = state.get("selection") || new Set();
  let html = "";
  p.scenes.forEach((scene, index) => {
    html += '<section class="scene"><p class="scene-head">Cena ' + (index + 1)
      + (scene.objective ? " · " + esc(scene.objective) : "") + "</p>";
    if (scene.rationale) html += '<p class="muted">' + esc(scene.rationale) + "</p>";
    for (const take of scene.takes) {
      const source = p.assembly.sources.find((item) => item.id === take.sourceId);
      html += '<div class="take"><div class="src">' + esc(source ? source.name : take.sourceId)
        + " · " + take.start.toFixed(1) + "s–" + take.end.toFixed(1) + "s</div><p class=\"prose\">";
      for (const word of takeWords(p, scene, take)) {
        const key = selectionKey(scene.id, take.id, word.id);
        html += '<button type="button" class="word'
          + (word.removed ? " riscado" : "")
          + (word.protected ? " protected" : "")
          + (word.corrected ? " corrected" : "") + '"'
          + ' data-word-id="' + esc(word.id) + '"'
          + ' data-scene="' + esc(scene.id) + '"'
          + ' data-take="' + esc(take.id) + '"'
          + ' aria-pressed="' + (selection.has(key) ? "true" : "false") + '"'
          + ' aria-label="' + esc(word.text + (word.removed ? " (removida)" : "")) + '"'
          + ">" + esc(word.display || word.text) + "</button> ";
      }
      html += "</p></div>";
    }
    if (scene.gaps.length) {
      html += '<p class="warn">lacunas: ' + esc(scene.gaps.join("; ")) + "</p>";
    }
    html += "</section>";
  });
  return html;
}

function renderCenter(p) {
  const texto = document.getElementById("texto");
  const dropzone = document.getElementById("dropzone");
  if (!p) return;
  // Preservação de foco (V8): a palavra focada volta após o re-render.
  const focused = document.activeElement?.dataset;
  const focusedKey = focused && focused.wordId !== undefined
    ? { scene: focused.scene || "", take: focused.take || "", word: focused.wordId }
    : null;
  if (p.assembly.sources.length === 0) {
    dropzone.hidden = false;
    texto.hidden = true;
    texto.replaceChildren();
    return;
  }
  dropzone.hidden = true;
  texto.hidden = false;
  const html = p.scenes.length === 0 ? renderTranscript(p) : renderProse(p);
  texto.innerHTML = html;
  if (focusedKey) {
    texto.querySelector(
      `[data-scene="${CSS.escape(focusedKey.scene)}"][data-take="${CSS.escape(focusedKey.take)}"]`
      + `[data-word-id="${CSS.escape(focusedKey.word)}"]`,
    )?.focus();
  }
}

function textoClickSetup() {
  document.getElementById("texto").addEventListener("click", (ev) => {
    const btn = ev.target.closest("button.word");
    if (!btn) return;
    const key = selectionKey(btn.dataset.scene, btn.dataset.take, btn.dataset.wordId);
    const selection = new Set(state.get("selection") || []);
    if (selection.has(key)) selection.delete(key);
    else selection.add(key);
    state.set("selection", selection);
    btn.setAttribute("aria-pressed", selection.has(key) ? "true" : "false");
    // Selecionar posiciona a reprodução no trecho (V6).
    const p = project();
    const scene = p.scenes.find((item) => item.id === btn.dataset.scene);
    const take = scene?.takes.find((item) => item.id === btn.dataset.take);
    const word = take && takeWords(p, scene, take).find((item) => item.id === btn.dataset.wordId);
    if (word) player.seek(montageTimeOfWord(p, scene.id, take.id, word));
  });
}

/* ---- Fiação ---- */

mountContexto({ state, api, player });
mountRail({ state, api, player });
textoClickSetup();

state.subscribe("project", (p) => {
  if (!p) return;
  pruneSelection(p);
  renderCenter(p);
  renderStatus();
  // 202 de prepare/adjust/prepare-resume trazem preparation running e caem
  // aqui: o polling retoma sem fiação extra nos módulos.
  if (p.preparation && p.preparation.status === "running") watchPreparation();
  if ((p.corrections || []).some((item) => item.status === "pending")) watchCorrections();
});

document.addEventListener("decupa:schedule-preview", () => scheduleAutoPreview());

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

renderStatus();
call("/project", { label: "Carregando…" }).then(() => {
  scheduleAutoPreview();
});
