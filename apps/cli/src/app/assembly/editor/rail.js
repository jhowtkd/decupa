import { clock } from "./format.js";
import { ICON } from "./icons.js";
import { montageDuration, retainedDuration } from "./montage.js";

// Região do projeto (Task 5): materiais, briefing, preparação e entrega.
// Cada render assina `state.subscribe("project", ...)` e porta o bloco
// original do page.js monolítico, mantendo o comentário de comportamento.
const ROLES = { speech: "Fala", support: "Apoio", both: "Fala + apoio" };
const ROLE_META = { speech: "fala", support: "apoio", both: "fala + apoio" };
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
    // Áudio já salvo: o rótulo é visível, não só o tooltip. A etapa visual
    // pode continuar; a transcrição não espera por ela.
    if (stages.audio === "ready") return { tone: "pending", label: "Transcrição disponível", detail: "" };
    return { tone: "pending", label: "Na fila", detail: "" };
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
 * Rótulo do formato da entrega: dimensões, orientação e fps — espelha o
 * manifest da exportação. Puro para teste sem DOM.
 */
export function formatLabel(assembly) {
  if (!assembly) return "";
  const orientation = assembly.width > assembly.height ? "horizontal"
    : assembly.width < assembly.height ? "vertical" : "quadrado";
  const fps = `${assembly.fps.num}/${assembly.fps.den}`;
  return `${assembly.width}×${assembly.height} ${orientation} @ ${fps} fps`;
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

/**
 * Ação principal do projeto (pura): distingue montar, preparar, revisar
 * e entregar. `stage` pede navegação gratuita — revisar/entregar nunca
 * disparam chamada paga; montar/preparar chamam /project/prepare.
 */
export function primaryAction(project, operation) {
  const assembly = project?.assembly;
  const included = (assembly?.sources ?? []).filter((source) => source.included);
  const prep = project?.preparation ?? null;
  const busyStage = operation && ["analyzing", "preparing", "rendering", "proposing"].includes(operation.stage)
    ? operation.stage : null;
  if (busyStage) {
    return { kind: "busy", label: stageLabel(busyStage) + "…", disabled: true, stage: null };
  }
  if (!included.length) {
    return { kind: "montar", label: "Montar vídeo", disabled: true, stage: null };
  }
  const hasClips = (assembly?.tracks ?? []).some((track) => track.clips.length > 0);
  if (hasClips && project.finalApprovedRevision === project.revision) {
    return { kind: "entregar", label: "Abrir entrega", disabled: false, stage: "entrega" };
  }
  // Mídia incluída sem análise registrada na preparação atual precisa de
  // preparação antes de revisar — a montagem existente ignora a fonte nova.
  const needsPrep = prep && included.some((source) => !prep.sources[source.id]);
  if (needsPrep) {
    return { kind: "preparar", label: "Preparar montagem", disabled: false, stage: null };
  }
  if (hasClips || prep?.status === "ready") {
    return { kind: "revisar", label: "Revisar prévia", disabled: false, stage: "revisao" };
  }
  if (prep && ["interrupted", "attention", "cancelled"].includes(prep.status)) {
    return { kind: "preparar", label: "Retomar preparação", disabled: false, stage: null };
  }
  return { kind: "montar", label: "Montar vídeo", disabled: false, stage: null };
}

/** Cenas do rail (puro): número, título e início na montagem pela fala retida. */
export function sceneNavItems(project) {
  let cursor = 0;
  return (project?.scenes ?? []).map((scene, index) => {
    const start = cursor;
    for (const take of scene.takes) cursor += retainedDuration(take);
    return { id: scene.id, number: index + 1, title: scene.objective || scene.id, start, warn: (scene.gaps ?? []).length > 0 };
  });
}

/** Cartão do briefing (puro): texto, duração da montagem contra o alvo. */
export function briefingSummary(input, durationSeconds) {
  const target = Number.isFinite(input?.targetSeconds) && input.targetSeconds > 0 ? input.targetSeconds : null;
  const duration = Number.isFinite(durationSeconds) ? durationSeconds : null;
  const over = target != null && duration != null ? duration - target : null;
  const fill = target != null && duration != null ? Math.min(target, duration) / Math.max(target, duration) : 0;
  const note = over == null ? ""
    : Math.abs(over) < 0.5 ? "No alvo"
    : over > 0 ? Math.round(over) + " s acima do alvo"
    : Math.round(-over) + " s abaixo do alvo";
  return { text: input?.text ?? "", target, duration, over, fill, note };
}

export function mountRail({ state, api, player }) {
  const root = document.getElementById("rail");
  root.replaceChildren();

  const materials = document.createElement("section");
  materials.className = "rail-materials";
  materials.setAttribute("aria-label", "Materiais");
  materials.innerHTML = '<div class="rail-head"><h2 class="ttl">Materiais</h2>'
    + '<button type="button" id="select" class="icon" aria-label="Importar mídia" title="Importar mídia">' + ICON.plus + "</button></div>"
    + '<p id="sourceCounts" aria-live="polite"></p>'
    + '<p class="muted" id="invite" hidden>Solte mídias no texto ou use + para escolher arquivos.</p>'
    // Ações em lote só existem enquanto há seleção (#rail.has-selection).
    + '<div class="rail-actions"><button type="button" id="batchSupport" class="quiet" disabled>Marcar seleção como apoio</button>'
    + '<button type="button" id="batchInclude" class="quiet" disabled>Incluir seleção na montagem</button>'
    + '<button type="button" id="batchExclude" class="quiet" disabled>Deixar seleção fora da montagem</button></div>'
    + '<ul id="sources" class="plain"></ul>';
  root.appendChild(materials);

  const sceneNav = document.createElement("nav");
  sceneNav.id = "sceneNav";
  sceneNav.setAttribute("aria-label", "Cenas");
  sceneNav.innerHTML = '<h2 class="ttl">Cenas</h2><ol id="sceneList" class="plain"></ol>'
    + '<p id="sceneEmpty">As cenas aparecem quando a etapa Montar cenas terminar.</p>';
  root.appendChild(sceneNav);

  const templateSlot = document.createElement("details");
  templateSlot.id = "templateSlot";
  templateSlot.innerHTML = "<summary>Template editorial</summary>";
  root.appendChild(templateSlot);

  const brief = document.createElement("section");
  brief.className = "sub rail-brief";
  brief.setAttribute("aria-label", "Briefing");
  brief.innerHTML = '<div class="brief-head"><h2 class="ttl">Briefing</h2>'
    + '<button type="button" id="openBriefing" class="quiet small">Editar</button></div>'
    + '<p id="briefText" class="brief-text"></p>'
    + '<div class="brief-duration"><span id="briefDuration" class="mono big"></span><span id="briefTarget" class="mono"></span></div>'
    + '<div class="brief-bar" aria-hidden="true"><span id="briefFill"></span><span id="briefOver"></span></div>'
    + '<p id="briefNote" class="brief-note"></p>';
  root.appendChild(brief);

  const briefingDialog = document.createElement("dialog");
  briefingDialog.id = "briefingDialog";
  briefingDialog.setAttribute("aria-labelledby", "briefingTitle");
  // O form é um bloco móvel: com o projeto vazio a T9 o leva para o monitor.
  briefingDialog.innerHTML = '<h1 id="briefingTitle">Briefing</h1>'
    + '<div id="briefingForm" class="briefing-form">'
    + '<p class="muted briefing-intro">Diga o que o vídeo precisa ser. A montagem usa isto para escolher e ordenar as cenas.</p>'
    + '<label>Tipo <select id="kind"><option value="brief">Briefing</option><option value="script">Roteiro</option></select></label>'
    + '<label>Texto <textarea id="inputText" rows="6"></textarea></label>'
    + '<label>Duração alvo (s) <input id="target" type="number" min="1" value="60"></label>'
    + '<button type="button" id="saveInput">Guardar briefing</button></div>'
    + '<div class="row dialog-actions"><button type="button" id="closeBriefing" class="quiet">Fechar</button></div>';
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
      box.setAttribute("aria-label", "Selecionar " + source.name);
      box.addEventListener("change", renderBatchButtons);
      const thumb = document.createElement("img");
      thumb.alt = "";
      thumb.loading = "lazy";
      if (source.hasVideo) thumb.src = "/project/thumbnail/" + encodeURIComponent(source.id);
      const placeholder = document.createElement("span");
      placeholder.className = "thumbnail-placeholder";
      placeholder.textContent = source.hasVideo ? "" : "Áudio";
      thumb.addEventListener("load", () => { placeholder.hidden = true; });
      thumb.addEventListener("error", () => { thumb.hidden = true; placeholder.textContent = "Sem miniatura"; });
      const preview = document.createElement("button");
      preview.type = "button";
      preview.className = "source-preview";
      preview.setAttribute("aria-label", "Ver original de " + source.name);
      preview.append(placeholder, thumb);
      preview.onclick = () => player.playOriginal(source.id);
      const body = document.createElement("div");
      body.className = "m-body";
      const name = document.createElement("span");
      name.className = "m-name";
      name.textContent = source.name;
      const meta = document.createElement("span");
      meta.className = "m-meta mono";
      meta.textContent = clock(source.durationSeconds) + " · " + (ROLE_META[source.role] || "sem papel");
      const status = document.createElement("span");
      status.className = "source-status";
      status.setAttribute("role", "status");
      body.append(name, meta, status);
      const menu = document.createElement("details");
      menu.className = "source-menu";
      const summary = document.createElement("summary");
      summary.setAttribute("aria-label", "Opções de " + source.name);
      summary.innerHTML = ICON.more;
      const pop = document.createElement("div");
      pop.className = "menu-pop";
      const role = document.createElement("div");
      role.className = "role-switch";
      role.setAttribute("role", "group");
      role.setAttribute("aria-label", "Uso de " + source.name);
      for (const value of ["speech", "support", "both"]) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = ROLES[value];
        button.setAttribute("aria-pressed", String(source.role === value));
        button.onclick = () => api.call("/project/source-role", {
          method: "POST",
          body: JSON.stringify({ baseRevision: state.get("project").revision, sourceIds: [source.id], role: value }),
          label: "Atualizando categoria…",
        });
        role.append(button);
      }
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.textContent = source.included ? "Deixar fora da montagem" : "Incluir na montagem";
      toggle.addEventListener("click", () => api.call("/project/source-selection", {
        method: "POST",
        body: JSON.stringify({ baseRevision: state.get("project").revision, sourceIds: [source.id], included: !source.included }),
        label: source.included ? "Tirando da montagem…" : "Incluindo material…",
      }));
      const relink = document.createElement("button");
      relink.type = "button";
      relink.textContent = "Religar arquivo";
      relink.addEventListener("click", () => api.call("/project/relink", {
        method: "POST",
        body: JSON.stringify({ baseRevision: state.get("project").revision, sourceId: source.id }),
        label: "Religando arquivo…",
      }));
      const watch = document.createElement("button");
      watch.type = "button";
      watch.textContent = "Ver original";
      watch.addEventListener("click", () => player.playOriginal(source.id));
      pop.append(role, toggle, relink, watch);
      menu.append(summary, pop);
      li.append(box, preview, body, menu);
      list.appendChild(li);
    }
    if (focusedId) list.querySelector(`[data-source-id="${focusedId}"]`)?.focus();
    const countsEl = document.getElementById("sourceCounts");
    if (countsEl) {
      const counts = countsFor(project.assembly.sources);
      countsEl.textContent = counts.total + (counts.total === 1 ? " fonte" : " fontes")
        + " · " + counts.included + " na montagem · " + counts.support + " apoio";
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

  function renderScenes(project) {
    if (!project) return;
    const items = sceneNavItems(project);
    const list = document.getElementById("sceneList");
    document.getElementById("sceneEmpty").hidden = items.length > 0;
    const current = state.get("selectedScene") ?? items[0]?.id;
    list.replaceChildren(...items.map((item) => {
      const li = document.createElement("li");
      const link = document.createElement("a");
      link.href = "#cena-" + item.id;
      link.className = "scene-link";
      link.dataset.scene = item.id;
      if (item.id === current) link.setAttribute("aria-current", "true");
      link.innerHTML = '<span class="num"></span><span class="scene-title"></span>'
        + (item.warn ? '<span class="dot warn-dot" aria-hidden="true"></span><span class="sr">com lacuna</span>' : "")
        + '<span class="mono t"></span>';
      link.querySelector(".num").textContent = String(item.number);
      link.querySelector(".scene-title").textContent = item.title;
      link.querySelector(".t").textContent = clock(item.start);
      link.onclick = (event) => {
        event.preventDefault();
        state.set("selectedScene", item.id);
        state.set("playhead", item.start);
        player.seek(item.start);
        document.querySelector('[data-scene-section="' + CSS.escape(item.id) + '"]')?.scrollIntoView({ block: "start" });
      };
      li.append(link);
      return li;
    }));
  }

  function renderBrief(project) {
    const summary = briefingSummary(project.input, project.scenes.length ? montageDuration(project) : null);
    document.getElementById("briefText").textContent = summary.text || "Sem briefing ainda.";
    document.getElementById("briefDuration").textContent = summary.duration != null ? clock(summary.duration) : "–:––";
    document.getElementById("briefTarget").textContent = summary.target != null ? "alvo " + clock(summary.target) : "";
    document.getElementById("briefFill").style.width = (summary.fill * 100).toFixed(1) + "%";
    document.getElementById("briefOver").style.width = summary.over > 0 ? ((1 - summary.fill) * 100).toFixed(1) + "%" : "0%";
    const note = document.getElementById("briefNote");
    note.textContent = summary.note;
    note.classList.toggle("over", summary.over > 0.5);
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
    renderScenes(project);
    renderBrief(project);
    document.getElementById("resume").hidden = !(
      project.preparation && project.preparation.status !== "running"
      && project.preparation.status !== "ready"
    );
    const preparing = project.preparation && project.preparation.status === "running";
    const action = primaryAction(project, state.get("operation"));
    const prepareButton = document.getElementById("prepare");
    prepareButton.textContent = action.label;
    prepareButton.dataset.action = action.kind;
    setDisabled(prepareButton, preparing || action.disabled);
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
  const prepareClick = () => {
    const action = primaryAction(state.get("project"), state.get("operation"));
    if (action.stage) {
      window.dispatchEvent(new CustomEvent("decupa:set-stage", { detail: action.stage }));
      return;
    }
    prepareMontage();
  };
  const prepareMontage = () => api.call("/project/prepare", {
    method: "POST",
    body: JSON.stringify({
      baseRevision: state.get("project").revision,
      request: "",
      modelOptIn: true, visualOptIn: true,
    }),
    label: "Preparando montagem…",
  });
  document.getElementById("prepare").onclick = prepareClick;
  document.getElementById("resume").onclick = prepareMontage;
  state.subscribe("project", render);
  state.subscribe("operation", () => { if (state.get("project")) renderPreparation(state.get("project")); });
  state.subscribe("selectedScene", () => renderScenes(state.get("project")));
  render(state.get("project"));

}

export function resolveView(delivery, approved) {
  const stages={connecting:"Conectando ao DaVinci…",created:"Importando montagem…",imported:"Verificando timeline importada…",verified:"Salvando projeto…",saved:"Projeto salvo",exported:"DRP exportado"};
  return {
    disabled:!approved||delivery?.status==="running",
    buttonLabel:"Abrir montagem no DaVinci",
    statusText:delivery?.status==="error"?delivery.error:delivery?.status==="ready"?"Projeto salvo: "+delivery.projectName+(delivery.error?" — "+delivery.error:""):delivery?.status==="running"?(stages[delivery.stage]||"Entregando…"):"",
    newCopy:delivery?.status==="error"&&delivery.created!==false,
  };
}
