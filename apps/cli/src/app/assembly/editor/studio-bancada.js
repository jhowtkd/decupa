// Bancada do studio (DECUPA_EDITOR_UI=studio): cada etapa é uma vista sobre
// as mesmas regiões. Trocar de etapa só muda atributos (body[data-stage],
// [data-rail], [data-inspector]) que o studio.css lê; nenhum nó sai do lugar,
// então o <video id="previewPlayer"> segue tocando de onde estava. Nada aqui
// chama a API: navegar e abrir painel nunca processam nem cobram.
import { STAGES, stepperState } from "./topbar.js";

const STAGE_IDS = new Set(STAGES.map((stage) => stage.id));

/**
 * Painéis auxiliares: em que etapas existem, a partir de que largura cabem
 * fixos sem espremer texto e vídeo (por etapa), e como começam sem escolha
 * gravada. Em Materiais o rail é o conteúdo da etapa, não painel; em Edição
 * ele começa recolhido para a transcrição ficar na borda esquerda. Na
 * Revisão não há texto ao lado, então as pendências cabem fixas mais cedo.
 */
export const PAINEIS = {
  rail: { fixa: { edicao: "(min-width: 1100px)" }, padrao: "recolhido" },
  inspector: { fixa: { edicao: "(min-width: 1400px)", revisao: "(min-width: 1024px)" }, padrao: "fixo" },
};

/** Chave da preferência local: etapa por projeto e escolha de cada painel. */
export const PREFERENCIA = "decupa.studio.bancada.v1";
const MAX_PROJETOS = 30;
const ESCOLHAS = new Set(["fixo", "recolhido"]);

/** Preferência local (pura sobre o storage): ausente, ilegível ou corrompida vira o padrão. */
export function readPreferencia(storage) {
  let data = null;
  try {
    const raw = storage?.getItem(PREFERENCIA);
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }
  const etapas = new Map();
  if (data?.etapas && typeof data.etapas === "object" && !Array.isArray(data.etapas)) {
    for (const [projeto, etapa] of Object.entries(data.etapas)) {
      if (STAGE_IDS.has(etapa)) etapas.set(projeto, etapa);
    }
  }
  const paineis = {};
  for (const nome of Object.keys(PAINEIS)) {
    const escolha = data?.paineis?.[nome];
    if (ESCOLHAS.has(escolha)) paineis[nome] = escolha;
  }
  return { etapas, paineis };
}

/** Grava sem deixar a falha do storage (cota, modo privado) chegar à bancada. */
export function writePreferencia(storage, { etapas, paineis }) {
  const recentes = [...etapas].slice(-MAX_PROJETOS);
  try {
    storage?.setItem(PREFERENCIA, JSON.stringify({ etapas: Object.fromEntries(recentes), paineis }));
  } catch {
    // Sem storage a bancada segue; só não lembra na próxima visita.
  }
}

/**
 * Etapa de quem abre o projeto sem preferência gravada (pura): sem cena fica
 * em Materiais, onde está a preparação; com cena, Edição, ou Entrega quando a
 * versão atual já está aprovada (a mesma trava do stepper).
 */
export function etapaDerivada(project) {
  if (!project?.scenes?.length) return "materiais";
  return stepperState(project, null).find((item) => item.id === "entrega").locked ? "edicao" : "entrega";
}

/**
 * `fixo` | `recolhido` | `aberto` (gaveta), ou null quando o painel não existe
 * na etapa. Com largura para fixar não há gaveta: vale a escolha gravada.
 */
export function estadoPainel(nome, etapa, { fixavel, escolha, aberto }) {
  const painel = PAINEIS[nome];
  if (!Object.hasOwn(painel.fixa, etapa)) return null;
  if (fixavel) return (escolha ?? painel.padrao) === "fixo" ? "fixo" : "recolhido";
  return aberto === nome ? "aberto" : "recolhido";
}

/** Tablist por teclado (puro): setas circulam, Home/End vão às pontas. */
export function abaPorTecla(atual, key) {
  const ids = STAGES.map((stage) => stage.id);
  const index = ids.indexOf(atual);
  if (key === "Home") return ids[0];
  if (key === "End") return ids[ids.length - 1];
  if (index < 0) return null;
  if (key === "ArrowRight") return ids[(index + 1) % ids.length];
  if (key === "ArrowLeft") return ids[(index - 1 + ids.length) % ids.length];
  return null;
}

function localStore() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function projetoAtual() {
  return document.querySelector('meta[name="decupa-project-dir"]')?.getAttribute("content")
    || globalThis.location?.pathname || "";
}

/**
 * Liga tabs, painéis e preferência. `setStage` e `paintStages` são do
 * bootstrap (page.js): a etapa continua sendo a chave "stage" do estado.
 * Devolve `show` (assina "stage") e a etapa de partida.
 */
export function mountBancada({
  state, setStage, paintStages,
  storage = localStore(),
  media = (query) => globalThis.matchMedia?.(query) ?? { matches: false },
  projeto = projetoAtual(),
}) {
  const body = document.body;
  const tabs = [...document.querySelectorAll("#stages [data-stage]")];
  const preferencia = readPreferencia(storage);
  // Uma consulta por painel e etapa: `fixaveis.inspector.revisao.matches`.
  const fixaveis = {};
  for (const [nome, painel] of Object.entries(PAINEIS)) {
    fixaveis[nome] = {};
    for (const [etapaDoPainel, query] of Object.entries(painel.fixa)) {
      fixaveis[nome][etapaDoPainel] = media(query);
      fixaveis[nome][etapaDoPainel].addEventListener?.("change", () => render());
    }
  }
  const fixavel = (nome) => fixaveis[nome][etapa]?.matches === true;
  const gravada = preferencia.etapas.get(projeto);
  // Sem etapa gravada, a primeira resposta do projeto decide (uma vez).
  let decidir = gravada === undefined;
  let etapa = null;
  let aberto = null;

  const toggle = (nome) => document.querySelector('[data-painel="' + nome + '"]');
  const estado = (nome) => estadoPainel(nome, etapa, {
    fixavel: fixavel(nome), escolha: preferencia.paineis[nome], aberto,
  });

  function render() {
    // A gaveta que a largura fechou não reabre sozinha quando a tela estreita de novo.
    if (aberto && estado(aberto) !== "aberto") aberto = null;
    for (const nome of Object.keys(PAINEIS)) {
      const atual = estado(nome);
      const button = toggle(nome);
      if (atual) body.dataset[nome] = atual;
      else delete body.dataset[nome];
      if (!button) continue;
      button.hidden = atual === null;
      button.setAttribute("aria-expanded", String(atual === "fixo" || atual === "aberto"));
      // Painel que recolheu com o foco dentro devolve o foco ao botão.
      if (atual === "recolhido" && document.getElementById(nome)?.contains(document.activeElement)) button.focus();
    }
  }

  function show(next) {
    if (!STAGE_IDS.has(next)) return;
    // A gaveta não atravessa etapas; navegar antes da primeira resposta vence a decisão.
    if (next !== etapa) {
      aberto = null;
      if (etapa !== null) decidir = false;
    }
    etapa = next;
    body.dataset.stage = next;
    for (const tab of tabs) {
      const on = tab.dataset.stage === next;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      if (on) document.getElementById("bancada")?.setAttribute("aria-labelledby", tab.id);
    }
    // A entrega toma o lugar do texto no cartão central, como na legacy.
    const entrega = next === "entrega";
    document.getElementById("texto").hidden = entrega;
    document.getElementById("textoHead").hidden = entrega;
    const delivery = document.getElementById("delivery");
    if (delivery) delivery.hidden = !entrega;
    render();
    paintStages();
    if (!decidir) {
      preferencia.etapas.delete(projeto);
      preferencia.etapas.set(projeto, next);
      writePreferencia(storage, preferencia);
    }
  }

  function alternar(nome) {
    const atual = estado(nome);
    if (atual === null) return;
    if (fixavel(nome)) {
      // Com largura para fixar, o botão fixa ou recolhe, e a escolha fica gravada.
      preferencia.paineis[nome] = atual === "fixo" ? "recolhido" : "fixo";
      aberto = null;
      writePreferencia(storage, preferencia);
      render();
      return;
    }
    // Sem largura, o painel abre como gaveta (uma por vez) e recebe o foco.
    aberto = atual === "aberto" ? null : nome;
    render();
    if (aberto === nome) document.getElementById(nome)?.focus();
  }

  for (const nome of Object.keys(PAINEIS)) toggle(nome)?.addEventListener("click", () => alternar(nome));
  document.getElementById("stages")?.addEventListener("keydown", (event) => {
    const tab = tabs.find((item) => item.contains(event.target));
    const next = tab ? abaPorTecla(tab.dataset.stage, event.key) : null;
    if (!next) return;
    event.preventDefault();
    tabs.find((item) => item.dataset.stage === next)?.focus();
    setStage(next);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !aberto || event.defaultPrevented || document.querySelector("dialog[open]")) return;
    event.preventDefault();
    aberto = null;
    render();
  });
  state.subscribe("project", (project) => {
    if (!decidir || !project) return;
    // Depois do set("project") terminar: o state.js ainda compara a etapa que
    // leu antes do aviso, e a troca de etapa dele (transcrição chegando) vence.
    queueMicrotask(() => {
      if (!decidir) return;
      decidir = false;
      setStage(etapaDerivada(state.get("project")));
    });
  });

  return { show, initialStage: gravada ?? "materiais" };
}
