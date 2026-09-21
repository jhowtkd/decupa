// Região de contexto (Task 5): player da prévia, estado das correções de
// texto e pedido em linguagem natural. Cada render assina o estado e porta
// o bloco original do page.js monolítico, mantendo o comentário de
// comportamento. As ações por palavra moram no menu flutuante do texto.
import { watchedState } from "./watched.js";
import { montageDuration, supportGroups, replaceSupportGroup, candidateEntries } from "./montage.js";
import { deliveryChecklist, exportView, formatLabel, resolveView } from "./rail.js";

/**
 * Palco central da prévia (#stage): player único, frescor, aprovação.
 * Todo o comportamento veio verbatim do mountContexto — só a raiz mudou.
 */
export function mountStage({ state, api, player }) {
  const stage = document.getElementById("stage");
  if (!stage) return;
  let previewPlayer = document.getElementById("previewPlayer");
  if (!previewPlayer) {
    previewPlayer = document.createElement("video");
    previewPlayer.id = "previewPlayer";
    previewPlayer.controls = true;
    previewPlayer.preload = "metadata";
    stage.prepend(previewPlayer);
  }
  const note = document.createElement("div");
  note.className = "preview-meta";
  note.id = "previewNote";
  note.hidden = true;
  note.setAttribute("aria-live", "polite");
  const meta = document.createElement("div");
  meta.className = "preview-meta";
  meta.id = "deliveryMeta";
  const fresh = document.createElement("p");
  fresh.className = "muted";
  fresh.id = "freshChip";
  fresh.setAttribute("aria-live", "polite");
  const hint = document.createElement("p");
  hint.className = "muted";
  hint.textContent = "Assista à prévia atual antes de aprovar.";
  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML = '<button type="button" id="refreshPreview">Atualizar prévia</button>'
    + '<button type="button" class="primary" id="approveFinal">Aprovar prévia assistida</button>';
  const header = document.createElement("div");
  header.className = "stage-header";
  header.innerHTML = '<div class="view-tabs"><button type="button" id="montageView" aria-pressed="true">Montagem</button>'
    + '<button type="button" id="originalView" aria-pressed="false">Original</button></div><span id="viewLabel" class="muted">Prévia da montagem</span>';
  const screen = document.createElement("div");
  screen.className = "preview-screen";
  const empty = document.createElement("div");
  empty.className = "preview-empty";
  empty.innerHTML = '<span class="empty-mark" aria-hidden="true">▰</span><h1 id="emptyTitle">Seu próximo vídeo começa aqui</h1>'
    + '<p id="emptyMessage">Importe os materiais, conte o que você quer no briefing e monte seu primeiro corte.</p>'
    + '<button type="button" id="importFromStage" class="primary">Importar mídia</button>';
  screen.append(previewPlayer, empty);
  const footer = document.createElement("div");
  footer.className = "stage-footer";
  footer.append(note, meta, fresh, hint, row);
  stage.append(header, screen, footer);
  document.getElementById("importFromStage").onclick = () => document.getElementById("filePicker").click();
  document.getElementById("montageView").onclick = () => {
    previewPlayer.removeAttribute("data-source");
    state.set("view", "montagem");
    renderPreview(state.get("project"));
  };
  document.getElementById("originalView").onclick = () => {
    const p = state.get("project");
    const source = p?.assembly.sources.find((item) => item.included) || p?.assembly.sources[0];
    if (source) player.playOriginal(source.id);
  };

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

  /** Chip de frescor + gate do botão aprovar (Task 9). */
  function renderFreshness(project) {
    if (!project) return;
    const status = watchedState(project, state.get("watched"));
    const chip = document.getElementById("freshChip");
    if (chip) chip.textContent = !project.scenes.length ? "" : project.previewRevision == null
      ? (backgroundBusy(project, state.get("operation"), player) ? "Preparando prévia…" : "Prévia ainda não gerada") : status.label;
    setDisabled(document.getElementById("approveFinal"), !status.canApprove || state.get("view") === "original");
  }

  function renderPreview(project) {
    hint.textContent = "Assista à prévia atual antes de aprovar. " + (project?.scenes||[]).flatMap(s=>(s.animationNotes||[]).map(n=>"Pendente no handoff: "+n.description+" ("+n.destination+")")).join(" · ");
    if (!project) return;
    const original = state.get("view") === "original";
    if (!original && previewPlayer.hasAttribute("src") && !previewPlayer.hasAttribute("data-rev") && project.previewRevision == null) {
      previewPlayer.pause();
      previewPlayer.removeAttribute("src");
      previewPlayer.load();
    }
    const hasPreview = project.previewRevision != null || previewPlayer.hasAttribute("data-rev");
    previewPlayer.hidden = !original && !hasPreview;
    empty.hidden = !previewPlayer.hidden;
    footer.hidden = !project.scenes.length || original;
    document.getElementById("montageView").setAttribute("aria-pressed", String(!original));
    document.getElementById("originalView").setAttribute("aria-pressed", String(original));
    document.getElementById("originalView").disabled = project.assembly.sources.length === 0;
    const source = project.assembly.sources.find((item) => item.id === previewPlayer.dataset.source);
    document.getElementById("viewLabel").textContent = original ? "Original · " + (source?.name || "") : "Prévia da montagem";
    const hasMedia = project.assembly.sources.length > 0;
    const prep = project.preparation;
    document.getElementById("emptyTitle").textContent = !hasMedia ? "Seu próximo vídeo começa aqui"
      : prep?.status === "running" ? "Sua montagem está sendo preparada"
      : prep && ["interrupted", "attention"].includes(prep.status) ? "Vamos concluir a preparação"
      : project.scenes.length ? "A prévia ainda não está pronta" : "Materiais prontos para começar";
    document.getElementById("emptyMessage").textContent = !hasMedia
      ? "Importe os materiais, conte o que você quer no briefing e monte seu primeiro corte."
      : prep?.status === "running" ? "Acompanhe as etapas acima. Você pode consultar os materiais e a transcrição enquanto isso."
      : prep && ["interrupted", "attention"].includes(prep.status) ? "Veja o material com falha acima e retome a preparação. A transcrição concluída continua disponível em Texto."
      : "Confira o briefing e clique em Montar vídeo. Para assistir a uma fonte, escolha Original ou sua miniatura.";
    document.getElementById("importFromStage").hidden = hasMedia;
    setDisabled(document.getElementById("refreshPreview"), !project.scenes.length);
    renderFreshness(project);
    if (original) return;
    if (!project.scenes.length) { previewPlayer.hidden = true; empty.hidden = false; return; }
    // Metadados da prévia em linha de chips mono (Task 4).
    document.getElementById("deliveryMeta").replaceChildren(
      chip(project.previewRevision == null ? "prévia pendente" : "prévia " + project.previewRevision),
      chip(Math.round(montageDuration(project)) + "s"),
      chip(formatLabel(project.assembly)),
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
      || backgroundBusy(project, state.get("operation"), player),
    );
  }

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
  state.subscribe("project", (project) => renderPreview(project));
  state.subscribe("previewBusy", () => renderPreview(state.get("project")));
  state.subscribe("operation", () => renderPreview(state.get("project")));
  state.subscribe("view", () => renderPreview(state.get("project")));
  state.subscribe("watched", () => renderFreshness(state.get("project")));
  renderPreview(state.get("project"));
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

/**
 * Resumo do inspetor (puro): correções não alinhadas, existência de prévia
 * e aprovação DA REVISÃO ATUAL (edição invalida — spec §5).
 */
export function inspectorSections(project) {
  if (!project) return { corrections: 0, hasPreview: false, approved: false };
  return {
    corrections: (project.corrections || []).filter((item) => item.status !== "aligned").length,
    hasPreview: project.previewRevision != null,
    approved: project.finalApprovedRevision === project.revision,
  };
}

/** Trabalho de fundo que bloqueia ajuste/atualização (puro, sem DOM). */
function backgroundBusy(project, operation, player) {
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

export function mountContexto({ state, api, player }) {
  const root = document.getElementById("contexto");
  root.replaceChildren();

  const scenePanel = document.createElement("section");
  scenePanel.className = "scene-inspector";
  scenePanel.innerHTML = '<h1>Clipe selecionado</h1><h2 id="sceneTitle">Nenhuma cena ainda</h2>'
    + '<p id="sceneDetail" class="muted">A montagem aparecerá aqui depois da preparação.</p>'
    + '<div class="row"><button type="button" id="sceneBefore">← Antes</button><button type="button" id="sceneAfter">Depois →</button>'
    + '<button type="button" id="sceneDelete" class="danger">Remover cena</button></div>';
  root.appendChild(scenePanel);
  const decisionNote = document.createElement("p");
  decisionNote.id = "decisionReport";
  decisionNote.className = "muted";
  decisionNote.setAttribute("aria-live", "polite");
  scenePanel.appendChild(decisionNote);
  const supportForm=document.createElement("form");
  supportForm.className="support-editor";
  supportForm.innerHTML='<h2>Imagem de apoio · B-roll</h2><p id="supportReason" class="muted"></p>'
    +'<label>Apoio na cena<select id="supportGroup"></select></label>'
    +'<label>Imagem disponível<select id="supportCandidate"></select></label><p id="supportDetail" class="muted"></p>'
    +'<div class="support-times"><label>Início na cena (s)<input id="supportStart" type="number" min="0" step="any" required></label>'
    +'<label>Duração (s)<input id="supportDuration" type="number" min="0.001" step="any" required></label></div>'
    +'<div class="row"><button id="applySupport" type="submit">Aplicar apoio</button><button id="removeSupport" type="button">Remover apoio</button></div>';
  scenePanel.appendChild(supportForm);
  const field=id=>supportForm.querySelector("#"+id);
  function renderSupport(project,scene) {
    supportForm.hidden=!scene;
    if(!scene) return;
    const fps=project.assembly.fps.num/project.assembly.fps.den;
    const groups=supportGroups(project,scene);
    const selected=state.get("selectedSupport");
    const group=selected===""?null:groups.find(g=>g.id===selected)||groups[0];
    field("supportGroup").replaceChildren(new Option("Adicionar apoio", ""),...groups.map((g,i)=>new Option(`Apoio ${i+1} · ${(g.offsetFrames/fps).toFixed(2)} s`,g.id)));
    field("supportGroup").value=group?.id||"";
    const candidates=state.get("brollCandidates")||[];
    field("supportCandidate").replaceChildren(...candidates.map(c=>new Option(`${project.assembly.sources.find(s=>s.id===c.sourceId)?.name||c.sourceId} · ${c.start.toFixed(2)} s · ${c.description}`,c.id)));
    const current=candidates.find(c=>group && c.sourceId===group.sourceId && Math.round(c.start*fps)===group.sourceStart);
    if(current) field("supportCandidate").value=current.id;
    field("supportStart").value=String(group?group.offsetFrames/fps:1);
    const candidate=current||candidates[0];
    field("supportDuration").value=String(group?group.durationFrames/fps:candidate?Math.min(3,candidate.end-candidate.start):1);
    field("supportReason").textContent=project.proposal?.decisionReport?.supports?.find(s=>s.sceneId===scene.id)?.reason||"A voz continua tocando; o áudio do apoio fica mudo.";
    updateSupportDetail();
    field("applySupport").disabled=!candidates.length||backgroundBusy(project,state.get("operation"),player);
    field("removeSupport").disabled=!group||backgroundBusy(project,state.get("operation"),player);
  }
  function updateSupportDetail() {
    const candidate=(state.get("brollCandidates")||[]).find(c=>c.id===field("supportCandidate").value);
    field("supportDetail").textContent=candidate?`${candidate.description} · entrada ${candidate.start.toFixed(2)} s · até ${(candidate.end-candidate.start).toFixed(2)} s disponíveis`:"Nenhum apoio observado disponível. Importe mídia como Apoio ou Fala + apoio e prepare os materiais.";
  }
  field("supportGroup").onchange=()=>state.set("selectedSupport",field("supportGroup").value);
  field("supportCandidate").onchange=()=>{updateSupportDetail();const c=(state.get("brollCandidates")||[]).find(c=>c.id===field("supportCandidate").value);if(c)field("supportDuration").value=String(Math.min(Number(field("supportDuration").value),c.end-c.start));};
  async function saveSupport(remove) {
    const p=state.get("project"),scene=selectedScene(p);
    try {
      const fps=p.assembly.fps.num/p.assembly.fps.den;
      const c=(state.get("brollCandidates")||[]).find(c=>c.id===field("supportCandidate").value);
      const entries=remove?[]:candidateEntries(c,Math.round(Number(field("supportStart").value)*fps),Math.round(Number(field("supportDuration").value)*fps));
      const support=replaceSupportGroup(p,scene,field("supportGroup").value,entries);
      const result=await api.call("/project/edit",{method:"POST",body:JSON.stringify({baseRevision:p.revision,action:{type:"set-support",sceneId:scene.id,support}}),label:remove?"Removendo apoio…":"Aplicando apoio…"});
      if(result.res.ok) state.set("selectedSupport",entries[0]?entries[0].visualId+":"+entries[0].offsetFrames:null);
    } catch(error) {api.notifyError(error.message||String(error));}
  }
  supportForm.onsubmit=event=>{event.preventDefault();void saveSupport(false);};
  field("removeSupport").onclick=()=>saveSupport(true);
  for(const key of ["selectedSupport","brollCandidates"]) state.subscribe(key,()=>{const p=state.get("project");if(p)renderSupport(p,selectedScene(p));});
  function selectedScene(project) {
    return project.scenes.find((scene) => scene.id === state.get("selectedScene")) || project.scenes[0];
  }
  function renderScene(project) {
    decisionNote.textContent = decisionSummary(project.proposal?.decisionReport);
    const scene = selectedScene(project);
    document.getElementById("sceneTitle").textContent = scene ? scene.objective || scene.id : "Nenhuma cena ainda";
    document.getElementById("sceneDetail").textContent = scene
      ? [...new Set(scene.takes.map((take) => project.assembly.sources.find((source) => source.id === take.sourceId)?.name || take.sourceId))].join(" · ")
      : "Prepare os materiais para criar a sequência.";
    renderSupport(project,scene);
    const index = project.scenes.indexOf(scene);
    document.getElementById("sceneBefore").disabled = index <= 0;
    document.getElementById("sceneAfter").disabled = index < 0 || index === project.scenes.length - 1;
    document.getElementById("sceneDelete").disabled = !scene;
  }
  for (const [id, direction] of [["sceneBefore", "up"], ["sceneAfter", "down"], ["sceneDelete", null]]) {
    document.getElementById(id).onclick = () => {
      const p = state.get("project");
      const scene = selectedScene(p);
      if (!scene) return;
      return api.call("/project/edit", {
        method: "POST", body: JSON.stringify({ baseRevision: p.revision, action: { type: direction ? "move-scene" : "delete-scene", sceneId: scene.id, direction } }),
        label: direction ? "Movendo cena…" : "Removendo cena…",
      });
    };
  }
  state.subscribe("selectedScene", () => { if (state.get("project")) renderScene(state.get("project")); });

  const inspectorState = document.createElement("p");
  inspectorState.className = "muted";
  inspectorState.id = "inspectorState";
  inspectorState.setAttribute("aria-live", "polite");
  root.appendChild(inspectorState);

  const closeInspector = document.createElement("button");
  closeInspector.type = "button";
  closeInspector.id = "closeInspector";
  closeInspector.className = "close-inspector";
  closeInspector.textContent = "Fechar inspetor";
  closeInspector.addEventListener("click", () => { root.hidden = true; });
  root.prepend(closeInspector);

  // Só o estado das correções mora aqui; as ações por palavra (incluindo
  // corrigir, com campo inline) moram no menu flutuante do texto.
  const review = document.createElement("section");
  review.setAttribute("aria-label", "Correções de texto");
  review.innerHTML = "<h1>Correções de texto</h1>"
    + '<div id="corrections" aria-label="Estado das correções de texto"></div>';
  root.appendChild(review);

  // Pedido de ajuste usa o mesmo provedor configurado para Preparar montagem.
  const briefingActions = document.createElement("section");
  briefingActions.setAttribute("aria-label", "Ajuste");
  briefingActions.innerHTML = "<h1>Ajuste</h1>"
    + '<label>Pedido <textarea id="request" rows="2" placeholder="Ex.: encurtar a abertura"></textarea></label>'
    + '<div class="row"><button type="button" class="primary" id="adjust">Aplicar ajuste com IA</button>'
    + '<button type="button" class="danger" id="cancelPrep" hidden>Cancelar preparação</button></div>';
  root.appendChild(briefingActions);

  const delivery = document.createElement("section");
  delivery.id = "delivery";
  delivery.setAttribute("aria-label", "Entrega");
  delivery.innerHTML = "<h1>Entrega</h1>"
    + '<ul id="deliveryChecklist" class="plain"></ul>'
    + '<p class="muted" id="formatLine"></p>'
    + '<p class="muted" id="verifyLine"></p>'
    + '<p class="muted" id="deliveryLock" aria-live="polite"></p>'
    + '<div class="row"><button type="button" class="primary" id="exportTimeline">Preparar montagem para DaVinci</button><button type="button" id="editFormat">Alterar formato…</button><button type="button" id="confirmImport" hidden>Confirmar conferência</button></div><p class="muted">Resolve gratuito: baixe a timeline abaixo, abra um projeto no Resolve e use File → Import → Timeline. Depois, File → Export Project salva o projeto nativo .drp.</p><details><summary>Integração automática — Resolve Studio</summary><p class="muted">Requer o Resolve Studio aberto, com scripting local habilitado.</p><div class="row"><button type="button" id="export">Abrir montagem no DaVinci</button><button type="button" id="exportDrp" hidden>Exportar .drp</button><button type="button" id="resolveNewCopy" hidden>Criar outra cópia</button></div></details>'
    + '<p class="muted" id="exportStatus" role="status" aria-live="polite"></p>'
    + '<p id="downloads"></p>'
    + '<ul id="versionHistory" class="plain"></ul>';
  root.appendChild(delivery);

  // Controle de ritmo (#66): escolha do perfil é etapa anterior à
  // prévia/aprovação — a proposta compara pausas e oferece amostra
  // auditável do mesmo trecho antes e depois, sem chamada paga.
  const rhythm = document.createElement("section");
  rhythm.setAttribute("aria-label", "Ritmo");
  rhythm.innerHTML = "<h1>Ritmo</h1>"
    + '<p class="muted" id="rhythmCurrent"></p>'
    + '<div class="row" id="rhythmChoices"></div>';
  root.insertBefore(rhythm, delivery);

  const rhythmDialog = document.createElement("dialog");
  rhythmDialog.id = "rhythmDialog";
  rhythmDialog.innerHTML = '<h1>Ritmo do corte</h1>'
    + '<p class="muted" id="rhythmProfileDesc"></p>'
    + '<p id="rhythmSummary"></p>'
    + '<ul id="rhythmPauses" class="plain"></ul>'
    + '<p class="muted" id="rhythmUnaligned"></p>'
    + '<div class="row"><label>Antes <video id="rhythmAntes" controls width="240" muted></video></label>'
    + '<label>Depois <video id="rhythmDepois" controls width="240" muted></video></label></div>'
    + '<div class="row"><button type="button" class="primary" id="acceptRhythm">Aplicar ritmo</button>'
    + '<button type="button" id="rejectRhythm">Rejeitar</button>'
    + '<button type="button" id="closeRhythm">Fechar</button></div>';
  document.body.appendChild(rhythmDialog);

  function paintRhythm() {
    const p = state.get("project");
    const proposal = state.get("rhythmProposal");
    const profiles = state.get("rhythmProfiles") || {};
    document.getElementById("rhythmCurrent").textContent = !p
      ? ""
      : p.assembly.rhythmProfile
        ? `Perfil aplicado: ${profiles[p.assembly.rhythmProfile]?.name || p.assembly.rhythmProfile} — trocar não acumula cortes.`
        : "Nenhum perfil aplicado — escolha para ouvir a comparação.";
    const choices = document.getElementById("rhythmChoices");
    if (!p) { choices.textContent = ""; return; }
    if (!choices.childElementCount) {
      for (const profile of Object.values(profiles)) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = profile.name;
        button.onclick = () => {
          const current = state.get("project");
          if (!current) return;
          void api.call("/project/rhythm-proposal", {
            method: "POST",
            body: JSON.stringify({ baseRevision: current.revision, profileId: profile.id }),
            label: `Comparando ritmo ${profile.name}…`,
          });
        };
        choices.appendChild(button);
      }
    }
    if (!proposal) { if (rhythmDialog.open) rhythmDialog.close(); return; }
    const profile = profiles[proposal.profileId];
    document.getElementById("rhythmProfileDesc").textContent = profile
      ? `${profile.name}: ${profile.description}` : proposal.profileId;
    document.getElementById("rhythmSummary").textContent =
      `Fala total: ${proposal.beforeSeconds.toFixed(1)}s → ${proposal.afterSeconds.toFixed(1)}s `
      + `(${proposal.takes.reduce((t, take) => t + take.removedSeconds, 0).toFixed(1)}s de pausas retiradas).`;
    const list = document.getElementById("rhythmPauses");
    list.replaceChildren();
    for (const take of proposal.takes) {
      for (const pause of take.pauses) {
        const li = document.createElement("li");
        li.textContent = `pausa em ${pause.start.toFixed(2)}s (${pause.duration.toFixed(2)}s) → sobra ${pause.keep.toFixed(2)}s`
          + (pause.protectedPart ? " · trecho protegido preservado" : "");
        list.appendChild(li);
      }
    }
    document.getElementById("rhythmUnaligned").textContent = proposal.unaligned.length
      ? `Sem alinhamento de palavras: ${proposal.unaligned.length} fonte(s) ignorada(s), sem microcortes — alinhe para incluir.`
      : "";
    for (const which of ["antes", "depois"]) {
      const el = document.getElementById(which === "antes" ? "rhythmAntes" : "rhythmDepois");
      el.src = proposal.sample ? `/project/rhythm-sample/${proposal.id}/${which}` : "";
      el.style.visibility = proposal.sample ? "visible" : "hidden";
    }
    if (!rhythmDialog.open) rhythmDialog.showModal();
  }
  state.subscribe("rhythmProposal", paintRhythm);
  state.subscribe("project", paintRhythm);
  document.getElementById("closeRhythm").onclick = () => rhythmDialog.close();
  document.getElementById("acceptRhythm").onclick = () => {
    const p = state.get("project");
    const proposal = state.get("rhythmProposal");
    if (!p || !proposal) return;
    void api.call("/project/rhythm-accept", {
      method: "POST",
      body: JSON.stringify({ baseRevision: p.revision, proposalId: proposal.id }),
      label: "Aplicando ritmo…",
    });
  };
  document.getElementById("rejectRhythm").onclick = () => {
    const proposal = state.get("rhythmProposal");
    if (!proposal) return;
    void api.call("/project/rhythm-reject", {
      method: "POST",
      body: JSON.stringify({ proposalId: proposal.id }),
      label: "Rejeitando ritmo…",
    });
  };

  // Escolha de formato: visível (linha + chip) e editável por diálogo —
  // muda a revisão e invalida prévia/aprovação via /project/settings.
  const formatDialog = document.createElement("dialog");
  formatDialog.id = "formatDialog";
  formatDialog.innerHTML = '<h1>Formato da entrega</h1>'
    + '<label>Usar formato de <select id="formatSource"></select></label>'
    + '<label>Largura <input id="formatWidth" type="number" min="2" step="2"></label>'
    + '<label>Altura <input id="formatHeight" type="number" min="2" step="2"></label>'
    + '<label>Fps <input id="formatFps" type="text" placeholder="25 ou 30000/1001"></label>'
    + '<div class="row"><button type="button" class="primary" id="saveFormat">Aplicar formato</button>'
    + '<button type="button" id="closeFormat">Fechar</button></div>';
  document.body.appendChild(formatDialog);
  document.getElementById("editFormat").onclick = () => {
    const p = state.get("project");
    if (!p) return;
    const sel = document.getElementById("formatSource");
    sel.replaceChildren(new Option("Personalizado", ""));
    for (const s of p.assembly.sources.filter((item) => item.hasVideo)) {
      sel.appendChild(new Option(s.name, s.id));
    }
    sel.value = "";
    document.getElementById("formatWidth").value = p.assembly.width;
    document.getElementById("formatHeight").value = p.assembly.height;
    document.getElementById("formatFps").value = `${p.assembly.fps.num}/${p.assembly.fps.den}`;
    formatDialog.showModal();
  };
  document.getElementById("closeFormat").onclick = () => formatDialog.close();
  // Confirmação manual da conferência (#63): exige entrega da revisão
  // atual; grava revisão+artefato+origem manual no verificacao.json.
  document.getElementById("confirmImport").onclick = () => {
    const p = state.get("project");
    if (!p) return;
    void api.call("/project/verify-import", {
      method: "POST",
      body: JSON.stringify({ baseRevision: p.revision }),
      label: "Confirmando conferência…",
    });
  };
  document.getElementById("saveFormat").onclick = async () => {
    const p = state.get("project");
    if (!p) return;
    const sourceId = document.getElementById("formatSource").value;
    let body;
    if (sourceId) {
      body = { baseRevision: p.revision, sourceId };
    } else {
      const rawFps = document.getElementById("formatFps").value.trim();
      const split = rawFps.split("/");
      const fps = split.length === 2
        ? { num: Number(split[0]), den: Number(split[1]) }
        : { num: Number(rawFps) * 1000, den: 1000 };
      body = {
        baseRevision: p.revision,
        width: Number(document.getElementById("formatWidth").value),
        height: Number(document.getElementById("formatHeight").value),
        fps,
      };
    }
    const { res } = await api.call("/project/settings", {
      method: "POST", body: JSON.stringify(body), label: "Alterando formato…",
    });
    if (res.ok) formatDialog.close();
  };
  const exportUi = { status: "idle", error: null, revision: null };
  let resolveDelivery=null;
  let resolveRevision=null;

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

  function renderDelivery(project) {
    // Checklist derivado do estado real: atualiza a cada render de projeto.
    const checklist = document.getElementById("deliveryChecklist");
    checklist.replaceChildren();
    for (const item of deliveryChecklist(project)) {
      const li = document.createElement("li");
      li.append(chip((item.done ? "✓ " : "○ ") + item.label));
      checklist.appendChild(li);
    }
    // Export de outra revisão não conta: edição nova volta ao ocioso.
    if (exportUi.status === "done" && exportUi.revision !== project.revision) {
      exportUi.status = "idle";
      exportUi.error = null;
      exportUi.revision = null;
    }
    const downloads = document.getElementById("downloads");
    downloads.replaceChildren();
    // Cadeado da entrega (Task 9): só libera depois de assistir e aprovar —
    // o servidor também recusa export sem aprovação (exportApproved).
    const approved = project.finalApprovedRevision === project.revision;
    const lock = document.getElementById("deliveryLock");
    if (lock) {
      lock.textContent = approved
        ? "🔓 Revisão " + project.finalApprovedRevision + " aprovada — entrega liberada."
        : "🔒 Entrega bloqueada — assista à prévia atual até o fim e aprove para liberar.";
    }
    const formatLine = document.getElementById("formatLine");
    const canvasOwner = project.assembly.canvasSourceId
      ? project.assembly.sources.find((item) => item.id === project.assembly.canvasSourceId)
      : null;
    formatLine.textContent = "Formato: " + formatLabel(project.assembly)
      + (project.assembly.canvasManual
        ? canvasOwner ? ` — da fonte "${canvasOwner.name}"` : " — personalizado"
        : canvasOwner ? ` — da fonte "${canvasOwner.name}"` : " — padrão do projeto");
    // Estado da conferência: exportar nunca confirma; revisão nova
    // não herda a confirmação (verificacao.json é por revisão).
    const verifyLine = document.getElementById("verifyLine");
    const confirmImportButton = document.getElementById("confirmImport");
    const verificacao = state.get("verificacao");
    if (!verificacao) {
      verifyLine.textContent = "Conferência de importação: sem entrega da revisão atual.";
      confirmImportButton.hidden = true;
    } else if (verificacao.status === "confirmada") {
      verifyLine.textContent = `Conferência de importação: confirmada (revisão ${verificacao.revision}, confirmação manual).`;
      confirmImportButton.hidden = true;
    } else {
      verifyLine.textContent = `Conferência de importação: pendente — importe a revisão ${verificacao.revision} no Resolve e confira a timeline.`;
      confirmImportButton.hidden = false;
    }
    const rev = project.finalApprovedRevision;
    const formats = approved ? [
      { id: "otio", label: "Baixar timeline.otio", href: "/project/output/" + rev + "/otio", file: "timeline.otio" },
      { id: "mp4", label: "Baixar reference.mp4", href: "/project/output/" + rev + "/mp4", file: "reference.mp4" },
      { id: "instrucoes", label: "Instruções de conferência (.txt)", href: "/project/output/" + rev + "/instrucoes", file: "importar-no-resolve.txt" },
      { id: "verificacao", label: "verificacao.json", href: "/project/output/" + rev + "/verificacao", file: "verificacao.json" },
    ] : null;
    if(resolveRevision!==project.revision) resolveDelivery=null;
    const view = exportView(exportUi, approved, formats);
    const nativeView=resolveView(resolveDelivery,approved);
    const exportButton = document.getElementById("export");
    exportButton.textContent = nativeView.buttonLabel;
    exportButton.classList.toggle("is-loading", view.loading);
    setDisabled(exportButton, nativeView.disabled);
    document.getElementById("exportDrp").hidden=resolveDelivery?.status!=="ready";
    document.getElementById("resolveNewCopy").hidden=!nativeView.newCopy;
    setDisabled(document.getElementById("exportTimeline"),view.disabled);
    const exportStatus = document.getElementById("exportStatus");
    exportStatus.textContent = (nativeView.statusText||view.statusText)+" · O .drp depende dos arquivos de mídia originais.";
    exportStatus.className = "muted export-" + view.tone;
    for (const format of view.formats || []) {
      const link = document.createElement("a");
      link.className = "data";
      link.href = format.href;
      link.textContent = format.label;
      link.setAttribute("download", format.file);
      downloads.appendChild(link);
    }
    if(resolveDelivery?.drpPath){const link=document.createElement("a");link.href="/project/resolve-drp";link.textContent="Baixar projeto .drp";link.download="projeto.drp";downloads.appendChild(link);}
    const history = document.getElementById("versionHistory");
    history.replaceChildren(
      chip("revisão " + project.revision),
      chip(project.previewRevision != null ? "prévia " + project.previewRevision : "sem prévia"),
      chip(project.finalApprovedRevision != null ? "aprovada " + project.finalApprovedRevision : "não aprovada"),
      chip("formato " + formatLabel(project.assembly)),
    );
  }

  function render(project) {
    if (!project) return;
    const operation = state.get("operation");
    renderCorrections(project);
    const sections = inspectorSections(project);
    renderScene(project);
    document.getElementById("inspectorState").textContent =
      (sections.hasPreview ? "prévia " + project.previewRevision : "sem prévia")
      + " · " + sections.corrections + " correção(ões) pendente(s)"
      + (sections.approved ? " · aprovada ✓" : "");
    const preparing = project.preparation
      && project.preparation.status === "running";
    document.getElementById("cancelPrep").hidden = !(
      preparing || (operation && operation.stage === "preparing")
    );
    // Ajustar dispara trabalho longo no servidor: evita o segundo clique
    // parecer travado (o servidor cancelaria o anterior).
    const bg = backgroundBusy(project, operation, player);
    setDisabled(document.getElementById("adjust"), bg || !project.scenes.length);
    review.hidden = sections.corrections === 0;
    renderDelivery(project);
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
      modelOptIn: true, visualOptIn: true,
    }),
    label: "Ajustando montagem…",
  });
  document.getElementById("exportTimeline").onclick = async () => {
    const project = state.get("project");
    exportUi.status = "running";
    exportUi.error = null;
    exportUi.revision = null;
    renderDelivery(project);
    try {
      const { res, body } = await api.call("/project/export", {
        method: "POST", body: JSON.stringify({ baseRevision: project.revision }),
        label: "Exportando…",
      });
      if (res.ok) {
        exportUi.status = "done";
        exportUi.revision = project.revision;
      } else {
        exportUi.status = "error";
        exportUi.error = body.error || "erro " + res.status;
      }
    } catch (err) {
      exportUi.status = "error";
      exportUi.error = (err && err.message) || String(err);
    }
    renderDelivery(state.get("project"));
  };

  async function deliverResolve(newCopy=false, exportDrp=false) {
    const project=state.get("project");resolveRevision=project.revision;
    resolveDelivery={status:"running",stage:"connecting"};renderDelivery(project);
    let stopped=false;
    async function poll(){
      if(stopped)return;
      try{const response=await fetch("/project/resolve-status");const body=await response.json();if(!stopped&&body.delivery){resolveDelivery=body.delivery;renderDelivery(state.get("project"));}}catch{/* next poll retries */}
      if(!stopped)setTimeout(poll,1000);
    }
    setTimeout(poll,500);
    try{
      const {res,body}=await api.call(exportDrp?"/project/export-drp":"/project/deliver-resolve",{method:"POST",body:JSON.stringify({baseRevision:project.revision,newCopy}),label:"Entregando ao DaVinci…"});
      if(res.ok)resolveDelivery=body.delivery;
      else {const response=await fetch("/project/resolve-status");const status=await response.json();resolveDelivery=status.delivery?{...status.delivery,error:body.error}:{status:"error",created:false,error:body.error};}
      if(res.ok){exportUi.status="done";exportUi.revision=project.revision;}
    }catch(error){resolveDelivery={status:"error",error:error.message};}
    finally{stopped=true;renderDelivery(state.get("project"));}
  }
  document.getElementById("export").onclick=()=>deliverResolve();
  document.getElementById("resolveNewCopy").onclick=()=>deliverResolve(true);
  document.getElementById("exportDrp").onclick=()=>deliverResolve(false,true);
  fetch("/project/resolve-status").then(r=>r.json()).then(body=>{if(!resolveDelivery&&body.delivery){resolveDelivery=body.delivery;resolveRevision=body.delivery.revision;renderDelivery(state.get("project"));}}).catch(()=>{});

  state.subscribe("project", render);
  state.subscribe("previewBusy", () => render(state.get("project")));
  state.subscribe("operation", () => render(state.get("project")));
  render(state.get("project"));
}

export function decisionSummary(report) {
  if (!report) return "Decisão não registrada";
  const applied = report.cuts.filter(c => c.applied).length;
  const mode = report.mode === "observe" ? " · observação, sem aplicar" : "";
  const status = report.status === "fallback" ? "Falha na decisão; trechos afetados preservados" : report.status === "not-run" ? "Sem decisão Jev" : "Decisão Jev concluída";
  return `${status}${mode} · ${report.model || "sem modelo"} · ${(report.elapsedMs / 1000).toFixed(1)} s · ${applied} cortes aplicados, ${report.cuts.length - applied} mantidos${report.reason ? " · " + report.reason : ""}`;
}
