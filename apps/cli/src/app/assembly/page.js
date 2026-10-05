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
import { idleStatus, stepperState, versionPill } from "/editor/topbar.js";
import { ICON } from "/editor/icons.js";

const state = createState({
  project: null, operation: null, selection: new Set(), playhead: null,
  watched: { revision: null, ended: false }, stage: "materiais", transcriptNotice: "",
});
// errorFromPoll: o erro veio de pedido de fundo. notice: aviso até a primeira ação.
const ui = { importing: false, busy: false, label: null, error: null, errorFromPoll: false, notice: null };
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

function setStatus(text, busy, tone = "") {
  const statusEl = document.getElementById("status");
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.dataset.tone = tone;
  statusEl.classList.toggle("busy", !!busy);
  if (busy) statusEl.setAttribute("aria-busy", "true");
  else statusEl.removeAttribute("aria-busy");
}

/** Texto único do rail: erro > ação em voo > operação do servidor > revisão. */
function renderStatus() {
  const previewBusy = previewInflight || previewPending;
  if (state.get("previewBusy") !== previewBusy) state.set("previewBusy", previewBusy);
  if (ui.error) {
    setStatus(ui.error, false, "error");
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
      setStatus(view.title, view.busy, view.tone === "error" ? "error" : "");
      return;
    }
  }
  if (operation && OP_LABEL[operation.stage]) {
    setStatus(OP_LABEL[operation.stage] + "…" + (operation.progress ? " · " + operation.progress : ""), true);
    return;
  }
  if (operation?.stage === "error") {
    setStatus("Erro: " + (operation.error || "falha no processamento"), false, "error");
    return;
  }
  if (ui.notice) {
    setStatus(ui.notice, false);
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
    const idle = idleStatus(p);
    setStatus(idle.text, false, idle.tone);
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
// O erro de uma ação fica até a próxima ação (chamada com rótulo): pedido de
// fundo que dá certo (polling, auto-prévia) só apaga erro de outro pedido de fundo.
async function call(path, opts = {}) {
  const method = (opts.method || "GET").toUpperCase();
  const action = opts.label != null;
  if (ui.importing && method !== "GET") {
    ui.error = "Aguarde o envio dos arquivos terminar antes de alterar o projeto.";
    ui.errorFromPoll = false;
    renderStatus();
    return { res: { ok: false, status: 409 }, body: { error: ui.error } };
  }
  if (action) {
    ui.error = null;
    ui.errorFromPoll = false;
  }
  // O aviso de chegada (pasta do projeto novo) fica até a primeira alteração.
  if (method !== "GET") ui.notice = null;
  // Resposta atrasada (poll lento, POST antigo) não volta o projeto para
  // uma revisão mais velha que a que já está na tela.
  const fresh = (next) => {
    const current = state.get("project");
    return !current || next.revision >= current.revision;
  };
  try {
    const { res, body } = await client.call(path, opts);
    if (res.status === 409) {
      // O 409 diz que a base desta aba está errada: a resposta de reconciliação
      // é a fonte da verdade, mesmo com revisão menor (servidor que voltou
      // à cópia anterior). Só poll e POST passam pela guarda de revisão velha.
      const latest = await client.call("/project");
      if (latest.res.ok && latest.body.project) {
        state.set("project", latest.body.project);
        state.set("operation", latest.body.operation || null);
      }
    }
    if (!res.ok) {
      ui.error = body.error || ("erro " + res.status);
      ui.errorFromPoll = !action;
    } else if (action || ui.errorFromPoll) {
      ui.error = null;
      ui.errorFromPoll = false;
    }
    const current = !body.project || fresh(body.project);
    if (current) {
      for (const key of ["undoRevision", "brollCandidates", "templateProposal", "verificacao", "speechProposal", "supportSwap", "rhythmProposal", "rhythmProfiles", "templateReport"]) {
        if (Object.hasOwn(body, key)) state.set(key, body[key]);
      }
    }
    if (body.project && current) {
      state.set("project", body.project);
      state.set("operation", body.operation || null);
      maybeScheduleAutoPreview(path);
    } else if (!body.project && body.operation !== undefined) {
      state.set("operation", body.operation);
    }
    if (res.ok && res.status !== 202 && method !== "GET") await call("/project");
    renderStatus();
    return { res, body };
  } catch (err) {
    ui.error = (err && err.message) || String(err);
    ui.errorFromPoll = !action;
    renderStatus();
    throw err;
  }
}

const api = {
  call,
  notifyError: (message) => {
    ui.error = message;
    ui.errorFromPoll = false;
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

/** Prévia automática cabe agora? Sem cena, prévia em dia ou servidor preparando/renderizando: não. */
function autoPreviewWanted(p, operation) {
  if (!p || !p.scenes.length) return false;
  if (p.previewRevision === p.revision) return false;
  if (p.preparation && p.preparation.status === "running") return false;
  return !(operation && (operation.stage === "preparing" || operation.stage === "rendering"));
}

function scheduleAutoPreview() {
  if (!autoPreviewWanted(project(), state.get("operation"))) {
    // Desistir também desarma o agendamento anterior: "Atualizando prévia…"
    // não fica preso sem nada para rodar.
    if (previewPending) {
      clearTimeout(previewTimer);
      previewPending = false;
      renderStatus();
    }
    return;
  }
  previewPending = true;
  renderStatus();
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    // O agendamento termina aqui, rodando ou desistindo.
    previewPending = false;
    const current = project();
    if (previewInflight || !autoPreviewWanted(current, state.get("operation"))) {
      renderStatus();
      return;
    }
    const base = current.revision;
    previewInflight = true;
    renderStatus();
    let ok = false;
    try {
      const result = await call("/project/preview", {
        method: "POST",
        body: JSON.stringify({ baseRevision: base }),
      });
      ok = result.res.ok;
    } catch {
      // Sem conexão: o erro já está no status; segue para a reconciliação.
    } finally {
      previewInflight = false;
      renderStatus();
    }
    if (!ok) {
      // Conflito por nova edição (409 sem corpo) ou erro real: reconcilia
      // com o servidor antes de decidir — a operação local pode estar
      // obsoleta e travar o reagendamento (R2).
      await call("/project").catch(() => {});
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
    ui.errorFromPoll = false;
    renderStatus();
    return;
  }
  ui.importing = true;
  ui.notice = null;
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
          ui.errorFromPoll = false;
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
        ui.errorFromPoll = false;
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
const monitorToggle = document.getElementById("monitorToggle");
const narrowViewport = matchMedia("(max-width: 1100px)");
/** Tela estreita: o monitor vira gaveta sobre a bancada. */
function showMonitor(show = true) {
  document.body.classList.toggle("monitor-open", show);
  monitorToggle.setAttribute("aria-expanded", String(show));
}
function applyTranscriptNotice(text) {
  const el = document.getElementById("transcriptNotice");
  if (!el) return;
  const notice = text || "";
  el.textContent = notice;
  el.hidden = notice.length === 0;
  if (notice) el.title = notice;
  else el.removeAttribute("title");
}
/** Pílula de etapas: check nas feitas, cadeado na entrega travada (também na atual), ponto na atual (CSS). */
function paintStages() {
  for (const item of stepperState(project(), state.get("stage"))) {
    const button = document.querySelector('#stages [data-stage="' + item.id + '"]');
    if (!button) continue;
    button.classList.toggle("is-done", item.done);
    button.classList.toggle("is-locked", item.locked);
    button.querySelector(".step-mark").innerHTML = item.done ? ICON.check : item.locked ? ICON.lock : "";
    // O cadeado é decorativo. O nome acessível é que diz que a etapa está travada.
    let lockedName = button.querySelector(":scope > .sr");
    if (item.locked) {
      if (!lockedName) {
        lockedName = document.createElement("span");
        lockedName.className = "sr";
        lockedName.textContent = " travada";
        button.append(lockedName);
      }
    } else if (lockedName) {
      lockedName.remove();
    }
  }
}
function applyStageDom(stage) {
  if (!STAGE_TARGET[stage]) return;
  // A etapa não remonta a bancada: texto e monitor ficam onde estão; só a
  // entrega troca de lugar com o texto no cartão central.
  const focus = document.activeElement;
  document.body.dataset.stage = stage;
  for (const el of document.querySelectorAll("#stages [data-stage]")) {
    if (el.dataset.stage === stage) el.setAttribute("aria-current", "page");
    else el.removeAttribute("aria-current");
  }
  const entrega = stage === "entrega";
  document.getElementById("texto").hidden = entrega;
  document.getElementById("textoHead").hidden = entrega;
  const delivery = document.getElementById("delivery");
  if (delivery) delivery.hidden = !entrega;
  if (stage === "revisao" && narrowViewport.matches) showMonitor(true);
  document.getElementById(STAGE_TARGET[stage])?.scrollIntoView({ block: "nearest" });
  paintStages();
  if (focus && focus !== document.body && focus.isConnected && !focus.closest("[hidden]")
    && document.activeElement !== focus) {
    focus.focus({ preventScroll: true });
  }
}
function setStage(stage) {
  if (!STAGE_TARGET[stage]) return;
  if (state.get("stage") === stage) applyStageDom(stage);
  else state.set("stage", stage);
}
state.subscribe("stage", applyStageDom);
state.subscribe("transcriptNotice", applyTranscriptNotice);
document.getElementById("stages").addEventListener("click", (event) => {
  const button = event.target.closest("[data-stage]");
  if (button) setStage(button.dataset.stage);
});
// Ação principal do rail (revisar/entregar) navega sem chamada paga.
window.addEventListener("decupa:set-stage", (event) => setStage(event.detail));
monitorToggle.onclick = () => showMonitor(!document.body.classList.contains("monitor-open"));
document.getElementById("closeMonitor").onclick = () => { showMonitor(false); monitorToggle.focus(); };
narrowViewport.addEventListener("change", () => showMonitor(false));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.body.classList.contains("monitor-open")
    && !document.querySelector("dialog[open]")) {
    showMonitor(false);
    monitorToggle.focus();
  }
});
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
  document.body.classList.toggle("is-empty", p.assembly.sources.length === 0);
  renderStatus();
  paintStages();
  // 202 de prepare/adjust/prepare-resume trazem preparation running e caem
  // aqui: o polling retoma sem fiação extra nos módulos.
  poller.schedule();
  document.getElementById("projectName").textContent = p.assembly.name && p.assembly.name !== p.id ? p.assembly.name : "Montagem principal";
  const pill = document.getElementById("versionPill");
  const version = versionPill(p);
  pill.textContent = version.text;
  pill.hidden = version.hidden;
});

state.subscribe("operation", () => { renderStatus(); poller.schedule(); });

document.addEventListener("decupa:schedule-preview", () => scheduleAutoPreview());

// Pasta do projeto, injetada pelo servidor no HTML: fica no menu do projeto e,
// na chegada por "Novo projeto" (#novo), no status até a primeira ação.
{
  const dir = document.querySelector('meta[name="decupa-project-dir"]')?.getAttribute("content") || "";
  const line = document.getElementById("projectDirLine");
  if (dir && line) {
    document.getElementById("projectDir").textContent = dir;
    line.hidden = false;
  }
  if (location.hash === "#novo") {
    if (dir) ui.notice = "Projeto novo em " + dir;
    history.replaceState(null, "", location.pathname + location.search);
  }
}

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
