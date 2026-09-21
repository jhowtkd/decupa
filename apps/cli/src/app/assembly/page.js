import { mountTemplates } from "/editor/templates.js";
// Bootstrap da casca de 4 regiões (Tasks 5-6): importa os módulos, cria
// state/api/player e monta cada região — o centro (texto.js) renderiza os
// dois documentos do spec com os gestos de edição no ponto.
import { createState } from "/editor/state.js";
import { createApi, createProjectPoller } from "/editor/api.js";
import { mountRail, preparationView } from "/editor/rail.js";
import { mountContexto, mountStage } from "/editor/contexto.js";
import { mountTexto } from "/editor/texto.js";
import { mountSequencia } from "/editor/sequencia.js";

const state = createState({ project: null, operation: null, selection: new Set(), playhead: null, watched: { revision: null, ended: false } });
const ui = { importing: false, busy: false, label: null, error: null };
/** Última revisão com vídeo conhecido no player (prévia anterior). */
let previewTimer = 0;
let previewInflight = false;
let previewPending = false;

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
  const previewBusy = previewInflight || previewPending;
  if (state.get("previewBusy") !== previewBusy) state.set("previewBusy", previewBusy);
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
  if (p?.preparation) {
    const view = preparationView(p, operation);
    if (view.busy || view.tone === "error" || p.preparation.status === "cancelled") {
      setStatus(view.title, view.busy);
      return;
    }
  }
  if (operation && OP_LABEL[operation.stage]) {
    setStatus(OP_LABEL[operation.stage] + "…" + (operation.progress ? " · " + operation.progress : ""), true);
    return;
  }
  if (operation?.stage === "error") {
    setStatus("Erro: " + (operation.error || "falha no processamento"), false);
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
  if (ui.importing && (opts.method || "GET").toUpperCase() !== "GET") {
    ui.error = "Aguarde o envio dos arquivos terminar antes de alterar o projeto.";
    renderStatus();
    return { res: { ok: false, status: 409 }, body: { error: ui.error } };
  }
  if (opts.label != null) ui.error = null;
  try {
    const { res, body } = await client.call(path, opts);
    if (res.status === 409) {
      const latest = await client.call("/project");
      if (latest.res.ok && latest.body.project) {
        state.set("project", latest.body.project);
        state.set("operation", latest.body.operation || null);
      }
    }
    if (!res.ok) ui.error = body.error || ("erro " + res.status);
    else ui.error = null;
    for (const key of ["undoRevision", "brollCandidates", "templateProposal", "verificacao", "speechProposal", "supportSwap", "rhythmProposal", "rhythmProfiles", "templateReport"]) {
      if (Object.hasOwn(body, key)) state.set(key, body[key]);
    }
    if (body.project) {
      state.set("project", body.project);
      state.set("operation", body.operation || null);
      maybeScheduleAutoPreview(path);
    } else if (body.operation !== undefined) {
      state.set("operation", body.operation);
    }
    if (res.ok && res.status !== 202 && (opts.method || "GET").toUpperCase() !== "GET") await call("/project");
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
  playOriginal(sourceId, start, end) {
    const el = this.el();
    if (!el) return;
    el.src = "/project/media/" + encodeURIComponent(sourceId) + "?view=playback"
      + (start != null && end != null ? "#t=" + start.toFixed(2) + "," + end.toFixed(2) : "");
    el.removeAttribute("data-rev");
    el.dataset.source = sourceId;
    state.set("view", "original");
    el.play().catch(() => {});
  },
  seek(seconds) {
    if (seconds == null) return;
    const el = this.el();
    if (!el) return;
    const p = project();
    el.removeAttribute("data-source");
    if (state.get("view") !== "montagem") state.set("view", "montagem");
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

const poller = createProjectPoller({
  refresh: () => call("/project"),
  isBusy: () => {
    const p = project();
    const op = state.get("operation");
    return p?.preparation?.status === "running"
      || (p?.corrections || []).some((item) => item.status === "pending")
      || !!(op && OP_LABEL[op.stage]);
  },
});

async function importFiles(files) {
  if (ui.importing || ui.busy) {
    ui.error = "Aguarde a operação atual terminar antes de enviar mais arquivos.";
    renderStatus();
    return;
  }
  ui.importing = true;
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
      } catch (err) {
        ui.error = err instanceof TypeError
          ? "Sem conexão com o Decupa. Confira o terminal do aplicativo, reabra o mesmo projeto e recarregue esta página antes de tentar importar novamente."
          : (err && err.message) || String(err);
        return;
      } finally {
        ui.label = null;
        renderStatus();
      }
    }
    // Os renders correm pela assinatura de "project" (era render() aqui).
  } finally {
    ui.importing = false;
    drop.removeAttribute("aria-disabled");
  }
}

/* ---- Fiação ---- */

mountStage({ state, api, player });
mountContexto({ state, api, player });
mountRail({ state, api, player });
mountTemplates({state,api});
mountTexto({ state, api, player });
mountSequencia({ state, api, player });

const STAGE_TARGET = { materiais: "rail", edicao: "texto", revisao: "stage", entrega: "delivery" };
const inspector = document.getElementById("contexto");
const inspectTool = document.getElementById("inspectTool");
function showInspector(show = true) {
  inspector.hidden = !show;
  inspectTool.setAttribute("aria-expanded", String(show));
  document.body.classList.toggle("inspector-open", show);
}
function setStage(stage) {
  if (!STAGE_TARGET[stage]) return;
  document.body.dataset.stage = stage;
  for (const el of document.querySelectorAll("#stages [data-stage]")) {
    if (el.dataset.stage === stage) el.setAttribute("aria-current", "page");
    else el.removeAttribute("aria-current");
  }
  document.getElementById("rail").hidden = !["materiais", "edicao"].includes(stage);
  document.getElementById("faixa").hidden = stage !== "edicao";
  const editing = stage === "edicao";
  document.getElementById("texto").hidden = !editing;
  document.getElementById("center").classList.toggle("with-text", editing);
  document.querySelector('[data-tool="texto"]').setAttribute("aria-pressed", String(editing));
  const delivery = document.getElementById("delivery");
  (stage === "entrega" ? document.getElementById("center") : inspector).appendChild(delivery);
  delivery.hidden = stage !== "entrega";
  showInspector(false);
}
document.getElementById("stages").addEventListener("click", (event) => {
  const button = event.target.closest("[data-stage]");
  if (button) setStage(button.dataset.stage);
});
// Ação principal do rail (revisar/entregar) navega sem chamada paga.
window.addEventListener("decupa:set-stage", (event) => setStage(event.detail));
const toolTexto = document.querySelector('[data-tool="texto"]');
toolTexto.addEventListener("click", () => {
  if (document.body.dataset.stage !== "edicao") { setStage("edicao"); return; }
  const texto = document.getElementById("texto");
  const show = texto.hidden;
  texto.hidden = !show;
  document.getElementById("center").classList.toggle("with-text", show);
  toolTexto.setAttribute("aria-pressed", String(show));
});
inspectTool.setAttribute("aria-controls", "contexto");
inspectTool.onclick = () => showInspector(inspector.hidden);
document.getElementById("closeInspector").onclick = () => { showInspector(false); inspectTool.focus(); };
const narrowViewport = matchMedia("(max-width: 1100px)");
narrowViewport.addEventListener("change", () => { showInspector(false); });
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !inspector.hidden && !document.querySelector("dialog[open]")) {
    showInspector(false); inspectTool.focus();
  }
});
document.getElementById("mediaTool").onclick = () => setStage("materiais");
document.getElementById("reviewAction").onclick = () => setStage("revisao");
document.getElementById("deliveryAction").onclick = () => setStage("entrega");
setStage("materiais");

// O player emite o tempo; a faixa-bússola assina "playhead" (Task 7).
// O elemento persiste (só o src troca), então uma fiação basta.
{
  const previewEl = player.el();
  if (previewEl) {
    previewEl.addEventListener("timeupdate", () => {
      state.set("playhead", previewEl.hasAttribute("data-rev") && Number.isFinite(previewEl.currentTime) ? previewEl.currentTime : null);
    });
  }
}

state.subscribe("project", (p) => {
  if (!p) return;
  renderStatus();
  // 202 de prepare/adjust/prepare-resume trazem preparation running e caem
  // aqui: o polling retoma sem fiação extra nos módulos.
  poller.schedule();
  document.getElementById("projectName").textContent = p.assembly.name && p.assembly.name !== p.id ? p.assembly.name : "Montagem principal";
});

state.subscribe("operation", () => { renderStatus(); poller.schedule(); });

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

// A bancada recebe arrastes tanto no estado vazio quanto durante a edição.
const textoEl = document.getElementById("center");
textoEl.addEventListener("dragover", (ev) => {
  ev.preventDefault();
});
textoEl.addEventListener("drop", (ev) => {
  if (ev.dataTransfer.files.length) {
    ev.preventDefault();
    void importFiles([...ev.dataTransfer.files]);
  }
});

renderStatus();
call("/project", { label: "Carregando…" }).then(() => {
  scheduleAutoPreview();
});
