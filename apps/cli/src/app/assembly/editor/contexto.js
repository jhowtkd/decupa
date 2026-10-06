import { mountFillerContext, mountFillerReview } from "./cacoetes.js";
// Região de contexto (Task 5): player da prévia, estado das correções de
// texto e pedido em linguagem natural. Cada render assina o estado e porta
// o bloco original do page.js monolítico, mantendo o comentário de
// comportamento. As ações por palavra moram no menu flutuante do texto.
import { watchedState } from "./watched.js";
import { montageDuration, supportGroups, replaceSupportGroup, candidateEntries } from "./montage.js";
import { deliveryChecklist, deliveryFormats, exportView, formatLabel, formatOrigin, resolveView, verifyView } from "./rail.js";
import { ICON } from "./icons.js";
import { approveButtonView, reviewView, watchProgress } from "./progress.js";
import { coverageComplete, coveredSeconds, newCoverage, playbackReading } from "./playback.js";
import { singleFlight } from "./sequencia.js";

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
  const empty = document.createElement("div");
  empty.className = "preview-empty";
  empty.innerHTML = '<span class="empty-mark">' + ICON.importMedia + '</span><h1 id="emptyTitle">Seu próximo vídeo começa aqui</h1>'
    + '<p id="emptyMessage">Importe os materiais, conte o que você quer no briefing e monte seu primeiro corte.</p>'
    + '<button type="button" id="importFromStage" class="primary">Importar mídia</button>';
  const overlay = document.createElement("div");
  overlay.className = "preview-overlay";
  overlay.innerHTML = '<span id="viewLabel" class="pill mono preview-label">Prévia da montagem</span>'
    + '<div class="view-tabs" role="group" aria-label="Fonte do monitor">'
    + '<button type="button" id="montageView" aria-pressed="true">Montagem</button>'
    + '<button type="button" id="originalView" aria-pressed="false">Original</button></div>';
  const screen = document.createElement("div");
  screen.className = "preview-screen";
  screen.append(previewPlayer, empty, overlay);
  const review = document.createElement("div");
  review.className = "sub review-card";
  review.id = "reviewCard";
  review.innerHTML = '<div class="review-head">'
    + '<svg class="ring" width="44" height="44" viewBox="0 0 44 44" aria-hidden="true">'
    + '<circle class="ring-track" cx="22" cy="22" r="19"></circle>'
    + '<circle id="watchRing" class="ring-fill" cx="22" cy="22" r="19" transform="rotate(-90 22 22)"></circle>'
    + '<text id="watchPct" class="ring-pct" x="22" y="26" text-anchor="middle"></text></svg>'
    + '<div class="review-text"><span id="reviewTitle" class="review-title"></span>'
    + '<span id="freshChip" aria-live="polite"></span></div></div>'
    + '<div class="review-actions"><button type="button" id="refreshPreview" class="quiet small">Atualizar prévia</button>'
    + '<button type="button" class="primary" id="approveFinal">Aprovar prévia assistida</button></div>';
  stage.append(screen, note, meta, review);
  mountFillerReview({ state }, review);
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

  // Rastreio "assistido de verdade" (#103): só conta a reprodução real da
  // prévia atual, provada pelo played do player. A cobertura (playback.js)
  // junta os trechos tocados; seek para a frente não entra, voltar zera, e
  // trocar de src (Original ou revisão nova) recomeça do zero. Aqui só se
  // leem os eventos do player.
  let coverage = newCoverage();
  const RING = 2 * Math.PI * 19;
  function isPreviewSrc(project) {
    return !!project && project.previewRevision != null
      && previewPlayer.getAttribute("data-rev") === String(project.previewRevision);
  }
  function markWatched() {
    const project = state.get("project");
    if (!isPreviewSrc(project)) return;
    state.set("watched", { revision: project.previewRevision, ended: true });
  }
  function resetWatched() {
    state.set("watched", { revision: null, ended: false });
  }
  function playedRanges() {
    const ranges = [];
    for (let i = 0; i < previewPlayer.played.length; i++) {
      ranges.push([previewPlayer.played.start(i), previewPlayer.played.end(i)]);
    }
    return ranges;
  }
  /**
   * O assistido acompanha a cobertura contra a duração de agora: marca quando
   * cobre e revoga quando deixa de cobrir (metadados que mudam a duração).
   */
  function settleWatched(project) {
    const watched = state.get("watched");
    const marked = watched?.ended === true && watched.revision === project.previewRevision;
    const complete = coverageComplete(coverage, previewPlayer.duration);
    if (complete && !marked) markWatched();
    else if (!complete && watched?.ended) resetWatched();
    paintReview(project);
  }
  /** Uma leitura do player; `seek` marca posição vinda de salto (seeking/seeked). */
  function readPlayback(seek) {
    const project = state.get("project");
    if (!Number.isFinite(previewPlayer.currentTime) || !isPreviewSrc(project)) return;
    const reading = playbackReading(coverage, previewPlayer.currentTime, {
      played: playedRanges(), rate: previewPlayer.playbackRate, seek,
      source: previewPlayer.getAttribute("data-rev"),
    });
    coverage = reading.coverage;
    if (reading.reset) resetWatched();
    settleWatched(project);
  }
  previewPlayer.addEventListener("timeupdate", () => readPlayback(previewPlayer.seeking));
  previewPlayer.addEventListener("seeking", () => readPlayback(true));
  previewPlayer.addEventListener("seeked", () => readPlayback(true));
  previewPlayer.addEventListener("ended", () => readPlayback(false));
  // Fecha o trecho na velocidade antiga antes de a nova valer (sem retroagir).
  previewPlayer.addEventListener("ratechange", () => readPlayback(false));
  const onDuration = () => {
    const project = state.get("project");
    if (isPreviewSrc(project)) settleWatched(project);
  };
  previewPlayer.addEventListener("durationchange", onDuration);
  previewPlayer.addEventListener("loadedmetadata", onDuration);
  previewPlayer.addEventListener("loadstart", () => {
    coverage = newCoverage(0, { source: previewPlayer.getAttribute("data-rev") });
    state.set("watched", { revision: null, ended: false });
  });

  /** Cartão de revisão: anel do visto, texto do gate e aprovar travado (Task 9). */
  function paintReview(project) {
    if (!project) return;
    const status = watchedState(project, state.get("watched"));
    const view = reviewView(project, status,
      watchProgress(coveredSeconds(coverage, previewPlayer.duration), previewPlayer.duration, status.watched));
    document.getElementById("reviewTitle").textContent = view.title;
    document.getElementById("freshChip").textContent = project.previewRevision == null
      ? (backgroundBusy(project, state.get("operation"), player) ? "Preparando prévia…" : "Prévia ainda não gerada")
      : view.detail;
    document.getElementById("watchRing").style.strokeDasharray = (view.ratio * RING).toFixed(1) + " " + RING.toFixed(1);
    document.getElementById("watchPct").textContent = Math.round(view.ratio * 100) + "%";
    const approve = document.getElementById("approveFinal");
    const button = approveButtonView(project, status, state.get("view") === "original");
    setDisabled(approve, button.disabled);
    approve.classList.toggle("is-locked", button.locked);
    approve.classList.toggle("is-approved", button.approved);
    approve.innerHTML = (button.icon === "lock" ? ICON.lock : ICON.check) + button.label;
  }

  function renderPreview(project) {
    if (!project) return;
    const sourceId = previewPlayer.dataset.source;
    if (sourceId && !project.assembly.sources.some((source) => source.id === sourceId)) {
      previewPlayer.pause();
      previewPlayer.removeAttribute("src");
      previewPlayer.removeAttribute("data-source");
      previewPlayer.load();
      state.set("view", "montagem");
      return;
    }
    const original = state.get("view") === "original";
    if (!original && previewPlayer.hasAttribute("src") && !previewPlayer.hasAttribute("data-rev") && project.previewRevision == null) {
      previewPlayer.pause();
      previewPlayer.removeAttribute("src");
      previewPlayer.load();
    }
    const hasPreview = project.previewRevision != null || previewPlayer.hasAttribute("data-rev");
    previewPlayer.hidden = !original && !hasPreview;
    empty.hidden = !previewPlayer.hidden;
    review.hidden = !project.scenes.length || original;
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
      : prep?.status === "running" ? "Acompanhe as etapas abaixo. A transcrição já aparece no texto enquanto isso."
      : prep && ["interrupted", "attention"].includes(prep.status) ? "Veja o material com falha no rail e retome a preparação. A transcrição concluída continua no texto."
      : "Confira o briefing e clique em Montar vídeo. Para assistir a uma fonte, escolha Original ou sua miniatura.";
    document.getElementById("importFromStage").hidden = hasMedia;
    setDisabled(document.getElementById("refreshPreview"), !project.scenes.length || refreshPreview.busy());
    paintReview(project);
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
        // A posição mantida na troca não foi tocada nesta prévia: a contagem recomeça.
        coverage = newCoverage(Number.isFinite(time) ? time : 0, { source: String(project.previewRevision) });
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
    paintReview(project);
    // Atualizar prévia renderiza no servidor: trava no clique até a resposta.
    const refresh = document.getElementById("refreshPreview");
    const refreshing = refreshPreview.busy();
    refresh.textContent = refreshing ? "Atualizando prévia…" : "Atualizar prévia";
    refresh.setAttribute("aria-busy", String(refreshing));
    setDisabled(
      refresh,
      refreshing
      || project.scenes.length === 0
      || (current && project.previewArtifact?.revision === project.revision)
      || backgroundBusy(project, state.get("operation"), player),
    );
  }

  const refreshPreview = refreshPreviewAction({
    state, api,
    // O bootstrap (page.js) escuta este evento e reage com scheduleAutoPreview direto (sem filtro).
    onStale: () => document.dispatchEvent(new CustomEvent("decupa:schedule-preview")),
    onChange: () => renderPreview(state.get("project")),
  });
  document.getElementById("refreshPreview").onclick = () => refreshPreview();
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
  state.subscribe("watched", () => paintReview(state.get("project")));
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

/**
 * "Atualizar prévia" manual: um render por vez, travado desde o clique
 * (`onChange(busy)` repinta o botão). Prévia obsoleta (409) ou erro real
 * reconcilia com o servidor e chama `onStale` para retomar a revisão atual
 * sem loop (R2).
 * @param {{ state: any, api: any, onStale: () => void, onChange?: (busy: boolean) => void }} deps
 */
export function refreshPreviewAction({ state, api, onStale, onChange }) {
  return singleFlight(() => {
    const p = state.get("project");
    if (!p) return undefined;
    return api.call("/project/preview", {
      method: "POST", body: JSON.stringify({ baseRevision: p.revision }),
      label: "Renderizando prévia…",
    }).then(({ res }) => {
      if (!res.ok) return api.call("/project").then(onStale);
      return undefined;
    }).catch(() => {});
  }, onChange);
}

/** Aviso quando "Pedir ajuste à IA" é enviado sem texto. */
export const EMPTY_ADJUST_MESSAGE = "Escreva o ajuste que você quer antes de enviar.";

/**
 * "Pedir ajuste à IA": pedido vazio não sai (aviso na tela, sem chamada);
 * com texto, um pedido pago por vez. `onChange(busy)` pinta o botão; o
 * erro já aparece no status pelo api.call.
 * @param {{ state: any, api: any, readRequest: () => string, onChange?: (busy: boolean) => void }} deps
 */
export function adjustAction({ state, api, readRequest, onChange }) {
  return singleFlight(() => {
    const p = state.get("project");
    if (!p) return undefined;
    const request = readRequest();
    if (!request.trim()) {
      api.notifyError(EMPTY_ADJUST_MESSAGE);
      return undefined;
    }
    return api.call("/project/adjust", {
      method: "POST",
      body: JSON.stringify({
        baseRevision: p.revision,
        request,
        modelOptIn: true, visualOptIn: true,
      }),
      label: "Ajustando montagem…",
    }).catch(() => {});
  }, onChange);
}

/** Botão de ajuste (puro): em voo trava com o rótulo de andamento; fora dele, trabalho de fundo ou falta de cena travam. */
export function adjustButtonView(inflight, background, hasScenes) {
  if (inflight) return { disabled: true, label: "Ajustando montagem…", busy: true };
  return { disabled: !!background || !hasScenes, label: "Aplicar ajuste com IA", busy: false };
}

/**
 * Diálogo de ritmo (puro). Abre sozinho só para proposta da revisão atual
 * que a pessoa ainda não fechou; proposta de revisão velha fica marcada e
 * não se aplica.
 */
export function rhythmDialogView(project, proposal, dismissedId) {
  if (!project || !proposal) return { show: false, stale: false, autoOpen: false };
  const stale = proposal.baseRevision !== project.revision;
  return { show: true, stale, autoOpen: !stale && proposal.id !== dismissedId };
}

/** Pendências do monitor (puro): correções não alinhadas, lacunas e animações a fazer. */
export function pendingItems(project) {
  if (!project) return [];
  const span = (c) => c.sourceId + " " + c.start.toFixed(1).replace(".", ",") + "–" + c.end.toFixed(1).replace(".", ",") + " s";
  const items = [];
  for (const correction of project.corrections || []) {
    if (correction.status === "aligned") continue;
    items.push(correction.status === "error"
      ? { tone: "error", title: "Correção com erro", detail: span(correction) + " · " + (correction.error || "falha no alinhamento") + ". O texto original segue valendo." }
      : { tone: "running", title: "Alinhando correção", detail: span(correction) + " · o trecho original segue valendo até terminar." });
  }
  project.scenes.forEach((scene, index) => {
    for (const gap of scene.gaps || []) items.push({ tone: "error", title: "Cena " + (index + 1), detail: "Lacuna: " + gap });
    for (const note of scene.animationNotes || []) {
      items.push({ tone: "info", title: "Animação no " + note.destination, detail: note.description });
    }
  });
  return items;
}

export function mountContexto({ state, api, player }) {
  const root = document.getElementById("contexto");
  root.replaceChildren();

  const scenePanel = document.createElement("details");
  scenePanel.className = "sub scene-inspector";
  scenePanel.open = true;
  scenePanel.innerHTML = '<summary><span class="ttl">Cena selecionada</span><span id="sceneTitle" class="scene-card-title">Nenhuma cena ainda</span></summary>'
    + '<p id="sceneDetail" class="muted">A montagem aparecerá aqui depois da preparação.</p>';
  const decisionNote = document.createElement("p");
  decisionNote.id = "decisionReport";
  decisionNote.className = "muted";
  decisionNote.setAttribute("aria-live", "polite");
  scenePanel.appendChild(decisionNote);
  const supportForm=document.createElement("form");
  supportForm.className="support-editor";
  supportForm.innerHTML='<h2>Imagem de apoio</h2><p id="supportReason" class="muted"></p>'
    +'<label>Apoio na cena<select id="supportGroup"></select></label>'
    +'<label>Imagem disponível<select id="supportCandidate"></select></label><p id="supportDetail" class="muted"></p>'
    +'<div class="support-times"><label>Início na cena (s)<input id="supportStart" type="number" min="0" step="any" required></label>'
    +'<label>Duração (s)<input id="supportDuration" type="number" min="0.001" step="any" required></label></div>'
    +'<div class="row"><button id="applySupport" type="submit">Aplicar apoio</button><button id="removeSupport" type="button">Remover apoio</button></div>';
  scenePanel.appendChild(supportForm);
  const field=id=>supportForm.querySelector("#"+id);
  // O formulário só é repopulado quando a cena ou o apoio escolhido mudam (ou
  // quando nada foi mexido ainda): o projeto que chega durante a edição não
  // reverte os campos, e "Aplicar" envia o que a pessoa digitou.
  const supportEdit = { key: null, touched: false, groups: null, candidates: null };
  for (const id of ["supportCandidate","supportStart","supportDuration"]) {
    field(id).addEventListener("input",()=>{supportEdit.touched=true;});
    field(id).addEventListener("change",()=>{supportEdit.touched=true;});
  }
  function renderSupport(project,scene) {
    supportForm.hidden=!scene;
    if(!scene) { supportEdit.key=null; return; }
    const fps=project.assembly.fps.num/project.assembly.fps.den;
    const groups=supportGroups(project,scene);
    const selected=state.get("selectedSupport");
    const group=selected===""?null:groups.find(g=>g.id===selected)||groups[0];
    const candidates=state.get("brollCandidates")||[];
    const key=scene.id+"\0"+(group?.id??"");
    const fresh=key!==supportEdit.key||(!supportEdit.touched&&candidates!==supportEdit.candidates);
    const groupsSig=JSON.stringify(groups.map(g=>[g.id,g.offsetFrames]));
    if(fresh||groupsSig!==supportEdit.groups) {
      field("supportGroup").replaceChildren(new Option("Adicionar apoio", ""),...groups.map((g,i)=>new Option(`Apoio ${i+1} · ${(g.offsetFrames/fps).toFixed(2)} s`,g.id)));
      field("supportGroup").value=group?.id||"";
      supportEdit.groups=groupsSig;
    }
    if(fresh||candidates!==supportEdit.candidates) {
      const kept=field("supportCandidate").value;
      field("supportCandidate").replaceChildren(...candidates.map(c=>new Option(`${project.assembly.sources.find(s=>s.id===c.sourceId)?.name||c.sourceId} · ${c.start.toFixed(2)} s · ${c.description}`,c.id)));
      if(!fresh&&candidates.some(c=>c.id===kept)) field("supportCandidate").value=kept;
      supportEdit.candidates=candidates;
    }
    if(fresh) {
      const current=candidates.find(c=>group && c.sourceId===group.sourceId && Math.round(c.start*fps)===group.sourceStart);
      if(current) field("supportCandidate").value=current.id;
      field("supportStart").value=String(group?group.offsetFrames/fps:1);
      const candidate=current||candidates[0];
      field("supportDuration").value=String(group?group.durationFrames/fps:candidate?Math.min(3,candidate.end-candidate.start):1);
      supportEdit.key=key;
      supportEdit.touched=false;
    }
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
      // Salvo: o formulário volta a espelhar o servidor.
      if(result.res.ok) { supportEdit.key=null; state.set("selectedSupport",entries[0]?entries[0].visualId+":"+entries[0].offsetFrames:null); }
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
  }
  state.subscribe("selectedScene", () => { if (state.get("project")) renderScene(state.get("project")); });

  const pending = document.createElement("section");
  pending.className = "pending";
  pending.setAttribute("aria-label", "Pendências");
  pending.innerHTML = '<div class="pending-head"><h2>Pendências</h2><p id="inspectorState" aria-live="polite"></p></div>'
    + '<ul id="corrections" class="plain pending-list"></ul>';

  // Pedido de ajuste usa o mesmo provedor configurado para Preparar montagem.
  const briefingActions = document.createElement("section");
  briefingActions.className = "adjust";
  briefingActions.setAttribute("aria-label", "Pedir ajuste à IA");
  briefingActions.innerHTML = '<label for="request" class="ttl">Pedir ajuste à IA</label>'
    + '<div class="composer"><textarea id="request" rows="1" placeholder="Ex.: encurtar a abertura"></textarea>'
    + '<button type="button" class="icon send" id="adjust" aria-label="Aplicar ajuste com IA">' + ICON.send + "</button></div>"
    + '<p class="consent">Envia texto e quadros ao provedor configurado · pode haver cobrança</p>'
    + '<button type="button" class="danger small" id="cancelPrep" hidden>Cancelar preparação</button>';

  const delivery = document.createElement("section");
  delivery.id = "delivery";
  delivery.setAttribute("aria-label", "Entrega");
  delivery.innerHTML = '<header class="delivery-head"><div class="delivery-title"><h1>Entrega</h1><span id="deliveryBadge" class="pill"></span></div>'
    + '<p id="deliveryLock" aria-live="polite"></p><ul id="deliveryChecklist" class="plain checklist"></ul></header>'
    + '<div id="verifyCard" class="sub verify-card"><span class="verify-icon" id="verifyIcon"></span>'
    + '<div class="verify-text"><strong id="verifyTitle"></strong><span id="verifyLine"></span></div>'
    + '<button type="button" class="primary" id="exportTimeline">Preparar montagem para DaVinci</button>'
    + '<button type="button" class="primary" id="confirmImport" hidden>Confirmar conferência</button></div>'
    + '<section class="delivery-files" id="deliveryFiles" aria-labelledby="filesTitle"><div class="files-head">'
    + '<h2 id="filesTitle" class="ttl">Montagem preparada para o DaVinci</h2><span id="filesPath" class="mono"></span></div>'
    + '<ul id="downloads" class="plain"></ul></section>'
    + '<div class="sub format-row"><span class="ttl">Formato</span><span id="formatLine" class="mono"></span><span id="formatOrigin"></span>'
    + '<button type="button" id="editFormat" class="small">Alterar formato</button></div>'
    + '<div class="resolve-paths"><section class="sub"><h2>Resolve gratuito</h2><ol class="plain resolve-steps">'
    + "<li>Baixe a timeline.otio.</li>"
    + '<li>No Resolve: <span class="mono">File → Import → Timeline</span>.</li>'
    + '<li><span class="mono">File → Export Project</span> salva o projeto nativo .drp.</li></ol></section>'
    + '<section class="sub"><h2>Resolve Studio <span class="pill">automático</span></h2>'
    + '<p class="muted">Requer o Resolve Studio aberto, com scripting local habilitado.</p>'
    + '<div class="row"><button type="button" id="export" class="small">Abrir no DaVinci</button>'
    + '<button type="button" id="exportDrp" class="small" hidden>Exportar .drp</button>'
    + '<button type="button" id="resolveNewCopy" class="small" hidden>Criar outra cópia</button></div></section></div>'
    + '<p id="exportStatus" role="status" aria-live="polite"></p>'
    + '<ul id="versionHistory" class="plain history"></ul>';
  delivery.hidden = true;
  document.getElementById("center").appendChild(delivery);

  // Controle de ritmo (#66): escolha do perfil é etapa anterior à
  // prévia/aprovação — a proposta compara pausas e oferece amostra
  // auditável do mesmo trecho antes e depois, sem chamada paga.
  const rhythm = document.createElement("details");
  rhythm.className = "sub rhythm";
  rhythm.innerHTML = '<summary><span class="ttl">Ritmo</span></summary>'
    + '<p class="muted" id="rhythmCurrent"></p><div class="row" id="rhythmChoices"></div>';
  root.replaceChildren(pending, scenePanel, rhythm, briefingActions);
  mountFillerContext({ state, api, player }, root);

  const rhythmDialog = document.createElement("dialog");
  rhythmDialog.id = "rhythmDialog";
  rhythmDialog.innerHTML = '<h1>Ritmo do corte</h1>'
    + '<p class="muted" id="rhythmProfileDesc"></p>'
    + '<p id="rhythmSummary"></p>'
    + '<ul id="rhythmPauses" class="plain"></ul>'
    + '<p class="muted" id="rhythmUnaligned"></p>'
    + '<p class="warn" id="rhythmStale" hidden>Esta comparação é de uma versão anterior da montagem. Escolha o perfil de novo para comparar a versão atual.</p>'
    + '<div class="row"><label>Antes <video id="rhythmAntes" controls width="240" muted></video></label>'
    + '<label>Depois <video id="rhythmDepois" controls width="240" muted></video></label></div>'
    + '<div class="row"><button type="button" class="primary" id="acceptRhythm">Aplicar ritmo</button>'
    + '<button type="button" id="rejectRhythm">Rejeitar</button>'
    + '<button type="button" id="closeRhythm">Fechar</button></div>';
  document.body.appendChild(rhythmDialog);

  // Fechar (botão ou Esc) dispensa esta proposta: o poll seguinte não reabre.
  let dismissedRhythm = null;
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
    const view = rhythmDialogView(p, proposal, dismissedRhythm);
    if (!view.show) { if (rhythmDialog.open) rhythmDialog.close(); return; }
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
      const src = proposal.sample ? `/project/rhythm-sample/${proposal.id}/${which}` : "";
      // Mesmo src de novo recarregaria a amostra no meio da escuta.
      if ((el.getAttribute("src") || "") !== src) el.src = src;
      el.style.visibility = proposal.sample ? "visible" : "hidden";
    }
    document.getElementById("rhythmStale").hidden = !view.stale;
    document.getElementById("acceptRhythm").disabled = view.stale;
    if (view.autoOpen && !rhythmDialog.open) rhythmDialog.showModal();
  }
  rhythmDialog.addEventListener("close", () => {
    const proposal = state.get("rhythmProposal");
    if (proposal) dismissedRhythm = proposal.id;
  });
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

  function renderPending(project) {
    const items = pendingItems(project);
    const shown = items.length ? items : [{ tone: "ok", title: "Sem pendências", detail: "" }];
    document.getElementById("corrections").replaceChildren(...shown.map((item) => {
      const li = document.createElement("li");
      li.className = "pending-item";
      li.dataset.tone = item.tone;
      li.innerHTML = (item.tone === "ok" ? ICON.ok : item.tone === "running" ? ICON.spinner : ICON.alert)
        + "<div><strong></strong> <span></span></div>";
      li.querySelector("strong").textContent = item.title;
      li.querySelector("span").textContent = item.detail;
      return li;
    }));
  }

  function renderDelivery(project) {
    // Checklist derivado do estado real: atualiza a cada render de projeto.
    const checklist = document.getElementById("deliveryChecklist");
    checklist.replaceChildren(...deliveryChecklist(project).map((item) => {
      const li = document.createElement("li");
      li.className = "pill" + (item.done ? " done" : "");
      li.innerHTML = item.done ? ICON.check : ICON.circle;
      li.append(item.label);
      return li;
    }));
    // Export de outra revisão não conta: edição nova volta ao ocioso.
    if (exportUi.status === "done" && exportUi.revision !== project.revision) {
      exportUi.status = "idle";
      exportUi.error = null;
      exportUi.revision = null;
    }
    // Cadeado da entrega (Task 9): só libera depois de assistir e aprovar —
    // o servidor também recusa export sem aprovação (exportApproved).
    const approved = project.finalApprovedRevision === project.revision;
    const lock = document.getElementById("deliveryLock");
    lock.textContent = approved
      ? "A entrega vale para a v" + project.revision + ". Se você editar de novo, ela volta a ficar bloqueada até a nova prévia ser assistida e aprovada."
      : "Assista à prévia atual até o fim e aprove para liberar a entrega.";
    const badge = document.getElementById("deliveryBadge");
    badge.className = "pill" + (approved ? " pill-ok" : "");
    badge.innerHTML = (approved ? ICON.check : ICON.lock) + "v" + project.revision + (approved ? " aprovada" : " não aprovada");
    document.getElementById("formatLine").textContent = formatLabel(project.assembly);
    document.getElementById("formatOrigin").textContent = formatOrigin(project.assembly);
    // Estado da conferência: exportar nunca confirma; revisão nova
    // não herda a confirmação (verificacao.json é por revisão).
    const verificacao = state.get("verificacao");
    const verify = verifyView(project, verificacao);
    const card = document.getElementById("verifyCard");
    card.dataset.state = verify.state;
    document.getElementById("verifyIcon").innerHTML = verify.state === "done" ? ICON.ok : verify.state === "locked" ? ICON.lock : ICON.alert;
    document.getElementById("verifyTitle").textContent = verify.title;
    document.getElementById("verifyLine").textContent = verify.detail;
    document.getElementById("confirmImport").hidden = !verify.showConfirm;
    document.getElementById("exportTimeline").hidden = !verify.showExport;
    const formats = deliveryFormats(project, verificacao);
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
    const parts = [nativeView.statusText || view.statusText];
    if (resolveDelivery) parts.push("O .drp depende dos arquivos de mídia originais.");
    exportStatus.textContent = parts.filter(Boolean).join(" · ");
    exportStatus.className = "export-" + view.tone;
    const downloads = document.getElementById("downloads");
    const addFile = (file, label, href) => {
      const li = document.createElement("li");
      li.className = "file";
      li.innerHTML = ICON.file + '<span class="mono file-name"></span><span class="file-desc"></span>';
      li.querySelector(".file-name").textContent = file;
      li.querySelector(".file-desc").textContent = label;
      const link = document.createElement("a");
      link.className = "button";
      link.href = href;
      link.download = file;
      link.textContent = "Baixar";
      link.setAttribute("aria-label", "Baixar " + file);
      li.append(link);
      downloads.append(li);
    };
    downloads.replaceChildren();
    for (const f of formats) addFile(f.file, f.label, f.href);
    if (resolveDelivery?.drpPath) addFile("projeto.drp", "Projeto nativo do DaVinci", "/project/resolve-drp");
    document.getElementById("deliveryFiles").hidden = downloads.childElementCount === 0;
    document.getElementById("filesPath").textContent = formats.length ? "exports/" + project.finalApprovedRevision + "/" : "";
    const history = document.getElementById("versionHistory");
    history.replaceChildren(
      chip("versão " + project.revision),
      chip(project.previewRevision != null ? "prévia " + project.previewRevision : "sem prévia"),
      chip(project.finalApprovedRevision != null ? "aprovada " + project.finalApprovedRevision : "não aprovada"),
      chip("formato " + formatLabel(project.assembly)),
    );
  }

  function render(project) {
    if (!project) return;
    const operation = state.get("operation");
    renderPending(project);
    const sections = inspectorSections(project);
    renderScene(project);
    document.getElementById("inspectorState").textContent =
      (sections.hasPreview ? "prévia v" + project.previewRevision : "sem prévia")
      + (sections.approved ? " · aprovada" : "");
    const preparing = project.preparation
      && project.preparation.status === "running";
    document.getElementById("cancelPrep").hidden = !(
      preparing || (operation && operation.stage === "preparing")
    );
    paintAdjust(project);
    renderDelivery(project);
  }

  // Ajustar dispara trabalho longo no servidor: evita o segundo clique
  // parecer travado (o servidor cancelaria o anterior).
  function paintAdjust(project) {
    const button = document.getElementById("adjust");
    const view = adjustButtonView(requestAdjust.busy(),
      backgroundBusy(project, state.get("operation"), player), project.scenes.length > 0);
    setDisabled(button, view.disabled);
    button.setAttribute("aria-label", view.label);
    button.title = view.label;
    button.setAttribute("aria-busy", String(view.busy));
  }

  document.getElementById("cancelPrep").onclick = () => api.call(
    "/project/cancel",
    { method: "POST", body: "{}", label: "Cancelando…" },
  );
  const requestAdjust = adjustAction({
    state, api,
    readRequest: () => document.getElementById("request").value,
    onChange: () => { if (state.get("project")) paintAdjust(state.get("project")); },
  });
  document.getElementById("adjust").onclick = () => requestAdjust();
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
  // Confirmar a conferência devolve o mesmo projeto: só a verificação muda.
  state.subscribe("verificacao", () => { if (state.get("project")) renderDelivery(state.get("project")); });
  render(state.get("project"));
}

export function decisionSummary(report) {
  if (!report) return "Decisão não registrada";
  const applied = report.cuts.filter(c => c.applied).length;
  const mode = report.mode === "observe" ? " · observação, sem aplicar" : "";
  const status = report.status === "fallback" ? "Falha na decisão; trechos afetados preservados" : report.status === "not-run" ? "Sem decisão Jev" : "Decisão Jev concluída";
  return `${status}${mode} · ${report.model || "sem modelo"} · ${(report.elapsedMs / 1000).toFixed(1)} s · ${applied} cortes aplicados, ${report.cuts.length - applied} mantidos${report.reason ? " · " + report.reason : ""}`;
}
