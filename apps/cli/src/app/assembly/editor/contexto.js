// Região de contexto (Task 5): player da prévia, estado das correções de
// texto e pedido em linguagem natural. Cada render assina o estado e porta
// o bloco original do page.js monolítico, mantendo o comentário de
// comportamento. As ações por palavra moram no menu flutuante do texto.
import { watchedState } from "./watched.js";
import { montageDuration } from "./montage.js";

/** Prévia central (#stage): nesta task só ancora; a Task 5 move a lógica. */
export function mountStage() {
  const stage = document.getElementById("stage");
  if (!stage) return;
  if (!document.getElementById("previewPlayer")) {
    const video = document.createElement("video");
    video.id = "previewPlayer";
    video.controls = true;
    video.preload = "metadata";
    stage.prepend(video);
  }
}

/** Última revisão com vídeo conhecido no player (prévia anterior). */
let lastPreviewRev = null;

/** Chip mono (.chip da Task 3): metadados curtos da prévia em linha. */
const chip = (t) => { const s = document.createElement("span"); s.className = "chip"; s.textContent = t; return s; };

/** Desabilita sem reabilitar um botão que ainda tem spinner próprio. */
function setDisabled(el, value) {
  if (!el) return;
  if (el.classList && el.classList.contains("is-loading")) {
    el.disabled = true;
    return;
  }
  el.disabled = !!value;
}

/** Sem checkboxes: o NL ecoa a permissão já concedida no lote (o contrato segue com as flags). */
function paidFlags(project) {
  return {
    modelOptIn: project.permissions.model === true,
    visualOptIn: project.permissions.visual === true,
  };
}

export function mountContexto({ state, api, player }) {
  const root = document.getElementById("contexto");
  root.replaceChildren();

  const preview = document.createElement("section");
  preview.setAttribute("aria-label", "Prévia");
  preview.innerHTML = "<h1>Prévia</h1>"
    + '<video id="previewPlayer" controls preload="metadata"></video>'
    + '<div class="preview-meta" id="previewNote" hidden aria-live="polite"></div>'
    + '<div class="preview-meta" id="deliveryMeta"></div>'
    + '<p class="muted" id="freshChip" aria-live="polite"></p>'
    + '<p class="muted">Assista à prévia atual antes de aprovar.</p>'
    + '<div class="row"><button type="button" id="refreshPreview">Atualizar prévia</button>'
    + '<button type="button" class="primary" id="approveFinal">Aprovar prévia assistida</button></div>';
  root.appendChild(preview);

  // Só o estado das correções mora aqui; as ações por palavra (incluindo
  // corrigir, com campo inline) moram no menu flutuante do texto.
  const review = document.createElement("section");
  review.setAttribute("aria-label", "Correções de texto");
  review.innerHTML = "<h1>Correções de texto</h1>"
    + '<div id="corrections" aria-label="Estado das correções de texto"></div>';
  root.appendChild(review);

  // Pedido em linguagem natural (Task 10): o Preparar montagem mora no rail
  // com confirmação de lote; aqui só o ajuste, com rótulo de custo honesto.
  const briefingActions = document.createElement("section");
  briefingActions.setAttribute("aria-label", "Ajuste");
  briefingActions.innerHTML = "<h1>Ajuste</h1>"
    + '<label>Pedido <textarea id="request" rows="2" placeholder="Ex.: encurtar a abertura"></textarea></label>'
    + '<div class="row"><button type="button" class="primary" id="adjust">Propor mudanças (modelo pago)</button>'
    + '<button type="button" class="danger" id="cancelPrep" hidden>Cancelar</button></div>';
  root.appendChild(briefingActions);

  const previewPlayer = document.getElementById("previewPlayer");

  // Rastreio "assistido de verdade" (Task 9): só a prévia atual conta, e só
  // quando vista até o fim (perto do fim ou evento ended). Troca de src,
  // seek para trás ou revisão nova resetam.
  let lastTime = 0;
  function isPreviewSrc(project) {
    return !!project && project.previewRevision != null
      && previewPlayer.getAttribute("data-rev") === String(project.previewRevision);
  }
  function nearEnd() {
    const duration = previewPlayer.duration;
    return Number.isFinite(previewPlayer.currentTime) && Number.isFinite(duration)
      && duration > 0 && previewPlayer.currentTime >= duration - 0.05;
  }
  function markWatched() {
    const project = state.get("project");
    if (!isPreviewSrc(project)) return;
    state.set("watched", { revision: project.previewRevision, ended: true });
  }
  function resetWatched() {
    state.set("watched", { revision: null, ended: false });
    lastTime = previewPlayer.currentTime || 0;
  }
  previewPlayer.addEventListener("timeupdate", () => {
    if (!Number.isFinite(previewPlayer.currentTime)) return;
    lastTime = previewPlayer.currentTime;
    if (nearEnd()) markWatched();
  });
  previewPlayer.addEventListener("ended", markWatched);
  previewPlayer.addEventListener("seeked", () => {
    if (!Number.isFinite(previewPlayer.currentTime)) return;
    if (previewPlayer.currentTime < lastTime - 0.25) resetWatched();
    else lastTime = previewPlayer.currentTime;
  });
  previewPlayer.addEventListener("loadstart", () => {
    lastTime = 0;
    state.set("watched", { revision: null, ended: false });
  });

  function backgroundBusy(project, operation) {
    const OP_LABEL = {
      analyzing: "Analisando mídia",
      preparing: "Preparando montagem",
      rendering: "Renderizando prévia",
      proposing: "Propondo cenas",
    };
    if (operation && OP_LABEL[operation.stage]) return true;
    if (project && project.preparation && project.preparation.status === "running") return true;
    if (player.previewBusy()) return true;
    return false;
  }

  /** Chip de frescor + gate do botão aprovar (Task 9). */
  function renderFreshness(project) {
    if (!project) return;
    const status = watchedState(project, state.get("watched"));
    const chip = document.getElementById("freshChip");
    if (chip) chip.textContent = status.label;
    setDisabled(document.getElementById("approveFinal"), !status.canApprove);
  }

  function renderPreview(project) {
    if (!project.scenes.length) return;
    // Metadados da prévia em linha de chips mono (Task 4).
    document.getElementById("deliveryMeta").replaceChildren(
      chip("prévia " + project.previewRevision),
      chip(Math.round(montageDuration(project)) + "s"),
      chip(project.assembly.width + "×" + project.assembly.height
        + " @ " + project.assembly.fps.num + "/" + project.assembly.fps.den),
    );
    // Notas de transição ("atualizando…") também viram chips.
    const noteEl = document.getElementById("previewNote");
    const note = (visible, ...chips) => {
      if (!noteEl) return;
      noteEl.hidden = !visible;
      noteEl.replaceChildren(...chips);
    };
    const current = project.previewRevision != null && project.previewRevision === project.revision;
    if (project.previewRevision != null) {
      const src = "/project/output/" + project.previewRevision + "/mp4";
      if (previewPlayer.getAttribute("data-rev") !== String(project.previewRevision)) {
        const time = previewPlayer.currentTime;
        previewPlayer.src = src;
        previewPlayer.setAttribute("data-rev", String(project.previewRevision));
        previewPlayer.removeAttribute("data-prev");
        previewPlayer.currentTime = time;
        // Troca de src invalida o "assistido" (o loadstart cobre o resto).
        state.set("watched", { revision: null, ended: false });
        lastTime = Number.isFinite(time) ? time : 0;
      }
      lastPreviewRev = project.previewRevision;
      if (!current) {
        note(true,
          chip("prévia " + project.previewRevision),
          chip("atualizando → " + project.revision));
      } else {
        note(false);
      }
    } else if (previewPlayer.hasAttribute("src")) {
      // Mantém o último vídeo válido como prévia anterior enquanto renderiza (V4).
      note(true,
        chip(lastPreviewRev != null ? "prévia " + lastPreviewRev : "prévia anterior"),
        chip("atualizando → " + project.revision));
    } else if (project.revision > 0) {
      // Recarregou com prévia invalidada: tenta a revisão anterior do disco.
      const prev = project.revision - 1;
      previewPlayer.src = "/project/output/" + prev + "/mp4";
      previewPlayer.setAttribute("data-prev", String(prev));
      lastPreviewRev = prev;
      note(true,
        chip("prévia " + prev),
        chip("atualizando → " + project.revision));
    } else {
      previewPlayer.removeAttribute("src");
      previewPlayer.removeAttribute("data-rev");
      note(true, chip("sem prévia"));
    }
    renderFreshness(project);
    // Atualizar prévia renderiza no servidor: bloqueia o segundo clique.
    setDisabled(
      document.getElementById("refreshPreview"),
      project.scenes.length === 0
      || (current && project.previewArtifact?.revision === project.revision)
      || backgroundBusy(project, state.get("operation")),
    );
  }

  /** Estado pending/error das correções; alinhadas já estão no catálogo (V3). */
  function renderCorrections(project) {
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

  function render(project) {
    if (!project) return;
    const operation = state.get("operation");
    renderCorrections(project);
    renderPreview(project);
    const preparing = project.preparation
      && project.preparation.status === "running";
    document.getElementById("cancelPrep").hidden = !(
      preparing || (operation && operation.stage === "preparing")
    );
    // Ajustar dispara trabalho longo no servidor: evita o segundo clique
    // parecer travado (o servidor cancelaria o anterior).
    const bg = backgroundBusy(project, operation);
    setDisabled(document.getElementById("adjust"), bg);
    // Rótulo de custo honesto (Task 10): pago até conceder, autorizado depois.
    document.getElementById("adjust").textContent = project.permissions.model === true
      ? "Propor mudanças (já autorizado)"
      : "Propor mudanças (modelo pago)";
  }

  document.getElementById("cancelPrep").onclick = () => api.call(
    "/project/cancel",
    { method: "POST", body: "{}", label: "Cancelando…" },
  );
  document.getElementById("adjust").onclick = () => api.call("/project/adjust", {
    method: "POST",
    body: JSON.stringify({
      baseRevision: state.get("project").revision,
      request: document.getElementById("request").value,
      ...paidFlags(state.get("project")),
    }),
    label: "Ajustando montagem…",
  });

  document.getElementById("refreshPreview").onclick = () => api.call("/project/preview", {
    method: "POST", body: JSON.stringify({ baseRevision: state.get("project").revision }),
    label: "Renderizando prévia…",
  }).then(({ res }) => {
    if (!res.ok) {
      // Preview obsoleto (409) ou erro real: reconcilia com o servidor e
      // retoma a revisão atual sem loop (R2). O bootstrap (page.js) escuta
      // este evento e reage com scheduleAutoPreview direto (sem filtro).
      void api.call("/project").then(() => {
        document.dispatchEvent(new CustomEvent("decupa:schedule-preview"));
      });
    }
  });
  document.getElementById("approveFinal").onclick = () => {
    // O front nunca mente: só parte com canApprove e envia a revisão
    // assistida de verdade do state (o back-end rejeita divergência).
    const project = state.get("project");
    const watched = state.get("watched") || { revision: null, ended: false };
    if (!watchedState(project, watched).canApprove) {
      api.notifyError("Assista à prévia atual até o fim antes de aprovar.");
      return;
    }
    void api.call("/project/approve-final", {
      method: "POST",
      body: JSON.stringify({
        baseRevision: project.revision,
        watchedRevision: watched.revision,
      }),
      label: "Aprovando prévia…",
    });
  };
  state.subscribe("project", render);
  state.subscribe("operation", () => render(state.get("project")));
  state.subscribe("watched", () => renderFreshness(state.get("project")));
  render(state.get("project"));
}
