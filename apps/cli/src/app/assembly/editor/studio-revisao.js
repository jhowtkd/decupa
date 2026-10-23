// Painel da Revisão (studio): cinco blocos separados no palco, logo abaixo do
// cartão de aprovação, que continua sendo o único lugar de aprovar. Só lê o
// estado (o rastreio da reprodução mora em cobertura.js e publica "watched" e
// "watchCoverage") e a revisão que o player está mostrando; nunca toca no
// player nem chama a API. O CSS só o mostra na etapa Revisão.
import { deliveryItems } from "./rail.js";
import { watchedState } from "./watched.js";

const v = (revision) => "v" + revision;

/** "a, b e c" (pt-BR). */
function lista(nomes) {
  return nomes.length < 2 ? nomes.join("") : nomes.slice(0, -1).join(", ") + " e " + nomes.at(-1);
}

/**
 * Os cinco dados da revisão, cada um com a revisão a que corresponde (puro):
 * a versão atual da montagem, a prévia que o player mostra, a cobertura dessa
 * prévia nesta sessão, a versão aprovada e os arquivos de entrega.
 * `exibida` é o que está no player: `revisao` (data-rev) ou `original` (nome
 * da Mídia, no modo Original). `gerando`: uma prévia está sendo renderizada.
 * @param {{ project: any, watched?: any, coverage?: any, verificacao?: any,
 *   exibida?: { revisao: number | null, original: string | null }, gerando?: boolean }} input
 * @returns {Array<{ id: string, titulo: string, valor: string, detalhe: string, tom: "" | "ok" | "aviso" }>}
 */
export function blocosDaRevisao({ project, watched = null, coverage = null, verificacao = null,
  exibida = { revisao: null, original: null }, gerando = false }) {
  if (!project) return [];
  const atual = project.revision;
  const status = watchedState(project, watched);
  const aprovada = project.finalApprovedRevision != null && project.finalApprovedRevision === atual;
  const semPrevia = gerando ? "A prévia da " + v(atual) + " está sendo gerada." : "A " + v(atual) + " ainda não tem prévia.";

  const montagem = { id: "montagem", titulo: "Montagem", valor: v(atual), detalhe: "Versão atual: é ela que vai para a entrega.", tom: "" };

  let previa;
  if (exibida.original != null) {
    previa = { valor: "Original", detalhe: exibida.original + " · o player mostra o original, não a prévia da montagem.", tom: "aviso" };
  } else if (exibida.revisao == null) {
    previa = { valor: "Nenhuma", detalhe: semPrevia, tom: "aviso" };
  } else if (exibida.revisao === atual && project.previewRevision === atual) {
    previa = { valor: v(atual), detalhe: "Prévia da versão atual.", tom: "ok" };
  } else {
    previa = { valor: v(exibida.revisao), detalhe: "Prévia anterior: não vale para a " + v(atual) + ". " + semPrevia, tom: "aviso" };
  }

  // A cobertura é da prévia que está no player, e só desta sessão.
  const medida = exibida.original == null && exibida.revisao != null && coverage?.revision === exibida.revisao ? coverage : null;
  let cobertura;
  if (exibida.original != null) {
    cobertura = { valor: "—", detalhe: "O original não conta: só a prévia é medida, nesta sessão.", tom: "" };
  } else if (!medida) {
    cobertura = { valor: "—", detalhe: "Nenhuma prévia tocada nesta sessão.", tom: "" };
  } else {
    const assistida = status.watched && medida.revision === project.previewRevision;
    const pct = Math.round((assistida ? 1 : medida.ratio) * 100) + "%";
    const visto = assistida ? "vista até o fim" : medida.label || "nada assistido";
    cobertura = medida.revision === atual
      ? { valor: pct, detalhe: v(medida.revision) + " · " + visto + " nesta sessão. Avançar não conta; voltar recomeça.", tom: assistida ? "ok" : "" }
      : { valor: pct, detalhe: v(medida.revision) + " · " + visto + " nesta sessão; não conta para a " + v(atual) + ".", tom: "aviso" };
  }

  let aprovacao;
  if (aprovada) {
    aprovacao = { valor: v(atual), detalhe: "A versão atual está aprovada.", tom: "ok" };
  } else if (project.finalApprovedRevision != null) {
    aprovacao = { valor: v(project.finalApprovedRevision), detalhe: "Não vale para a " + v(atual) + ": aprove a prévia atual.", tom: "aviso" };
  } else {
    aprovacao = { valor: "Nenhuma", detalhe: status.canApprove ? "Aprove a prévia da " + v(atual) + " no cartão acima." : "Aprovar pede a prévia da " + v(atual) + ".", tom: "" };
  }

  const itens = deliveryItems(project, verificacao);
  const prontos = itens.filter((item) => item.state === "disponivel");
  const faltam = itens.filter((item) => item.state === "indisponivel");
  let entrega;
  if (!aprovada) {
    entrega = { valor: "Nenhum", detalhe: "Liberados ao aprovar a prévia da " + v(atual) + ".", tom: "" };
  } else if (!prontos.length) {
    entrega = { valor: "A preparar", detalhe: v(atual) + " aprovada: prepare os arquivos na Entrega.", tom: "" };
  } else {
    const nomes = prontos.map((item, i) => i === 0 ? item.title : item.title.toLowerCase());
    // Concorda com o que falta: "legendas indisponíveis" (plural) ou "vídeo indisponível".
    const plural = faltam.length > 1 || faltam.some((item) => item.id === "legendas");
    entrega = {
      valor: v(atual),
      detalhe: lista(nomes) + (faltam.length
        ? "; " + lista(faltam.map((item) => item.title.toLowerCase())) + (plural ? " indisponíveis" : " indisponível")
        : "") + ".",
      tom: "ok",
    };
  }

  return [
    montagem,
    { id: "previa", titulo: "Prévia exibida", ...previa },
    { id: "cobertura", titulo: "Cobertura assistida", ...cobertura },
    { id: "aprovada", titulo: "Aprovada", ...aprovacao },
    { id: "entrega", titulo: "Arquivos para entrega", ...entrega },
  ];
}

/**
 * Monta o painel dentro do #stage, depois do cartão de revisão. `player.el()`
 * é o <video> único: daqui só se lê a revisão que ele mostra. Fora da etapa
 * Revisão o painel está escondido e não recalcula (a cobertura muda a cada
 * timeupdate); entrar na Revisão repinta com o estado de agora.
 */
export function mountRevisao({ state, player }) {
  const stage = document.getElementById("stage");
  if (!stage) return;
  const painel = document.createElement("section");
  painel.id = "revisaoPainel";
  painel.className = "revisao-painel";
  painel.setAttribute("aria-label", "Estado da revisão");
  const dados = document.createElement("dl");
  dados.className = "revisao-dados";
  painel.append(dados);
  stage.append(painel);

  function paint() {
    if (state.get("stage") !== "revisao") return;
    const project = state.get("project");
    painel.hidden = !project?.scenes?.length;
    if (painel.hidden) return;
    const video = player.el();
    const original = state.get("view") === "original";
    const source = original ? project.assembly.sources.find((item) => item.id === video?.dataset.source) : null;
    const rev = video?.getAttribute("data-rev");
    const blocos = blocosDaRevisao({
      project,
      watched: state.get("watched"),
      coverage: state.get("watchCoverage"),
      verificacao: state.get("verificacao"),
      exibida: { revisao: original || rev == null ? null : Number(rev), original: original ? source?.name || "Mídia" : null },
      gerando: state.get("previewBusy") === true || state.get("operation")?.stage === "rendering",
    });
    dados.replaceChildren(...blocos.map((bloco) => {
      const item = document.createElement("div");
      item.className = "revisao-bloco";
      item.dataset.bloco = bloco.id;
      if (bloco.tom) item.dataset.tom = bloco.tom;
      const titulo = document.createElement("dt");
      titulo.textContent = bloco.titulo;
      const valor = document.createElement("dd");
      valor.className = "revisao-valor mono";
      valor.textContent = bloco.valor;
      const detalhe = document.createElement("dd");
      detalhe.className = "revisao-detalhe";
      detalhe.textContent = bloco.detalhe;
      item.append(titulo, valor, detalhe);
      return item;
    }));
  }
  for (const key of ["stage", "project", "watched", "watchCoverage", "verificacao", "view", "previewBusy", "operation"]) {
    state.subscribe(key, paint);
  }
  paint();
}
