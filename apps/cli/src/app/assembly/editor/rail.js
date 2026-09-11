// Região do projeto (Task 5): materiais, briefing, preparação e entrega.
// Cada render assina `state.subscribe("project", ...)` e porta o bloco
// original do page.js monolítico, mantendo o comentário de comportamento.
const ROLES = { speech: "Fala", support: "Apoio", both: "Fala+apoio" };
const STAGE_LABEL = { pending: "pendente", running: "rodando", ready: "pronta", error: "erro" };

function sourceName(project, id) {
  const found = project && project.assembly.sources.find((item) => item.id === id);
  return found ? found.name : id;
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

  const head = document.createElement("div");
  head.className = "rail-head";
  const brand = document.createElement("strong");
  brand.textContent = "decupa";
  const status = document.createElement("span");
  status.className = "hint";
  status.id = "status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = "carregando…";
  head.append(brand, status);
  root.appendChild(head);

  const materials = document.createElement("section");
  materials.setAttribute("aria-label", "Materiais");
  materials.innerHTML = "<h1>Materiais</h1>"
    + '<p class="muted">Arquivos locais. O original não é enviado a terceiros nesta tela.</p>'
    + '<p class="muted" id="invite" hidden>Solte mídias no centro ou escolha arquivos para começar.</p>'
    + '<div class="row"><button type="button" id="select">Escolher arquivos</button>'
    + '<button type="button" id="batchSupport" disabled>Categorizar seleção como apoio</button>'
    + '<button type="button" id="batchInclude" disabled>Incluir seleção</button>'
    + '<button type="button" id="batchExclude" disabled>Excluir seleção</button></div>'
    + '<ul id="sources" class="plain"></ul>';
  root.appendChild(materials);

  const briefing = document.createElement("section");
  briefing.setAttribute("aria-label", "Briefing");
  briefing.innerHTML = "<h1>Briefing</h1>"
    + '<label>Tipo <select id="kind"><option value="brief">briefing</option><option value="script">roteiro</option></select></label>'
    + '<label>Texto <textarea id="inputText" rows="4"></textarea></label>'
    + '<label>Duração alvo (s) <input id="target" type="number" min="1" value="60"></label>'
    + '<div class="row"><button type="button" id="saveInput">Guardar briefing</button></div>';
  root.appendChild(briefing);

  const preparation = document.createElement("section");
  preparation.setAttribute("aria-label", "Preparação");
  preparation.innerHTML = "<h1>Preparação</h1>"
    + '<p class="muted" id="prepSummary" aria-live="polite"></p>'
    + '<div id="prepList"></div><div id="prepError"></div>'
    + '<div class="row"><button type="button" class="primary" id="prepare">Preparar montagem</button>'
    + '<button type="button" id="resume">Retomar</button></div>'
    + '<div id="prepareConfirm" hidden></div>';
  root.appendChild(preparation);

  const delivery = document.createElement("section");
  delivery.setAttribute("aria-label", "Entrega");
  delivery.innerHTML = "<h1>Entrega</h1>"
    + '<p class="muted" id="deliveryLock" aria-live="polite"></p>'
    + '<div class="row"><button type="button" id="export">Exportar revisão</button></div>'
    + '<p id="downloads"></p>';
  root.appendChild(delivery);

  function checkedSourceIds() {
    return [...document.querySelectorAll("#sources input[type=checkbox]:checked")].map((el) => el.value);
  }

  function renderBatchButtons() {
    const any = checkedSourceIds().length > 0;
    setDisabled(document.getElementById("batchSupport"), !any);
    setDisabled(document.getElementById("batchInclude"), !any);
    setDisabled(document.getElementById("batchExclude"), !any);
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
      relink.textContent = "Relink";
      relink.addEventListener("click", () => api.call("/project/relink", {
        method: "POST",
        body: JSON.stringify({ baseRevision: project.revision, sourceId: source.id }),
        label: "Relinkando material…",
      }));
      const watch = document.createElement("button");
      watch.type = "button";
      watch.textContent = "Ver original";
      watch.addEventListener("click", () => player.playOriginal(source.id));
      controls.append(role, toggle, relink, watch);
      meta.append(name, controls);
      li.append(box, thumb, meta);
      list.appendChild(li);
    }
    if (focusedId) list.querySelector(`[data-source-id="${focusedId}"]`)?.focus();
    renderBatchButtons();
  }

  function renderPreparation(project) {
    const prep = project.preparation;
    if (!prep) return;
    const box = document.getElementById("prepList");
    box.replaceChildren();
    let done = 0;
    let total = 0;
    for (const source of project.assembly.sources.filter((item) => item.included)) {
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

  function renderDelivery(project) {
    const downloads = document.getElementById("downloads");
    downloads.replaceChildren();
    // Cadeado da entrega (Task 9): só libera depois de assistir e aprovar —
    // o servidor também recusa export sem aprovação (exportApproved).
    const approved = project.finalApprovedRevision != null;
    const lock = document.getElementById("deliveryLock");
    if (lock) {
      lock.textContent = approved
        ? "🔓 Revisão " + project.finalApprovedRevision + " aprovada — entrega liberada."
        : "🔒 Entrega bloqueada — assista à prévia atual até o fim e aprove para liberar.";
    }
    setDisabled(document.getElementById("export"), !approved);
    if (approved) {
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

  /** Consentimento pago por lote (Task 10): confirmação inline, nunca confirm() nativo. */
  function openPrepareConfirm(project) {
    const box = document.getElementById("prepareConfirm");
    box.replaceChildren();
    box.hidden = false;
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
      box.hidden = true;
      box.replaceChildren();
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
    cancel.addEventListener("click", () => {
      box.hidden = true;
      box.replaceChildren();
    });
    row.append(go, cancel);
    box.append(note, row);
    go.focus();
  }

  function render(project) {
    if (!project) return;
    document.getElementById("kind").value = project.input.kind;
    document.getElementById("inputText").value = project.input.text;
    document.getElementById("target").value = String(project.input.targetSeconds);
    document.getElementById("invite").hidden = project.assembly.sources.length > 0;
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
    if (preparing) {
      document.getElementById("prepareConfirm").replaceChildren();
      document.getElementById("prepareConfirm").hidden = true;
    }
    renderPreparation(project);
    // Sem cenas, o cartão equivale à revisão oculta da tela antiga.
    const hasScenes = project.scenes.length > 0;
    delivery.hidden = !hasScenes;
    renderDelivery(project);
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
  document.getElementById("export").onclick = () => api.call("/project/export", {
    method: "POST", body: JSON.stringify({ baseRevision: state.get("project").revision }),
    label: "Exportando…",
  });

  state.subscribe("project", render);
  render(state.get("project"));
}
