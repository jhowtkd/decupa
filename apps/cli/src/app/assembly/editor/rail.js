// Região do projeto (Task 5): materiais, briefing, preparação e entrega.
// Cada render assina `state.subscribe("project", ...)` e porta o bloco
// original do page.js monolítico, mantendo o comentário de comportamento.
const ROLES = { speech: "Fala", support: "Apoio", both: "Fala+apoio" };
const STAGE_LABEL = { pending: "Na fila", running: "Em andamento", ready: "Concluída", error: "Falhou" };
const PREP_STAGES = { media: "Verificar arquivos", audio: "Transcrever áudio", visual: "Analisar imagens", proposal: "Montar cenas", preview: "Renderizar prévia" };

export function sourceProgress(project, source) {
  const prep = project.preparation;
  const stages = prep?.sources[source.id];
  const analysis = project.analyses.find((item) => item.sourceId === source.id);
  if (!source.included) return { tone: "muted", label: "Fora da montagem", detail: "" };
  if (stages) {
    const failed = ["media", "audio", "visual"].find((key) => stages[key] === "error");
    const running = ["media", "audio", "visual"].find((key) => stages[key] === "running");
    if (failed) return { tone: "error", label: PREP_STAGES[failed] + ": falhou", detail: stages.error || "Retome a preparação para tentar novamente." };
    if (running && prep.status === "running") return { tone: "running", label: PREP_STAGES[running] + "…", detail: "" };
    if (stages.media === "ready" && stages.audio === "ready" && (!source.hasVideo || stages.visual === "ready")) {
      return { tone: "ready", label: "Análise concluída", detail: "" };
    }
    if (prep.status !== "running") return { tone: "error", label: "Preparação interrompida", detail: stages.error || "Retome para concluir as etapas pendentes." };
    return { tone: "pending", label: "Na fila", detail: stages.audio === "ready" ? "Transcrição disponível" : "" };
  }
  if (analysis?.status === "error") return { tone: "error", label: "Falha na análise", detail: analysis.error || "" };
  if (analysis) return { tone: "pending", label: "Transcrição disponível", detail: "" };
  return { tone: "pending", label: "Aguardando preparação", detail: "" };
}

export function preparationView(project, operation) {
  const prep = project.preparation;
  const sources = project.assembly.sources.filter((source) => source.included);
  const busy = prep?.status === "running";
  const active = sources.find((source) => Object.values(prep?.sources[source.id] || {}).includes("running"));
  const failed = sources.find((source) => sourceProgress(project, source).tone === "error");
  const done = sources.filter((source) => sourceProgress(project, source).tone === "ready").length;
  const tone = busy ? "running" : prep && ["interrupted", "attention"].includes(prep.status) ? "error" : "ready";
  const title = busy ? PREP_STAGES[prep.stage] + "…"
    : tone === "error" ? "A montagem precisa de atenção"
    : prep?.status === "cancelled" ? "Preparação cancelada"
    : prep?.status === "ready" ? "Montagem pronta para revisar" : "Prepare seus materiais";
  return { busy, tone, title, done, total: sources.length,
    detail: busy ? (active ? active.name + " · " : "") + (prep.note || `${done} de ${sources.length} mídias analisadas`)
      : failed ? failed.name + " · " + sourceProgress(project, failed).detail
      : prep?.error || operation?.error || "Confira a prévia antes de aprovar a entrega." };
}

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

export function mountRail({ state, api, player }) {
  const root = document.getElementById("rail");
  root.replaceChildren();

  const materials = document.createElement("section");
  materials.setAttribute("aria-label", "Materiais");
  materials.innerHTML = '<h1>Materiais do projeto</h1><p class="muted" id="sourceCounts" aria-live="polite"></p>'
    + '<p class="muted" id="invite" hidden>Solte mídias no centro ou escolha arquivos para começar.</p>'
    + '<div class="row"><button type="button" id="select">+ Importar mídia</button></div>'
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
  document.getElementById("openBriefing").onclick = () => { if (!briefingDialog.open) briefingDialog.showModal(); };
  document.getElementById("closeBriefing").onclick = () => briefingDialog.close();
  const newProject = document.getElementById("newProject");
  newProject.onclick = async () => {
    newProject.disabled = true;
    try {
      const { res, body } = await api.call("/project/new", {
        method: "POST", body: "{}", label: "Criando projeto…",
      });
      if (res.ok) window.location.assign(body.url);
    } finally {
      newProject.disabled = false;
    }
  };


  const preparation = document.getElementById("activity");
  preparation.innerHTML = '<div class="activity-heading"><span class="activity-indicator" aria-hidden="true"></span>'
    + '<div><h1 id="prepSummary" aria-live="polite"></h1><p id="opLine" class="muted" aria-live="polite"></p></div>'
    + '<div class="activity-actions"><button type="button" id="resume">Retomar preparação</button>'
    + '<button type="button" id="stopPreparation" class="danger" hidden>Cancelar preparação</button></div></div>'
    + '<ol id="prepList" class="preparation-steps"></ol><div id="prepError"></div>';
  const prepare = document.createElement("button");
  prepare.id = "prepare";
  prepare.type = "button";
  prepare.className = "primary";
  prepare.textContent = "Montar vídeo";
  document.getElementById("primaryAction").appendChild(prepare);
  document.getElementById("stopPreparation").onclick = () => api.call("/project/cancel", {
    method: "POST", body: "{}", label: "Cancelando preparação…",
  });

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

  let sourcesSignature = "";
  function renderSources(project) {
    const list = document.getElementById("sources");
    const signature = JSON.stringify(project.assembly.sources);
    if (signature === sourcesSignature) return;
    sourcesSignature = signature;
    const focusedId = document.activeElement?.dataset?.sourceId;
    const checked = new Set(
      [...list.querySelectorAll("input[type=checkbox]:checked")].map((el) => el.value),
    );
    list.replaceChildren();
    for (const source of project.assembly.sources) {
      const li = document.createElement("li");
      li.className = "source";
      li.dataset.sourceId = source.id;
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = source.id;
      box.checked = checked.has(source.id);
      box.setAttribute("aria-label", "selecionar " + source.name);
      box.addEventListener("change", renderBatchButtons);
      const thumb = document.createElement("img");
      thumb.alt = "";
      thumb.loading = "lazy";
      if (source.hasVideo) thumb.src = "/project/thumbnail/" + encodeURIComponent(source.id);
      const placeholder = document.createElement("span");
      placeholder.className = "thumbnail-placeholder";
      placeholder.textContent = source.hasVideo ? "Carregando miniatura…" : "Áudio";
      thumb.addEventListener("load", () => { placeholder.hidden = true; });
      thumb.addEventListener("error", () => { thumb.hidden = true; placeholder.textContent = "Sem miniatura"; });
      const preview = document.createElement("button");
      preview.type = "button";
      preview.className = "source-preview";
      preview.setAttribute("aria-label", "Ver original de " + source.name);
      preview.append(placeholder, thumb);
      preview.onclick = () => player.playOriginal(source.id);
      const meta = document.createElement("div");
      meta.className = "m-body";
      const name = document.createElement("div");
      name.className = "m-name";
      name.textContent = source.name;
      const chips = document.createElement("div");
      chips.className = "m-meta";
      chips.append(chip(Math.round(source.durationSeconds) + "s"));
      const category = chip({ speech: "Fala", support: "Imagem de apoio", both: "Fala + apoio" }[source.role] || "Não classificado");
      category.classList.add("source-role");
      chips.append(category);
      if (!source.included) chips.append(chip("excluída"));
      const status = document.createElement("p");
      status.className = "source-status";
      status.setAttribute("role", "status");
      const options = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "Opções do material";
      const controls = document.createElement("div");
      controls.className = "controls";
      options.append(summary, controls);
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
        body: JSON.stringify({ baseRevision: state.get("project").revision, sourceIds: [source.id], role: role.value }),
        label: "Atualizando categoria…",
      }));
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.textContent = source.included ? "Excluir" : "Incluir";
      toggle.addEventListener("click", () => api.call("/project/source-selection", {
        method: "POST",
        body: JSON.stringify({ baseRevision: state.get("project").revision, sourceIds: [source.id], included: !source.included }),
        label: source.included ? "Excluindo material…" : "Incluindo material…",
      }));
      const relink = document.createElement("button");
      relink.type = "button";
      relink.className = "quiet";
      relink.textContent = "Relink";
      relink.addEventListener("click", () => api.call("/project/relink", {
        method: "POST",
        body: JSON.stringify({ baseRevision: state.get("project").revision, sourceId: source.id }),
        label: "Relinkando material…",
      }));
      const watch = document.createElement("button");
      watch.type = "button";
      watch.className = "quiet";
      watch.textContent = "Ver original";
      watch.addEventListener("click", () => player.playOriginal(source.id));
      controls.append(role, toggle, relink, watch);
      meta.append(name, chips, status);
      li.append(box, preview, meta, options);
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
    for (const node of document.querySelectorAll("#sources .source")) {
      const source = project.assembly.sources.find((item) => item.id === node.dataset.sourceId);
      const status = sourceProgress(project, source);
      node.dataset.status = status.tone;
      const label = node.querySelector(".source-status");
      label.textContent = status.label;
      label.title = status.detail;
    }
    preparation.hidden = !prep;
    if (!prep) return;
    const view = preparationView(project, state.get("operation"));
    preparation.dataset.tone = view.tone;
    document.getElementById("prepSummary").textContent = view.title;
    document.getElementById("opLine").textContent = view.detail;
    document.getElementById("stopPreparation").hidden = !view.busy;
    document.getElementById("resume").hidden = view.busy || prep.status === "ready";
    const steps = document.getElementById("prepList");
    steps.replaceChildren();
    const keys = prep.mode === "preview" ? ["preview"] : Object.keys(PREP_STAGES);
    for (const key of keys) {
      const li = document.createElement("li");
      const sourceStage = ["media", "audio", "visual"].includes(key);
      const included = project.assembly.sources.filter((source) => source.included);
      const done = sourceStage ? included.length > 0 && included.every((source) => prep.sources[source.id]?.[key] === "ready")
        : key === "proposal" ? project.scenes.length > 0 && ["preview"].includes(prep.stage)
        : project.previewRevision === project.revision;
      const status = done ? "ready" : key === prep.stage ? (view.busy ? "running" : "error") : "pending";
      li.className = status;
      li.textContent = (done ? "✓ " : "") + PREP_STAGES[key];
      li.title = STAGE_LABEL[status];
      steps.appendChild(li);
    }
    const error = document.getElementById("prepError");
    error.textContent = view.tone === "error"
      ? "As etapas concluídas estão preservadas. Retome para tentar concluir o que falta ou exclua o material com falha."
      : "";
  }

  function render(project) {
    if (!project) return;
    if (!briefingDialog.open) {
      document.getElementById("kind").value = project.input.kind;
      document.getElementById("inputText").value = project.input.text;
      document.getElementById("target").value = String(project.input.targetSeconds);
    }
    document.getElementById("invite").hidden = project.assembly.sources.length > 0;
    renderSources(project);
    document.getElementById("resume").hidden = !(
      project.preparation && project.preparation.status !== "running"
      && project.preparation.status !== "ready"
    );
    const preparing = project.preparation && project.preparation.status === "running";
    setDisabled(document.getElementById("prepare"), preparing || !project.assembly.sources.some((source) => source.included));
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
  const prepareMontage = () => api.call("/project/prepare", {
    method: "POST",
    body: JSON.stringify({
      baseRevision: state.get("project").revision,
      request: "",
      modelOptIn: true, visualOptIn: true,
    }),
    label: "Preparando montagem…",
  });
  document.getElementById("prepare").onclick = prepareMontage;
  document.getElementById("resume").onclick = prepareMontage;
  state.subscribe("project", render);
  state.subscribe("operation", () => { if (state.get("project")) renderPreparation(state.get("project")); });
  render(state.get("project"));

}
