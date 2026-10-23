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

/** Chave da preferência local: etapa por projeto, escolha de cada painel e zoom da sequência. */
export const PREFERENCIA = "decupa.studio.bancada.v1";
const MAX_PROJETOS = 30;
const ESCOLHAS = new Set(["fixo", "recolhido"]);
/** Os mesmos níveis de ZOOMS (sequencia.js); fora deles a faixa abre em 1×. */
const ZOOMS = new Set([1, 2, 4, 8]);

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
  const zoom = ZOOMS.has(data?.zoom) ? data.zoom : undefined;
  return { etapas, paineis, zoom };
}

/**
 * Grava uma mudança só: a etapa de um projeto (`{ projeto, etapa }`), a
 * escolha de um painel (`{ painel, escolha }`) ou o zoom da sequência
 * (`{ zoom }`). Relê o storage antes, então outra aba que gravou outro
 * projeto ou outro painel não é apagada. Falha do storage (cota, modo
 * privado) não chega à bancada.
 */
export function writePreferencia(storage, mudanca) {
  const { etapas, paineis, zoom } = readPreferencia(storage);
  if (mudanca.projeto !== undefined) {
    etapas.delete(mudanca.projeto);
    etapas.set(mudanca.projeto, mudanca.etapa);
  }
  if (mudanca.painel !== undefined) paineis[mudanca.painel] = mudanca.escolha;
  const proximoZoom = mudanca.zoom !== undefined && ZOOMS.has(mudanca.zoom) ? mudanca.zoom : zoom;
  const recentes = [...etapas].slice(-MAX_PROJETOS);
  try {
    storage?.setItem(PREFERENCIA, JSON.stringify({
      etapas: Object.fromEntries(recentes), paineis, ...(proximoZoom !== undefined ? { zoom: proximoZoom } : {}),
    }));
  } catch {
    // Sem storage a bancada segue; só não lembra na próxima visita.
  }
}

/** Projeto carregado sem nenhuma Mídia (o estado vazio do page.js); null ainda não se sabe. */
function semMaterial(project) {
  return project != null && (project.assembly?.sources?.length ?? 0) === 0;
}

/**
 * Etapa de quem abre o projeto sem preferência gravada, ou sem material
 * (pura): sem material ou sem cena fica em Materiais, onde estão a
 * importação e a preparação; com cena, Edição, ou Entrega quando a versão
 * atual já está aprovada (a mesma trava do stepper).
 */
export function etapaDerivada(project) {
  if (semMaterial(project) || !project?.scenes?.length) return "materiais";
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
  // Até a primeira resposta do projeto, se a pessoa não navegou: sem etapa
  // gravada, ela decide; com etapa gravada, projeto sem material volta a
  // Materiais (o vazio vence). `decidir` também segura a gravação até lá.
  let primeira = true;
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

  /**
   * A entrega toma o lugar do texto no cartão central, como na legacy. Sem
   * material o guia de importar (que mora no #texto) vence a etapa.
   */
  function placeEntrega() {
    const entrega = etapa === "entrega" && !semMaterial(state.get("project"));
    document.getElementById("texto").hidden = entrega;
    document.getElementById("textoHead").hidden = entrega;
    const delivery = document.getElementById("delivery");
    if (delivery) delivery.hidden = !entrega;
  }

  function show(next) {
    if (!STAGE_IDS.has(next)) return;
    // A gaveta não atravessa etapas; navegar antes da primeira resposta vence a decisão.
    if (next !== etapa) {
      aberto = null;
      if (etapa !== null) primeira = decidir = false;
    }
    etapa = next;
    body.dataset.stage = next;
    for (const tab of tabs) {
      const on = tab.dataset.stage === next;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      if (on) document.getElementById("bancada")?.setAttribute("aria-labelledby", tab.id);
    }
    placeEntrega();
    render();
    paintStages();
    if (!decidir) writePreferencia(storage, { projeto, etapa: next });
  }

  function alternar(nome) {
    const atual = estado(nome);
    if (atual === null) return;
    if (fixavel(nome)) {
      // Com largura para fixar, o botão fixa ou recolhe, e a escolha fica gravada.
      preferencia.paineis[nome] = atual === "fixo" ? "recolhido" : "fixo";
      aberto = null;
      writePreferencia(storage, { painel: nome, escolha: preferencia.paineis[nome] });
      render();
      return;
    }
    // Sem largura, o painel abre como gaveta (uma por vez) e recebe o foco.
    aberto = atual === "aberto" ? null : nome;
    render();
    if (aberto === nome) document.getElementById(nome)?.focus();
  }

  for (const nome of Object.keys(PAINEIS)) {
    toggle(nome)?.addEventListener("click", () => alternar(nome));
    // A gaveta não tem fundo: o foco que sai dela (Tab, clique em controle)
    // fecha, senão ele cairia em controles cobertos. Para o próprio botão,
    // quem fecha é o clique; empilhado, o painel está no fluxo e fica.
    const painel = document.getElementById(nome);
    painel?.addEventListener("focusout", (event) => {
      const destino = event.relatedTarget;
      if (aberto !== nome || !destino || painel.contains(destino) || destino === toggle(nome)) return;
      if (globalThis.getComputedStyle?.(painel).position === "static") return;
      aberto = null;
      render();
    });
  }
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
  // Zoom da sequência: preferência local da pessoa, não do projeto.
  if (preferencia.zoom !== undefined) state.set("zoomSequencia", preferencia.zoom);
  state.subscribe("zoomSequencia", (zoom) => writePreferencia(storage, { zoom }));
  state.subscribe("project", (project) => {
    // Ganhar ou perder todo o material muda quem ocupa o cartão central.
    placeEntrega();
    if (!primeira || !project) return;
    // Depois do set("project") terminar: o state.js ainda compara a etapa que
    // leu antes do aviso, e a troca de etapa dele (transcrição chegando) vence.
    queueMicrotask(() => {
      if (!primeira) return;
      primeira = false;
      const atual = state.get("project");
      if (!decidir && !semMaterial(atual)) return;
      decidir = false;
      setStage(etapaDerivada(atual));
    });
  });

  return { show, initialStage: gravada ?? "materiais" };
}
