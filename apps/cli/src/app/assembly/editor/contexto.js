// Região de contexto (Task 5): player da prévia, revisão por seleção e
// pedido em linguagem natural. Cada render assina o estado e porta o bloco
// original do page.js monolítico, mantendo o comentário de comportamento.
import { takeWords } from "./montage.js";

/** Última revisão com vídeo conhecido no player (prévia anterior). */
let lastPreviewRev = null;

/** Desabilita sem reabilitar um botão que ainda tem spinner próprio. */
function setDisabled(el, value) {
  if (!el) return;
  if (el.classList && el.classList.contains("is-loading")) {
    el.disabled = true;
    return;
  }
  el.disabled = !!value;
}

/**
 * Chave da ocorrência editorial selecionada: cena/take/palavra. A palavra
 * mantém sua identidade na fonte (wordId), mas a seleção distingue em qual
 * take ela foi clicada — o mesmo ID pode existir no take antigo (removido)
 * e no take reincluído (R3).
 */
function selectionKey(sceneId, takeId, wordId) {
  return sceneId + "\0" + takeId + "\0" + wordId;
}

const WORD_ACTION_LABEL = {
  remove: "Removendo trecho…",
  restore: "Restaurando trecho…",
  protect: "Preservando trecho…",
  unprotect: "Liberando trecho…",
};

function paidFlags() {
  return {
    modelOptIn: document.getElementById("modelOptIn").checked,
    visualOptIn: document.getElementById("visualOptIn").checked,
  };
}

export function mountContexto({ state, api, player }) {
  const root = document.getElementById("contexto");
  root.replaceChildren();

  const preview = document.createElement("section");
  preview.setAttribute("aria-label", "Prévia");
  preview.innerHTML = "<h1>Prévia</h1>"
    + '<video id="previewPlayer" controls preload="metadata"></video>'
    + '<p class="muted" id="previewNote" hidden aria-live="polite"></p>'
    + '<p class="muted" id="deliveryMeta"></p>'
    + '<p class="muted">Assista à prévia atual antes de aprovar.</p>'
    + '<div class="row"><button type="button" id="refreshPreview">Atualizar prévia</button>'
    + '<button type="button" id="approveFinal">Aprovar prévia assistida</button>'
    + '<button type="button" id="undo">Desfazer edição</button></div>';
  root.appendChild(preview);

  const review = document.createElement("section");
  review.setAttribute("aria-label", "Revisão por seleção");
  review.innerHTML = "<h1>Revisão por seleção</h1>"
    + '<div class="row" aria-label="Ações de palavra">'
    + '<button type="button" id="actRemove">Remover</button>'
    + '<button type="button" id="actRestore">Restaurar</button>'
    + '<button type="button" id="actProtect">Preservar</button>'
    + '<button type="button" id="actUnprotect">Liberar</button></div>'
    + '<label>Correção do trecho <input type="text" id="correctText" placeholder="Correção do trecho"></label>'
    + '<div class="row"><button type="button" id="actCorrect">Corrigir texto</button></div>'
    + '<div id="corrections" aria-label="Estado das correções de texto"></div>';
  root.appendChild(review);

  const briefingActions = document.createElement("section");
  briefingActions.setAttribute("aria-label", "Preparação e ajuste");
  briefingActions.innerHTML = "<h1>Preparação e ajuste</h1>"
    + '<label class="muted"><input type="checkbox" id="modelOptIn"> modelo pago (Z.ai)</label>'
    + '<label class="muted"><input type="checkbox" id="visualOptIn"> visual pago (Z.ai)</label>'
    + '<div class="row"><button type="button" class="primary" id="prepare">Preparar montagem</button>'
    + '<button type="button" id="cancelPrep" hidden>Cancelar</button></div>'
    + '<label>Pedido <textarea id="request" rows="2" placeholder="Ex.: encurtar a abertura"></textarea></label>'
    + '<div class="row"><button type="button" id="adjust">Propor mudanças (modelo pago)</button></div>';
  root.appendChild(briefingActions);

  const previewPlayer = document.getElementById("previewPlayer");

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

  function renderPreview(project) {
    if (!project.scenes.length) return;
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

  function selectedTake(project) {
    const selection = state.get("selection") || new Set();
    const groups = new Map();
    for (const scene of project.scenes) {
      for (const take of scene.takes) {
        const prefix = scene.id + "\0" + take.id + "\0";
        const catalog = new Map(takeWords(project, scene, take).map((word) => [word.id, word]));
        const words = [];
        for (const key of selection) {
          if (!key.startsWith(prefix)) continue;
          const word = catalog.get(key.slice(prefix.length));
          if (word) words.push(word);
        }
        if (words.length) groups.set(scene.id + "\0" + take.id, { scene, take, words });
      }
    }
    return groups.size === 1 ? groups.values().next().value : null;
  }

  async function wordAction(type) {
    const project = state.get("project");
    const group = selectedTake(project);
    if (!group) {
      api.notifyError("Selecione palavras de um mesmo trecho.");
      return;
    }
    const ordered = group.words.slice().sort((a, b) => a.start - b.start);
    await api.call("/project/edit", {
      method: "POST",
      body: JSON.stringify({
        baseRevision: project.revision,
        action: { type, sceneId: group.scene.id, takeId: group.take.id, wordIds: ordered.map((w) => w.id) },
      }),
      label: WORD_ACTION_LABEL[type] || "Aplicando edição…",
    });
  }

  async function correctSelection() {
    const project = state.get("project");
    const group = selectedTake(project);
    const text = document.getElementById("correctText").value.trim();
    if (!group) {
      api.notifyError("Selecione palavras de um mesmo trecho.");
      return;
    }
    if (!text) {
      api.notifyError("Digite o texto corrigido.");
      return;
    }
    const ordered = group.words.slice().sort((a, b) => a.start - b.start);
    await api.call("/project/edit", {
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
      label: "Enviando correção…",
    });
    document.getElementById("correctText").value = "";
    // O alinhamento conclui em background; a assinatura de "project" no
    // page.js retoma o polling e o catálogo na tela (V3).
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
    // Preparar/ajustar disparam trabalhos longos no servidor: evita o segundo
    // clique parecer travado (o servidor cancelaria o anterior).
    const bg = backgroundBusy(project, operation);
    setDisabled(document.getElementById("prepare"), bg);
    setDisabled(document.getElementById("adjust"), bg);
  }

  document.getElementById("actRemove").onclick = () => void wordAction("remove");
  document.getElementById("actRestore").onclick = () => void wordAction("restore");
  document.getElementById("actProtect").onclick = () => void wordAction("protect");
  document.getElementById("actUnprotect").onclick = () => void wordAction("unprotect");
  document.getElementById("actCorrect").onclick = () => void correctSelection();

  document.getElementById("prepare").onclick = () => api.call("/project/prepare", {
    method: "POST",
    body: JSON.stringify({ baseRevision: state.get("project").revision, request: "", ...paidFlags() }),
    label: "Iniciando preparação…",
  });
  document.getElementById("cancelPrep").onclick = () => api.call(
    "/project/cancel",
    { method: "POST", body: "{}", label: "Cancelando…" },
  );
  document.getElementById("adjust").onclick = () => api.call("/project/adjust", {
    method: "POST",
    body: JSON.stringify({
      baseRevision: state.get("project").revision,
      request: document.getElementById("request").value,
      ...paidFlags(),
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
  document.getElementById("approveFinal").onclick = () => api.call("/project/approve-final", {
    method: "POST",
    // Task 9 rastreia "assistida até o fim" de verdade (timeupdate/ended);
    // até lá, mantém o envio atual de previewRevision.
    body: JSON.stringify({
      baseRevision: state.get("project").revision,
      watchedRevision: state.get("project").previewRevision,
    }),
    label: "Aprovando prévia…",
  });
  // O desfazer mora aqui até a Task 7 montar a faixa de transporte.
  document.getElementById("undo").onclick = () => {
    const project = state.get("project");
    if (project.revision === 0) return;
    void api.call("/project/undo", {
      method: "POST",
      body: JSON.stringify({ baseRevision: project.revision, revision: project.revision - 1 }),
      label: "Desfazendo…",
    });
  };

  state.subscribe("project", render);
  state.subscribe("operation", () => render(state.get("project")));
  render(state.get("project"));
}
