// Região do projeto (Task 5): materiais, briefing, preparação e entrega.
// Cada render assina `state.subscribe("project", ...)` e porta o bloco
// original do page.js monolítico, mantendo o comentário de comportamento.
const ROLES = { speech: "Fala", support: "Apoio", both: "Fala+apoio" };
const STAGE_LABEL = { pending: "pendente", running: "rodando", ready: "pronta", error: "erro" };

/** Chip mono (.chip da Task 3): estado curto e legível ao lado do nome. */
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

/**
 * Checklist da entrega: derivado do estado real do projeto (mídia
 * presente, seleção feita, revisão pronta). Pura para teste sem DOM;
 * o render aplica a cada projeto recebido.
 */
export function deliveryChecklist(project) {
  const sources = project.assembly?.sources ?? [];
  return [
    { id: "media", label: "Mídia presente", done: sources.length > 0 },
    { id: "selection", label: "Seleção feita", done: sources.some((s) => s.included) },
    { id: "review", label: "Revisão pronta", done: project.finalApprovedRevision != null },
  ];
}

/**
 * Visão do botão/fluxo de export: estados distinguíveis (ocioso, em
 * progresso, concluído, erro). Pura para teste sem DOM.
 * @param {{status: string, error: string|null}} ui
 * @param {boolean} approved
 * @param {Array<{id: string, label: string, href: string, file: string}> | null} [formats]
 */
export function exportView(ui, approved, formats = null) {
  let view;
  if (ui.status === "running") {
    view = {
      disabled: true, loading: true, tone: "running",
      buttonLabel: "Exportando…", statusText: "Exportando…",
    };
  } else if (ui.status === "error") {
    view = {
      disabled: !approved, loading: false, tone: "error",
      buttonLabel: "Exportar revisão",
      statusText: "Erro no export: " + (ui.error || "falha desconhecida"),
    };
  } else if (ui.status === "done") {
    view = {
      disabled: !approved, loading: false, tone: "done",
      buttonLabel: "Exportado ✓", statusText: "Exportado ✓ — links abaixo.",
    };
  } else {
    view = {
      disabled: !approved, loading: false, tone: "idle",
      buttonLabel: "Exportar revisão", statusText: "",
    };
  }
  return formats == null ? view : { ...view, formats };
}

/**
 * Resumo das fontes para o cabeçalho de materiais (puro): total,
 * incluídas e apoio (role support OU both). Testado sem DOM.
 */
export function countsFor(sources) {
  const list = sources || [];
  return {
    total: list.length,
    included: list.filter((source) => source.included).length,
    support: list.filter((source) => source.role === "support" || source.role === "both").length,
  };
}

const OP_STAGE_LABEL = {
  analyzing: "Analisando mídia",
  preparing: "Preparando montagem",
  rendering: "Renderizando prévia",
  proposing: "Propondo cenas",
  error: "Erro",
  cancelled: "Cancelada",
  ready: "Pronta",
};

/** Rótulo pt-BR da etapa da operação (puro); desconhecida repassa crua. */
export function stageLabel(stage) {
  return OP_STAGE_LABEL[stage] || String(stage);
}

/** Sem checkboxes: o consentimento pago é por lote no disparo; aqui só ecoa o já concedido. */
function paidFlags(project) {
  return {
    modelOptIn: project.permissions.model === true,
    visualOptIn: project.permissions.visual === true,
  };
}

export function mountRail({ state, api, player }) {
  const root = document.getElementById("rail");
  root.replaceChildren();

  const materials = document.createElement("section");
  materials.setAttribute("aria-label", "Materiais");
  materials.innerHTML = '<h1>Materiais</h1><p class="muted" id="sourceCounts" aria-live="polite"></p>'
    + '<p class="muted">Arquivos locais. O original não é enviado a terceiros nesta tela.</p>'
    + '<p class="muted" id="invite" hidden>Solte mídias no centro ou escolha arquivos para começar.</p>'
    + '<div class="row"><button type="button" id="select">Escolher arquivos</button></div>'
    // Ações em lote só existem enquanto há seleção (Task 4: #rail.has-selection).
    + '<div class="rail-actions"><button type="button" id="batchSupport" disabled>Categorizar seleção como apoio</button>'
    + '<button type="button" id="batchInclude" disabled>Incluir seleção</button>'
    + '<button type="button" id="batchExclude" disabled>Excluir seleção</button></div>'
    + '<ul id="sources" class="plain"></ul>';
  root.appendChild(materials);

  const briefingDialog = document.createElement("dialog");
  briefingDialog.id = "briefingDialog";
  briefingDialog.setAttribute("aria-labelledby", "briefingTitle");
  briefingDialog.innerHTML = '<h1 id="briefingTitle">Briefing</h1>'
    + '<label>Tipo <select id="kind"><option value="brief">briefing</option><option value="script">roteiro</option></select></label>'
    + '<label>Texto <textarea id="inputText" rows="4"></textarea></label>'
    + '<label>Duração alvo (s) <input id="target" type="number" min="1" value="60"></label>'
    + '<div class="row"><button type="button" id="saveInput">Guardar briefing</button>'
    + '<button type="button" id="closeBriefing">Fechar</button></div>';
  document.body.appendChild(briefingDialog);
  let briefingAutoOpened = false;
  document.getElementById("openBriefing").onclick = () => briefingDialog.showModal();
  document.getElementById("closeBriefing").onclick = () => briefingDialog.close();

  const preparation = document.createElement("section");
  preparation.setAttribute("aria-label", "Preparação");
  preparation.innerHTML = "<h1>Preparação</h1>"
    + '<p class="muted" id="prepSummary" aria-live="polite"></p>'
    + '<p class="muted" id="opLine" aria-live="polite"></p>'
    + '<div id="prepList"></div><div id="prepError"></div>'
    + '<div class="row"><button type="button" class="primary" id="prepare">Preparar montagem</button>'
    + '<button type="button" id="resume">Retomar</button></div>';
  root.appendChild(preparation);

  const prepDialog = document.createElement("dialog");
  prepDialog.id = "prepDialog";
  prepDialog.setAttribute("aria-labelledby", "prepTitle");
  document.body.appendChild(prepDialog);

  function checkedSourceIds() {
    return [...document.querySelectorAll("#sources input[type=checkbox]:checked")].map((el) => el.value);
  }

  function renderBatchButtons() {
    const any = checkedSourceIds().length > 0;
    setDisabled(document.getElementById("batchSupport"), !any);
    setDisabled(document.getElementById("batchInclude"), !any);
    setDisabled(document.getElementById("batchExclude"), !any);
    // A barra contextual só existe enquanto há seleção (Task 4).
    document.getElementById("rail").classList.toggle("has-selection", any);
  }

  function renderSources(project) {
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
      meta.className = "m-body";
      const name = document.createElement("div");
      name.className = "m-name";
      name.textContent = source.name;
      const analysis = project.analyses.find((item) => item.sourceId === source.id);
      const chips = document.createElement("div");
      chips.className = "m-meta";
      chips.append(chip(Math.round(source.durationSeconds) + "s"));
      if (!source.included) chips.append(chip("excluída"));
      if (analysis) chips.append(chip(analysis.status));
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
      role.addEventListener("change", () => api.call("/project/source-role", {
        method: "POST",
        body: JSON.stringify({ baseRevision: project.revision, sourceIds: [source.id], role: role.value }),
        label: "Atualizando categoria…",
      }));
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.textContent = source.included ? "Excluir" : "Incluir";
      toggle.addEventListener("click", () => api.call("/project/source-selection", {
        method: "POST",
        body: JSON.stringify({ baseRevision: project.revision, sourceIds: [source.id], included: !source.included }),
        label: source.included ? "Excluindo material…" : "Incluindo material…",
      }));
      const relink = document.createElement("button");
      relink.type = "button";
      relink.className = "quiet";
      relink.textContent = "Relink";
      relink.addEventListener("click", () => api.call("/project/relink", {
        method: "POST",
        body: JSON.stringify({ baseRevision: project.revision, sourceId: source.id }),
        label: "Relinkando material…",
      }));
      const watch = document.createElement("button");
      watch.type = "button";
      watch.className = "quiet";
      watch.textContent = "Ver original";
      watch.addEventListener("click", () => player.playOriginal(source.id));
      controls.append(role, toggle, relink, watch);
      meta.append(name, chips, controls);
      li.append(box, thumb, meta);
      list.appendChild(li);
    }
    if (focusedId) list.querySelector(`[data-source-id="${focusedId}"]`)?.focus();
    const countsEl = document.getElementById("sourceCounts");
    if (countsEl) {
      const counts = countsFor(project.assembly.sources);
      countsEl.textContent = counts.total + " fonte(s) · " + counts.included + " incluída(s) · " + counts.support + " apoio";
    }
    renderBatchButtons();
  }

  function renderPreparation(project) {
    const prep = project.preparation;
    if (!prep) return;
    const box = document.getElementById("prepList");
    box.replaceChildren();
    const included = project.assembly.sources.filter((item) => item.included);
    if (!included.length) {
      document.getElementById("prepSummary").textContent = "Nenhuma fonte incluída — inclua materiais para preparar.";
      return;
    }
    let done = 0;
    let total = 0;
    for (const source of included) {
      const itemState = prep.sources[source.id] || { media: "pending", audio: "pending", visual: "pending" };
      const card = document.createElement("div");
      card.className = "prep-file";
      const name = document.createElement("div");
      name.textContent = source.name;
      card.appendChild(name);
      const stages = document.createElement("div");
      stages.className = "stages";
      for (const stage of ["media", "audio", "visual"]) {
        total += 1;
        const value = itemState[stage] || "pending";
        if (value === "ready") done += 1;
        const span = document.createElement("span");
        span.className = "stage " + value;
        span.textContent = stage + ": " + (STAGE_LABEL[value] || value);
        stages.appendChild(span);
      }
      card.appendChild(stages);
      box.appendChild(card);
    }
    const summary = { running: "Preparando", ready: "Pronta", attention: "Atenção", interrupted: "Interrompida", cancelled: "Cancelada" };
    document.getElementById("prepSummary").textContent =
      (summary[prep.status] || prep.status) + " · etapa " + prep.stage + " · " + done + "/" + total + " etapas de fonte";
    const errBox = document.getElementById("prepError");
    errBox.replaceChildren();
    const problems = [];
    if (prep.error) problems.push(prep.error);
    for (const [id, itemState] of Object.entries(prep.sources)) {
      if (itemState.error) problems.push(id + ": " + itemState.error);
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

  /** Linha da operação na preparação: etapa + progresso + material + erro. */
  function renderOpLine(operation) {
    const line = document.getElementById("opLine");
    if (!line) return;
    if (!operation || !operation.stage) {
      line.textContent = "";
      return;
    }
    const p = state.get("project");
    const source = operation.sourceId && p
      ? p.assembly.sources.find((item) => item.id === operation.sourceId) : null;
    line.textContent = stageLabel(operation.stage)
      + (operation.progress ? " · " + operation.progress : "")
      + (source ? " · " + source.name : "")
      + (operation.error ? ": " + operation.error : "");
  }

  /** Consentimento pago por lote: diálogo nativo, nunca confirm() nativo. */
  function openPrepareConfirm(project) {
    prepDialog.replaceChildren();
    const title = document.createElement("h1");
    title.id = "prepTitle";
    title.textContent = "Preparar montagem";
    const count = project.assembly.sources.filter((source) => source.included).length;
    const note = document.createElement("p");
    if (project.permissions.visual === true) {
      // Permissão é monotônica: já concedida, só declara o estado honesto.
      note.textContent = "já autorizado (persistente) — a preparação usa o modelo visual pago e envia as mídias ao provedor.";
    } else {
      note.textContent = "Vai analisar " + count + " arquivo(s) — custo estimado do modelo visual + envio das mídias ao provedor. Continuar?";
    }
    const row = document.createElement("div");
    row.className = "row";
    const go = document.createElement("button");
    go.type = "button";
    go.className = "primary";
    go.textContent = "Preparar agora";
    go.addEventListener("click", () => {
      prepDialog.close();
      // O clique no lote é o opt-in: o servidor persiste em permissions.
      void api.call("/project/prepare", {
        method: "POST",
        body: JSON.stringify({
          baseRevision: state.get("project").revision, request: "",
          modelOptIn: true, visualOptIn: true,
        }),
        label: "Iniciando preparação…",
      });
    });
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancelar";
    cancel.addEventListener("click", () => prepDialog.close());
    row.append(go, cancel);
    prepDialog.append(title, note, row);
    prepDialog.showModal();
  }

  function render(project) {
    if (!project) return;
    document.getElementById("kind").value = project.input.kind;
    document.getElementById("inputText").value = project.input.text;
    document.getElementById("target").value = String(project.input.targetSeconds);
    document.getElementById("invite").hidden = project.assembly.sources.length > 0;
    // Projeto sem fontes abre o briefing sozinho, uma vez: o primeiro gesto
    // é colar o roteiro e arrastar mídia (era o <details> aberto, Task 4).
    if (!briefingAutoOpened && project.assembly.sources.length === 0) {
      briefingAutoOpened = true;
      briefingDialog.showModal();
    }
    renderSources(project);
    // A seção fica visível desde o vazio: o botão Preparar montagem é o
    // ponto de entrada do percurso (Task 10). Só o Retomar depende de percurso.
    preparation.hidden = false;
    document.getElementById("resume").hidden = !(
      project.preparation && project.preparation.status !== "running"
      && project.preparation.status !== "ready"
    );
    const preparing = project.preparation && project.preparation.status === "running";
    setDisabled(document.getElementById("prepare"), preparing);
    if (preparing && prepDialog.open) prepDialog.close();
    renderPreparation(project);
  }

  document.getElementById("select").onclick = () => api.call("/project/select", {
    method: "POST", body: JSON.stringify({ baseRevision: state.get("project").revision }),
    label: "Abrindo seleção…",
  });
  document.getElementById("batchSupport").onclick = () => api.call("/project/source-role", {
    method: "POST",
    body: JSON.stringify({ baseRevision: state.get("project").revision, sourceIds: checkedSourceIds(), role: "support" }),
    label: "Categorizando como apoio…",
  });
  document.getElementById("batchInclude").onclick = () => api.call("/project/source-selection", {
    method: "POST",
    body: JSON.stringify({ baseRevision: state.get("project").revision, sourceIds: checkedSourceIds(), included: true }),
    label: "Incluindo seleção…",
  });
  document.getElementById("batchExclude").onclick = () => api.call("/project/source-selection", {
    method: "POST",
    body: JSON.stringify({ baseRevision: state.get("project").revision, sourceIds: checkedSourceIds(), included: false }),
    label: "Excluindo seleção…",
  });
  document.getElementById("saveInput").onclick = () => api.call("/project/input", {
    method: "POST",
    body: JSON.stringify({
      baseRevision: state.get("project").revision,
      kind: document.getElementById("kind").value,
      text: document.getElementById("inputText").value,
      targetSeconds: Number(document.getElementById("target").value),
    }),
    label: "Guardando briefing…",
  });
  document.getElementById("prepare").onclick = () => openPrepareConfirm(state.get("project"));
  document.getElementById("resume").onclick = () => api.call("/project/prepare", {
    method: "POST",
    body: JSON.stringify({
      baseRevision: state.get("project").revision,
      request: "",
      ...paidFlags(state.get("project")),
    }),
    label: "Retomando preparação…",
  });
  state.subscribe("project", render);
  state.subscribe("operation", renderOpLine);
  render(state.get("project"));
  renderOpLine(state.get("operation"));
}
