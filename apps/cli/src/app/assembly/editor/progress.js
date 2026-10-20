// Aprovação da prévia (pura, só exibição): quanto da prévia atual foi tocado
// de fato (a cobertura de playback.js) e o que o cartão de revisão diz. O gate
// de verdade continua em watchedState (watched.js) e no servidor.
import { clock } from "./format.js";
import { idleStatus } from "./topbar.js";
import { watchedState } from "./watched.js";

/** Teto do anel enquanto o gate não libera: 100% só com status.watched. */
const UNWATCHED_MAX = 0.99;

/**
 * Anel e texto a partir dos segundos cobertos (não da posição mais distante:
 * um seek para a frente não conta). O trecho coberto pode não começar no zero,
 * então o texto diz quanto foi visto, não "até onde".
 */
export function watchProgress(covered, duration, watched) {
  if (watched) return { ratio: 1, label: "vista até o fim" };
  if (!Number.isFinite(duration) || !(duration > 0)) return { ratio: 0, label: "" };
  const seen = Math.min(Math.max(Number.isFinite(covered) ? covered : 0, 0), duration);
  const ratio = Math.min(seen / duration, UNWATCHED_MAX);
  // "1:13 de 1:13" leria como vista inteira: sem o gate, falta um trecho.
  if (clock(seen) === clock(duration)) return { ratio, label: "falta assistir um trecho" };
  return { ratio, label: clock(seen) + " de " + clock(duration) + " vistos" };
}

export function reviewView(project, status, progress) {
  if (!project || !project.scenes.length) return { visible: false, title: "", detail: "", ratio: 0 };
  if (project.previewRevision == null) {
    return { visible: true, title: "A prévia ainda não está pronta", detail: "Ela aparece aqui quando o render terminar.", ratio: 0 };
  }
  const v = "v" + project.previewRevision;
  if (project.finalApprovedRevision != null && project.finalApprovedRevision === project.revision) {
    // A aprovação persiste no servidor; a cobertura só comprova o que foi
    // reproduzido nesta sessão. Aprovar por exceção não preenche o anel.
    const complete = status.fresh && status.watched;
    return {
      visible: true, title: "Prévia aprovada",
      detail: v + (complete ? " · assistida até o fim" : " · cobertura: " + (status.fresh && progress.label || "não confirmada nesta sessão")),
      ratio: complete ? 1 : status.fresh ? Math.min(progress.ratio, UNWATCHED_MAX) : 0,
    };
  }
  if (!status.fresh) {
    return { visible: true, title: "Prévia desatualizada", detail: "Prévia " + v + " · a versão atual é v" + project.revision, ratio: 0 };
  }
  if (status.watched) return { visible: true, title: "Pronta para aprovar", detail: "Prévia " + v + " · vista até o fim", ratio: 1 };
  return {
    visible: true, title: "Pronta para aprovar",
    detail: "Prévia " + v + (progress.label ? " · " + progress.label : "") + " · voltar reinicia a contagem",
    ratio: progress.ratio,
  };
}

/**
 * Botão de aprovar (puro). Com a versão atual já aprovada no servidor, diz
 * "Aprovada" sem cadeado (o assistido zera no reload, a aprovação não).
 * Senão segue o gate canApprove de watchedState, e trava no Original.
 */
export function approveButtonView(project, status, original) {
  const approved = project != null && project.finalApprovedRevision != null
    && project.finalApprovedRevision === project.revision;
  if (approved) return { label: "Aprovada", disabled: true, locked: false, icon: "check", approved: true };
  const locked = !status.canApprove || original;
  return { label: "Aprovar prévia", disabled: locked, locked, icon: locked ? "lock" : "check", approved: false };
}

const OP_STAGES = {
  queued: "Aguardando na fila", analyzing: "Analisando mídia",
  preparing: "Preparando montagem", rendering: "Renderizando prévia", proposing: "Propondo cenas",
};
const PREP_STAGES = {
  media: "Verificar arquivos", audio: "Transcrever áudio", visual: "Analisar imagens",
  proposal: "Montar cenas", preview: "Renderizar prévia",
};

/**
 * Projeção independente dos seis estados; nenhum resultado implica aprovação ou cobertura.
 * @param {{project?: object|null, operation?: object|null, ui?: object,
 * watched?: object|null, coverage?: object|null, previewInflight?: boolean, previewPending?: boolean}} input
 */
export function activityView({ project = null, operation = null, ui = {}, watched = null, coverage = null,
  previewInflight = false, previewPending = false } = {}) {
  const prep = project?.preparation;
  const sources = project?.assembly?.sources || [];
  const relevant = sources.filter((source) => source.included);
  const failed = relevant.filter((source) => prep?.sources?.[source.id]?.error);
  const active = relevant.find((source) => Object.values(prep?.sources?.[source.id] || {}).includes("running"));
  const source = sources.find((item) => item.id === operation?.sourceId) || active || failed[0];
  const queued = operation?.stage === "queued";
  const cancelled = prep?.status === "cancelled";
  const interrupted = ["interrupted", "attention"].includes(prep?.status);
  const running = !queued && (prep?.status === "running" || !!OP_STAGES[operation?.stage] || previewInflight);
  // A etapa guardada numa preparação concluída é histórica. A operação
  // corrente (por exemplo, uma nova análise) é que nomeia a execução.
  const prepStage = prep?.status === "running" || interrupted || cancelled ? PREP_STAGES[prep?.stage] : null;
  const currentStage = operation?.stage === "preparing" ? prepStage || OP_STAGES.preparing
    : OP_STAGES[operation?.stage] || prepStage;
  const status = watchedState(project, watched);
  const approved = project?.finalApprovedRevision != null && project.finalApprovedRevision === project.revision;
  const currentCoverage = coverage?.revision === project?.previewRevision ? coverage : null;
  const coverageText = project?.previewRevision == null ? "Sem prévia para assistir"
    : status.watched ? "Prévia v" + project.previewRevision + " · vista até o fim"
    : "Prévia v" + project.previewRevision + " · " + (currentCoverage?.label || "cobertura não confirmada nesta sessão");
  const error = [...new Set([
    ui.error, ui.connection === "error" && ui.connectionError,
    operation?.stage === "error" ? operation.error || "Falha no processamento" : operation?.error, prep?.error,
    ...failed.map((item) => item.name + ": " + prep.sources[item.id].error),
    ...(project?.corrections || []).filter((item) => item.status === "error")
      .map((item) => (sources.find((entry) => entry.id === item.sourceId)?.name || item.sourceId) + ": " + item.error),
  ].filter(Boolean))].join("\n");
  const connection = ui.connection || (project ? "connected" : "connecting");
  const retryConnection = connection === "error";
  const stage = ui.error && ui.errorContext?.stage
    || currentStage || ui.label || "Sem etapa em execução";
  const media = ui.error && ui.errorContext?.media || source?.name || "Nenhuma mídia específica";
  const execution = queued ? "Aguardando início"
    : ui.label || (running ? currentStage || "Atualizando prévia" : null)
    || ((project?.corrections || []).some((item) => item.status === "pending") ? "Alinhando correção" : "Nenhuma etapa em execução");
  const result = cancelled ? "Preparação cancelada · etapas concluídas preservadas"
    : interrupted || operation?.stage === "error" ? "Processamento precisa de atenção"
    : project?.previewRevision != null ? "Prévia v" + project.previewRevision + (status.fresh ? " pronta" : " desatualizada")
    : "Sem prévia gerada";
  let recovery = "Confira o resultado antes de aprovar. A cobertura registra somente a reprodução desta sessão.";
  if (retryConnection) recovery = "Confira a conexão e se o Decupa está aberto. Tente a conexão novamente para atualizar o projeto; depois confira o resultado da última ação antes de repeti-la.";
  else if (cancelled || interrupted || failed.length) recovery = "Nos materiais, use Retomar preparação para concluir as etapas pendentes. As etapas concluídas ficam guardadas.";
  else if (operation?.stage === "error") recovery = "Confira a etapa e a mídia. Se a falha foi na prévia, use Atualizar prévia; na preparação, use Retomar preparação nos materiais.";
  else if (error) recovery = "Confira o detalhe e o estado atual do projeto; corrija a causa indicada e tente novamente a ação pelo seu controle.";
  const states = [
    { key: "connection", label: "Conexão", detail: retryConnection ? "Falha na conexão · estado recebido pode estar desatualizado" : connection === "connected" ? "Conectado · última consulta recebida" : "Conectando ao projeto" },
    { key: "queue", label: "Fila", detail: queued ? "Aguardando na fila" + (operation.progress ? " · " + operation.progress : "") : previewPending ? "Prévia agendada" : "Sem espera informada" },
    { key: "execution", label: "Execução", detail: execution + (!queued && operation?.progress ? " · " + operation.progress : "") },
    { key: "result", label: "Resultado", detail: result },
    { key: "approval", label: "Aprovação", detail: approved ? "v" + project.revision + " aprovada" : project?.finalApprovedRevision != null ? "v" + project.finalApprovedRevision + " aprovada · v" + project.revision + " ainda não aprovada" : "Versão atual não aprovada" },
    { key: "coverage", label: "Cobertura assistida", detail: coverageText },
  ];
  const idle = idleStatus(project);
  const busy = !!ui.label || queued || running || previewPending || execution === "Alinhando correção" || connection === "connecting";
  const text = retryConnection ? "Falha na conexão" : ui.error ? "Falha na solicitação"
    : cancelled ? "Preparação cancelada" : interrupted || error ? "Processamento com falha"
    : queued ? "Aguardando na fila" : running ? currentStage || "Atualizando prévia"
    : ui.label ? "Solicitação em andamento" : previewPending ? "Prévia agendada"
    : execution === "Alinhando correção" ? execution : ui.notice ? "Aviso do projeto" : idle.text;
  const tone = retryConnection || error && !cancelled || interrupted ? "error" : busy ? "" : idle.tone;
  const copyText = states.map((item) => item.label + ": " + item.detail).concat([
    "Etapa: " + stage, "Mídia: " + media, "Erro: " + (error || "Nenhum erro informado"),
    "Recuperação: " + recovery, ...(ui.notice ? ["Aviso: " + ui.notice] : []),
  ]).join("\n\n");
  return { text, busy: busy && !retryConnection && !ui.error, tone, states, stage, media, error, recovery, retryConnection, copyText, notice: ui.notice || "" };
}

/** Modal estável: atualizações de progresso não substituem controles nem movem o foco. */
export function mountActivity({ statusEl, retry }) {
  if (!statusEl) return { render() {} };
  const trigger = document.createElement("button");
  trigger.id = "viewActivity";
  trigger.type = "button";
  trigger.className = "quiet small";
  trigger.textContent = "Ver atividade";
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-controls", "activityDialog");
  trigger.setAttribute("aria-expanded", "false");
  // A Reserva mantém estes controles de leitura disponíveis, como seus próprios diálogos.
  trigger.setAttribute("data-edit-reservation-dialog", "");
  statusEl.parentElement.insertBefore(trigger, statusEl.nextSibling);
  const dialog = document.createElement("dialog");
  dialog.id = "activityDialog";
  dialog.setAttribute("data-edit-reservation-dialog", "");
  dialog.setAttribute("aria-labelledby", "activityTitle");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.style.maxHeight = "80vh";
  dialog.style.overflowY = "auto";
  dialog.style.overflowWrap = "anywhere";
  dialog.innerHTML = '<h1 id="activityTitle">Atividade do projeto</h1>'
    + '<p class="muted">Estado mais recente recebido. A aprovação e a cobertura são independentes.</p>'
    + '<dl id="activityStates"></dl><p><strong>Etapa: </strong><span id="activityStage"></span></p>'
    + '<p><strong>Mídia: </strong><span id="activityMedia"></span></p>'
    + '<p><strong>Erro: </strong><span id="activityError"></span></p>'
    + '<p><strong>Recuperação: </strong><span id="activityRecovery"></span></p>'
    + '<p id="activityNotice"></p>'
    + '<div class="row"><button type="button" id="retryConnection">Tentar conexão novamente</button>'
    + '<button type="button" id="copyActivity">Copiar detalhe</button>'
    + '<button type="button" id="closeActivity" class="quiet">Fechar</button></div>'
    + '<p id="activityCopyStatus" role="status"></p>'
    + '<textarea id="activityCopyText" aria-label="Detalhe para copiar" readonly hidden></textarea>';
  document.body.appendChild(dialog);
  const node = (id) => document.getElementById(id);
  const errorEl = node("activityError");
  errorEl.style.whiteSpace = "pre-wrap";
  const fields = new Map();
  for (const key of ["connection", "queue", "execution", "result", "approval", "coverage"]) {
    const title = document.createElement("dt");
    const detail = document.createElement("dd");
    node("activityStates").append(title, detail);
    fields.set(key, { title, detail });
  }
  const close = node("closeActivity");
  const retryButton = node("retryConnection");
  let current = null;
  let retrying = false;
  trigger.onclick = () => {
    if (!dialog.open) dialog.showModal();
    trigger.setAttribute("aria-expanded", "true");
    close.focus();
  };
  close.onclick = () => dialog.close();
  dialog.addEventListener("close", () => {
    trigger.setAttribute("aria-expanded", "false");
    trigger.focus();
  });
  retryButton.onclick = async () => {
    if (retrying || !current?.retryConnection) return;
    retrying = true;
    retryButton.disabled = true;
    try { await retry(); }
    catch { /* A consulta atualiza o erro no estado e continua retentável. */ }
    finally {
      retrying = false;
      retryButton.disabled = false;
      if (retryButton.hidden && dialog.open) close.focus();
    }
  };
  node("copyActivity").onclick = async () => {
    if (!current) return;
    const detail = current.copyText;
    const fallback = node("activityCopyText");
    try {
      await navigator.clipboard.writeText(detail);
      node("activityCopyStatus").textContent = "Detalhe copiado.";
      fallback.hidden = true;
    } catch {
      fallback.value = detail;
      fallback.hidden = false;
      fallback.style.width = "100%";
      fallback.rows = 8;
      fallback.focus();
      fallback.select();
      node("activityCopyStatus").textContent = "Selecione o detalhe abaixo e copie.";
    }
  };
  const paint = (el, value) => { if (el.textContent !== value) el.textContent = value; };
  return { render(view) {
    current = view;
    paint(statusEl, view.text);
    statusEl.dataset.tone = view.tone;
    statusEl.classList.toggle("busy", view.busy);
    if (view.busy) statusEl.setAttribute("aria-busy", "true");
    else statusEl.removeAttribute("aria-busy");
    for (const item of view.states) {
      const field = fields.get(item.key);
      paint(field.title, item.label);
      paint(field.detail, item.detail);
    }
    paint(node("activityStage"), view.stage);
    paint(node("activityMedia"), view.media);
    paint(errorEl, view.error || "Nenhum erro informado");
    paint(node("activityRecovery"), view.recovery);
    paint(node("activityNotice"), view.notice);
    if (!view.retryConnection && document.activeElement === retryButton && dialog.open) close.focus();
    retryButton.hidden = !view.retryConnection;
    retryButton.disabled = retrying;
  } };
}
