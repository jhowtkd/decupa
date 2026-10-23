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

// Termos já normalizados: o vocabulário falado é pequeno e se repete muito.
const termos = new Map();
const MAX_TERMOS = 50_000;

function termoDe(text) {
  let termo = termos.get(text);
  if (termo === undefined) {
    if (termos.size >= MAX_TERMOS) termos.clear();
    termo = normalizarBusca(text);
    termos.set(text, termo);
  }
  return termo;
}

function acrescentar(trecho, chave, word) {
  const termo = termoDe(word.display || word.text);
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

/**
 * O que muda as palavras pesquisáveis. Cada resposta traz um objeto de
 * projeto novo, mesmo sem mudar o texto (poll, prévia); cenas e cortes só
 * mudam com revisão nova, e o que muda na mesma revisão (correção que
 * termina em segundo plano, transcrição que chega) aparece no status e na
 * contagem.
 */
function chaveDeConteudo(project) {
  return [
    project.id, project.revision,
    (project.corrections || []).map((item) => item.id + ":" + item.status).join(","),
    (project.analyses || []).map((item) => item.sourceId + ":" + item.status + ":" + (item.words?.length ?? 0)).join(","),
    project.assembly.sources.map((source) => source.id).join(","),
  ].join("|");
}

let ultimoIndice = { chave: null, valor: null };

/**
 * Trechos pesquisáveis na ordem do documento e a posição de cada ocorrência
 * (puro, reaproveitado enquanto o conteúdo não muda): a fala de cada cena,
 * com palavras mantidas e cortadas, e o material de cada Mídia que nenhum
 * take usa. Palavra que encosta num take não conta como não usada.
 */
export function indiceDeBusca(project) {
  const chave = chaveDeConteudo(project);
  if (ultimoIndice.chave === chave) return ultimoIndice.valor;
  const valor = project.scenes.length ? construirIndice(project) : { trechos: [], posicoes: new Map() };
  ultimoIndice = { chave, valor };
  return valor;
}

/**
 * Ocorrências da consulta na ordem do documento (puro). A ocorrência começa
 * no início de uma palavra ("mont" acha "montagem"; "acao" não acha
 * "gravação"). Uma frase pode atravessar os takes de uma cena, mas não sai
 * da cena nem da sequência não usada. `omitida` marca a ocorrência fora da
 * montagem; `fonte` é a Mídia da zona que o texto precisa abrir para mostrá-la.
 * @returns {{ chaves: string[], omitida: boolean, fonte: string | null }[]}
 */
export function ocorrencias(project, consulta) {
  const termo = normalizarBusca(consulta);
  if (!termo || !project?.scenes?.length) return [];
  const out = [];
  for (const trecho of indiceDeBusca(project).trechos) {
    let k = 0;
    let at = trecho.texto.indexOf(termo);
    while (at >= 0) {
      // No meio de uma palavra não conta; a procura segue um caractere adiante.
      if (at > 0 && trecho.texto[at - 1] !== " ") {
        at = trecho.texto.indexOf(termo, at + 1);
        continue;
      }
      const fim = at + termo.length;
      while (trecho.ate[k] <= at) k += 1;
      const chaves = [];
      for (let i = k; i < trecho.chaves.length && trecho.de[i] < fim; i += 1) chaves.push(trecho.chaves[i]);
      out.push({ chaves, omitida: trecho.tipo === 1, fonte: trecho.sourceId });
      at = trecho.texto.indexOf(termo, fim);
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
  // Ocorrência de onde a busca parte: a primeira selecionada ao abrir, depois
  // a atual. A posição fica junto para quando a chave some (correção nela).
  let ancora = null;
  let ancoraPosicao = null;

  function ancorar(chave, posicoes) {
    ancora = chave;
    ancoraPosicao = chave == null ? null : posicoes.get(chave) ?? null;
  }

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
    const posicao = (item) => posicoes.get(item.chaves[0]) ?? 0;
    const exata = ancora == null ? undefined : posicoes.get(ancora);
    if (!lista.length) atual = -1;
    else if (exata !== undefined) atual = Math.max(0, lista.findIndex((item) => posicao(item) >= exata));
    else if (ancoraPosicao != null) {
      // A ocorrência de antes sumiu: segue na mais perto de onde ela estava.
      atual = 0;
      for (const [i, item] of lista.entries()) {
        if (Math.abs(posicao(item) - ancoraPosicao) < Math.abs(posicao(lista[atual]) - ancoraPosicao)) atual = i;
      }
    } else atual = 0;
    if (lista[atual]) ancorar(lista[atual].chaves[0], posicoes);
    publicar(revelar);
  }

  function passo(delta) {
    if (!lista.length) return;
    atual = (atual + delta + lista.length) % lista.length;
    ancorar(lista[atual].chaves[0], indiceDeBusca(state.get("project")).posicoes);
    publicar(true);
  }

  /** A busca parte da primeira palavra selecionada que ela conhece; sem seleção, do começo. */
  function ancorarNaSelecao() {
    const project = state.get("project");
    const selecao = state.get("selection");
    if (!project || !selecao?.size) {
      ancorar(null);
      return;
    }
    const { posicoes } = indiceDeBusca(project);
    let melhor = null;
    for (const chave of selecao) {
      const posicao = posicoes.get(chave);
      if (posicao !== undefined && (melhor === null || posicao < posicoes.get(melhor))) melhor = chave;
    }
    ancorar(melhor, posicoes);
  }

  function abrir() {
    if (!aberta) {
      aberta = true;
      box.hidden = false;
      toggle.setAttribute("aria-expanded", "true");
      ancorarNaSelecao();
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
  // Ctrl/Cmd+F no texto: a busca do navegador não vê as cenas virtualizadas.
  // Com o texto escondido (a Entrega ocupa o cartão), o atalho segue com o navegador.
  document.addEventListener("keydown", (ev) => {
    if (!(ev.ctrlKey || ev.metaKey) || ev.altKey || ev.key?.toLowerCase() !== "f" || toggle.hidden) return;
    if (head.hidden || texto.hidden || !center.contains(ev.target)) return;
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
  // Fora da Edição o texto some: a busca fecha, como a barra da seleção, e
  // nenhum projeto novo refaz a lista sem ninguém ver.
  state.subscribe("stage", (stage) => {
    if (stage !== "edicao") fechar(false);
  });
  paintToggle(state.get("project"));
}
