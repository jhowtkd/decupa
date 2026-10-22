// Busca no texto do studio (DECUPA_EDITOR_UI=studio): palavras e frases sobre
// o modelo editorial (cenas, takes e o material que ficou fora da montagem),
// nunca sobre o DOM, que a virtualização de texto.js monta só em parte.
// Abrir, digitar e navegar não chamam a API nem mexem na seleção: a lista vai
// pela chave "busca" do estado, e o texto destaca as ocorrências e revela a
// atual (monta a cena, abre a zona omitida e rola até a palavra).
import { ICON } from "./icons.js";
import { effectiveWords, normalizeRanges, takeWords } from "./montage.js";
import { selectionKey } from "./texto.js";

/** Texto comparável (puro): sem caixa, acento nem pontuação, com espaços simples. */
export function normalizarBusca(text) {
  return String(text ?? "").normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Trecho pesquisável: o texto comparável e, por palavra, onde começa, onde termina e a ocorrência. */
function novoTrecho(cena, tipo, fonte, sourceId) {
  return { cena, tipo, fonte, sourceId, inicio: Infinity, texto: "", de: [], ate: [], chaves: [] };
}

function acrescentar(trecho, chave, word) {
  const termo = normalizarBusca(word.display || word.text);
  if (!termo) return;
  if (trecho.texto) trecho.texto += " ";
  trecho.de.push(trecho.texto.length);
  trecho.texto += termo;
  trecho.ate.push(trecho.texto.length);
  trecho.chaves.push(chave);
  trecho.inicio = Math.min(trecho.inicio, word.start);
}

/** Cena cujo take da Mídia fica mais perto do intervalo; no empate, a primeira. */
function cenaMaisPerto(usos, start, end) {
  let melhor = 0;
  let distancia = Infinity;
  for (const uso of usos) {
    const d = Math.max(0, uso.start - end, start - uso.end);
    if (d < distancia) {
      melhor = uso.cena;
      distancia = d;
    }
  }
  return melhor;
}

function construirIndice(project) {
  const trechos = [];
  project.scenes.forEach((scene, cena) => {
    const trecho = novoTrecho(cena, 0, 0, null);
    for (const take of scene.takes) {
      for (const word of takeWords(project, scene, take)) acrescentar(trecho, selectionKey(scene.id, take.id, word.id), word);
    }
    trechos.push(trecho);
  });
  // Cada zona omitida lista a Mídia inteira menos a fala da própria cena, então
  // a mesma palavra aparece em toda zona. A busca conta uma vez só o que nenhum
  // take usa, na zona da cena mais perto no tempo, em sequências que param onde
  // um take começa (a frase não atravessa material usado).
  project.assembly.sources.forEach((source, fonte) => {
    const usos = [];
    project.scenes.forEach((scene, cena) => {
      for (const take of scene.takes) if (take.sourceId === source.id) usos.push({ cena, start: take.start, end: take.end });
    });
    const ocupado = normalizeRanges(usos);
    let sequencia = [];
    const fechar = () => {
      if (!sequencia.length) return;
      const cena = cenaMaisPerto(usos, sequencia[0].start, sequencia.at(-1).end);
      const trecho = novoTrecho(cena, 1, fonte, source.id);
      for (const word of sequencia) acrescentar(trecho, selectionKey(project.scenes[cena].id, "", word.id), word);
      trechos.push(trecho);
      sequencia = [];
    };
    let j = 0;
    for (const word of effectiveWords(project, source.id)) {
      while (j < ocupado.length && ocupado[j].end <= word.start) j += 1;
      if (j < ocupado.length && ocupado[j].start < word.end) fechar();
      else sequencia.push(word);
    }
    fechar();
  });
  // Ordem do documento: por cena, a fala antes das zonas, que seguem a ordem das Mídias.
  trechos.sort((a, b) => a.cena - b.cena || a.tipo - b.tipo || a.fonte - b.fonte || a.inicio - b.inicio);
  const posicoes = new Map();
  for (const trecho of trechos) for (const chave of trecho.chaves) posicoes.set(chave, posicoes.size);
  return { trechos, posicoes };
}

const indices = new WeakMap();

/**
 * Trechos pesquisáveis na ordem do documento e a posição de cada ocorrência
 * (puro, um por objeto de projeto): a fala de cada cena, com palavras
 * mantidas e cortadas, e o material de cada Mídia que nenhum take usa.
 * Palavra que encosta num take não conta como não usada.
 */
export function indiceDeBusca(project) {
  const deps = [project.scenes, project.analyses, project.corrections, project.assembly.sources];
  const hit = indices.get(project);
  if (hit && hit.deps.every((dep, i) => dep === deps[i])) return hit.value;
  const value = project.scenes.length ? construirIndice(project) : { trechos: [], posicoes: new Map() };
  indices.set(project, { deps, value });
  return value;
}

/**
 * Ocorrências da consulta na ordem do documento (puro). Uma frase pode
 * atravessar os takes de uma cena, mas não sai da cena nem da sequência não
 * usada. `omitida` marca a ocorrência fora da montagem; `fonte` é a Mídia
 * da zona que o texto precisa abrir para mostrá-la.
 * @returns {{ chaves: string[], omitida: boolean, fonte: string | null }[]}
 */
export function ocorrencias(project, consulta) {
  const termo = normalizarBusca(consulta);
  if (!termo || !project?.scenes?.length) return [];
  const out = [];
  for (const trecho of indiceDeBusca(project).trechos) {
    let k = 0;
    for (let at = trecho.texto.indexOf(termo); at >= 0; at = trecho.texto.indexOf(termo, at + termo.length)) {
      const fim = at + termo.length;
      while (trecho.ate[k] <= at) k += 1;
      const chaves = [];
      for (let i = k; i < trecho.chaves.length && trecho.de[i] < fim; i += 1) chaves.push(trecho.chaves[i]);
      out.push({ chaves, omitida: trecho.tipo === 1, fonte: trecho.sourceId });
    }
  }
  return out;
}

/** Contador (puro): "n de m", com a marca de fora da montagem na atual. */
export function contadorDaBusca(consulta, lista, atual) {
  if (!normalizarBusca(consulta)) return "";
  if (!lista.length) return "Nenhuma ocorrência";
  return (atual + 1) + " de " + lista.length + (lista[atual]?.omitida ? " · fora da montagem" : "");
}

/**
 * Liga o botão "Buscar" do cabeçalho do texto e a caixa logo abaixo dele.
 * Enter e Shift+Enter navegam, Esc fecha e deixa o foco na palavra da
 * ocorrência atual; Ctrl/Cmd+F abre quando o foco está no cartão do texto.
 */
export function mountBusca({ state, head = document.getElementById("textoHead"), texto = document.getElementById("texto") }) {
  const center = texto?.parentElement;
  if (!head || !texto || !center) return;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "quiet small texto-busca-toggle";
  // data-busca: buscar só lê, então segue liberado no Modo Leitura.
  toggle.dataset.busca = "";
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", "textoBusca");
  toggle.innerHTML = ICON.search + '<span class="rotulo">Buscar</span>';
  head.insertBefore(toggle, document.getElementById("undoSlot"));
  const box = document.createElement("div");
  box.id = "textoBusca";
  box.className = "texto-busca";
  box.setAttribute("role", "search");
  box.hidden = true;
  box.innerHTML = '<input type="search" data-busca aria-label="Buscar no texto" placeholder="Buscar palavra ou frase"'
    + ' autocomplete="off" spellcheck="false">'
    + '<span class="busca-contador" aria-live="polite"></span>'
    + '<button type="button" class="icon" data-busca data-busca-passo="-1" aria-label="Ocorrência anterior">' + ICON.up + "</button>"
    + '<button type="button" class="icon" data-busca data-busca-passo="1" aria-label="Próxima ocorrência">' + ICON.down + "</button>"
    + '<button type="button" class="icon" data-busca data-busca-fechar aria-label="Fechar busca">' + ICON.close + "</button>";
  center.insertBefore(box, texto);
  const input = box.querySelector("input");
  const contador = box.querySelector(".busca-contador");

  let aberta = false;
  let lista = [];
  let atual = -1;
  // Ocorrência de onde a busca parte: a primeira selecionada ao abrir, depois a atual.
  let ancora = null;

  function publicar(revelar) {
    const corrente = lista[atual];
    contador.textContent = contadorDaBusca(input.value, lista, atual);
    for (const btn of box.querySelectorAll("[data-busca-passo]")) btn.disabled = lista.length === 0;
    state.set("busca", {
      chaves: lista.filter((item) => !item.omitida).flatMap((item) => item.chaves),
      omitidas: lista.filter((item) => item.omitida).flatMap((item) => item.chaves),
      atuais: corrente ? corrente.chaves : [],
      revelar: revelar && corrente ? { chave: corrente.chaves[0], fonte: corrente.omitida ? corrente.fonte : null } : null,
    });
  }

  function buscar(revelar = true) {
    const project = state.get("project");
    lista = project ? ocorrencias(project, input.value) : [];
    const posicoes = lista.length ? indiceDeBusca(project).posicoes : new Map();
    const desde = ancora == null ? -1 : posicoes.get(ancora) ?? -1;
    atual = lista.length ? Math.max(0, lista.findIndex((item) => (posicoes.get(item.chaves[0]) ?? 0) >= desde)) : -1;
    if (lista[atual]) ancora = lista[atual].chaves[0];
    publicar(revelar);
  }

  function passo(delta) {
    if (!lista.length) return;
    atual = (atual + delta + lista.length) % lista.length;
    ancora = lista[atual].chaves[0];
    publicar(true);
  }

  function primeiraSelecionada() {
    const project = state.get("project");
    const selecao = state.get("selection");
    if (!project || !selecao?.size) return null;
    const { posicoes } = indiceDeBusca(project);
    let melhor = null;
    for (const chave of selecao) {
      const posicao = posicoes.get(chave);
      if (posicao !== undefined && (melhor === null || posicao < posicoes.get(melhor))) melhor = chave;
    }
    return melhor;
  }

  function abrir() {
    if (!aberta) {
      aberta = true;
      box.hidden = false;
      toggle.setAttribute("aria-expanded", "true");
      ancora = primeiraSelecionada();
      if (normalizarBusca(input.value)) buscar();
    }
    input.focus();
    input.select?.();
  }

  /** Fecha; com `focar`, o texto põe o foco na palavra da ocorrência atual. */
  function fechar(focar = true) {
    if (!aberta) return;
    const corrente = lista[atual];
    aberta = false;
    box.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    if (focar) toggle.focus();
    lista = [];
    atual = -1;
    state.set("busca", {
      chaves: [], omitidas: [], atuais: [],
      revelar: focar && corrente ? { chave: corrente.chaves[0], fonte: corrente.omitida ? corrente.fonte : null } : null,
      focar,
    });
  }

  toggle.addEventListener("click", () => {
    if (aberta) fechar();
    else abrir();
  });
  input.addEventListener("input", () => buscar());
  box.addEventListener("click", (ev) => {
    const step = ev.target.closest("[data-busca-passo]");
    if (step && box.contains(step)) passo(Number(step.dataset.buscaPasso));
    else if (ev.target.closest("[data-busca-fechar]")) fechar();
  });
  box.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      fechar();
    } else if (ev.key === "Enter" && ev.target === input) {
      ev.preventDefault();
      passo(ev.shiftKey ? -1 : 1);
    }
  });
  // Ctrl/Cmd+F no cartão do texto: a busca do navegador não vê as cenas virtualizadas.
  document.addEventListener("keydown", (ev) => {
    if (!(ev.ctrlKey || ev.metaKey) || ev.altKey || ev.key?.toLowerCase() !== "f" || toggle.hidden) return;
    if (!center.contains(ev.target)) return;
    ev.preventDefault();
    abrir();
  });

  function paintToggle(project) {
    toggle.hidden = !project?.scenes?.length;
    if (toggle.hidden) fechar(false);
    // Edição, correção ou poll: refaz a lista e segue na mesma ocorrência, sem rolar.
    else if (aberta && normalizarBusca(input.value)) buscar(false);
  }
  state.subscribe("project", paintToggle);
  paintToggle(state.get("project"));
}
