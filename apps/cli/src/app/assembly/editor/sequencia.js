// Faixa-bússola da sequência (Tasks 7–8): blocos proporcionais da montagem
// como navegação. Puras testáveis (blocksAt/activeScene/seekFromRatio);
// o DOM monta os blocos via timelineBlocks de montage.js, clique busca por
// ratio, arraste faz scrub com throttle e o playhead acende bloco + linha.
// O waveform (Task 8) compõe os trechos retidos sobre cada bloco de cena
// num <canvas>; apoio não entra (não tem áudio próprio) e sem peaks a
// faixa segue só com os blocos. O desfazer mora no cabeçalho do texto
// (botão de desfazer no cabeçalho do texto + atalho Cmd/Ctrl+Z), desabilitado na revisão 0.
// No studio a faixa separa vídeo, apoio, áudio e legenda em trilhas sob a
// mesma régua, com zoom local; cada trilha mostra o dado real ou diz que
// ele falta ("sem miniatura", "sem onda", "sem áudio"). A alça de cada cena
// leva a cena para outra posição (ponteiro ou teclado): a ordem inteira vai
// num pedido só, que vira uma revisão e um passo de desfazer.
import { ZOOMS, clock, clockPrecise, formatChip } from "./format.js";
import { ICON } from "./icons.js";
import { montageDuration, retainedSegments, timelineBlocks } from "./montage.js";
import { projectHeaders, projectPath } from "../project-path.js";

/**
 * Bloco sob o playhead (puro): `{sceneId, kind} | null`. A camada de apoio
 * sobrepõe a cena no tempo — quando o instante cai sobre um apoio, o apoio
 * vence (é a camada de cima na faixa).
 */
export function blocksAt(project, seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const blocks = timelineBlocks(project).filter(
    (block) => block.start <= seconds && seconds < block.end,
  );
  if (!blocks.length) return null;
  const top = blocks.find((block) => block.kind === "support") || blocks[0];
  return { sceneId: top.sceneId, kind: top.kind };
}

/** Cena sob o playhead (pura): ignora a camada de apoio. */
export function activeScene(project, seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const found = timelineBlocks(project).find(
    (block) => block.kind === "scene" && block.start <= seconds && seconds < block.end,
  );
  return found ? found.sceneId : null;
}

/** Ratio [0,1] → segundos na montagem (puro; prende fora do intervalo). */
export function seekFromRatio(project, ratio) {
  const duration = montageDuration(project);
  if (!Number.isFinite(ratio)) return 0;
  const clamped = Math.min(1, Math.max(0, ratio));
  return clamped * duration;
}

/**
 * Marca da régua da faixa (puro): crescente a partir de 0 com passo "nice"
 * (1/2/5×10^n) que aproxima `durationSeconds/targetCount`; a última marca
 * fica dentro da duração.
 */
export function rulerTicks(durationSeconds, targetCount = 6) {
  if (!(durationSeconds > 0)) return [0];
  const raw = durationSeconds / targetCount;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow;
  const ticks = [];
  for (let s = 0; s <= durationSeconds + 1e-9; s += step) ticks.push(s);
  return ticks;
}

/**
 * Timecode mono tabular MM:SS.mmm (puro). Não-finito/negativo vira zero.
 */
export function formatTimecode(seconds) {
  const ms = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * 1000));
  return String(Math.floor(ms / 60000)).padStart(2, "0") + ":"
    + String(Math.floor(ms / 1000) % 60).padStart(2, "0") + "."
    + String(ms % 1000).padStart(3, "0");
}

/**
 * Cues de legenda do projeto (puro): só dado real — quando o backend não
 * envia `captions`, devolve [] e a UI não desenha a lane.
 */
export function captionCues(project) {
  const cues = project && Array.isArray(project.captions) ? project.captions : [];
  return cues
    .filter((cue) => cue && Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end > cue.start)
    .map((cue) => ({ start: cue.start, end: cue.end, text: String(cue.text ?? "") }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * Coluna → segmento retido (puro): bucketiza `inBlock` por pixel com uma
 * varredura de ponteiro único — O(largura + segmentos) em vez do
 * O(largura × segmentos) da busca por pixel. `inBlock` chega ordenado por
 * montageStart e sem sobreposição (ordem de retainedSegments); cada coluna
 * recebe exatamente o segmento que `find(start <= t && t < end)` devolveria
 * para o instante do centro do pixel, ou null no vão entre segmentos.
 */
export function bucketizeSegments(inBlock, blockStart, sceneDur, width) {
  const buckets = [];
  if (!Array.isArray(inBlock) || inBlock.length === 0 || !(width > 0)) return buckets;
  let i = 0;
  for (let x = 0; x < width; x++) {
    const montageT = blockStart + ((x + 0.5) / width) * sceneDur;
    while (i < inBlock.length && montageT >= inBlock[i].montageEnd) i++;
    const seg = i < inBlock.length ? inBlock[i] : null;
    buckets.push(seg && montageT >= seg.montageStart ? seg : null);
  }
  return buckets;
}

/**
 * Passada de desenho da waveform (pura): devolve as operações fillRect
 * `{x, top, h}` em ordem de x, pixel-idênticas ao loop antigo. Os segmentos
 * chegam bucketizados por pixel (bucketizeSegments) e as métricas por fonte
 * (perBucket) são resolvidas UMA vez por fonte antes do loop — dentro do
 * loop só há aritmética, sem Map.get externo, sem divisão repetida e sem
 * leitura de layout.
 */
export function planSceneWave(inBlock, bySource, blockStart, sceneDur, width, height) {
  const ops = [];
  if (!(width > 0) || !(height > 0) || !Array.isArray(inBlock) || inBlock.length === 0) return ops;
  // Cache por fonte fora do loop: cada fonte distinta resolve uma vez.
  const cached = new Map();
  for (const seg of inBlock) {
    if (!seg || cached.has(seg.sourceId)) continue;
    const peaks = bySource ? bySource.get(seg.sourceId) : undefined;
    const perBucket = peaks ? peaks.count / peaks.peaks.length : NaN;
    cached.set(seg.sourceId, {
      peaks,
      perBucket,
      ok: !!peaks && Number.isFinite(peaks.sampleRate) && peaks.sampleRate > 0 && perBucket > 0,
    });
  }
  const halfH = height / 2;
  const buckets = bucketizeSegments(inBlock, blockStart, sceneDur, width);
  let curSeg = null;
  let cur = null;
  for (let x = 0; x < buckets.length; x++) {
    const seg = buckets[x];
    if (!seg) {
      curSeg = null;
      cur = null;
      continue;
    }
    // A fonte só é (re)resolvida na troca de segmento, nunca por pixel.
    if (seg !== curSeg) {
      curSeg = seg;
      cur = cached.get(seg.sourceId);
    }
    if (!cur || !cur.ok) continue;
    const peaks = cur.peaks;
    const span = seg.montageEnd - seg.montageStart;
    const montageT = blockStart + ((x + 0.5) / width) * sceneDur;
    const frac = span > 0 ? (montageT - seg.montageStart) / span : 0;
    const srcT = seg.srcStart + frac * (seg.srcEnd - seg.srcStart);
    const bucket = peaks.peaks[
      Math.min(peaks.peaks.length - 1, Math.max(0, Math.floor((srcT * peaks.sampleRate) / cur.perBucket)))
    ];
    if (!bucket) continue;
    const yMax = halfH - (bucket.max / 32768) * halfH;
    const yMin = halfH - (bucket.min / 32768) * halfH;
    const top = Math.min(yMin, yMax);
    ops.push({ x, top, h: Math.max(1, Math.abs(yMax - yMin)) });
  }
  return ops;
}

/** Intervalo entre seeks de scrub durante o arraste. */
export const SCRUB_THROTTLE_MS = 60;

export { ZOOMS };

/** Zoom válido (puro): fora da lista volta a 1. */
export function zoomValido(zoom) {
  return ZOOMS.includes(zoom) ? zoom : 1;
}

/**
 * Cues da trilha de legenda do studio (puro), a partir do resultado de
 * GET project/subtitles (chave "legendasFaixa"): só os da revisão do
 * projeto, em segundos.
 */
export function cuesDaFaixa(legendas, project) {
  if (!legendas || !project || legendas.revision !== project.revision || legendas.estado !== "pronto") return [];
  return captionCues({
    captions: (legendas.cues || []).map((cue) => ({ start: cue.startMs / 1000, end: cue.endMs / 1000, text: cue.text })),
  });
}

/** Largura mínima (px) para uma fala ter bloco e rótulo próprios na trilha de legenda. */
export const LEGENDA_CUE_MIN_PX = 24;

/**
 * Itens da trilha de legenda (puro). Cada fala com pelo menos `limiar` px na
 * largura atual da trilha (zoom incluído) fica sozinha; falas seguidas mais
 * estreitas, da mesma cena e sem um vão de `limiar` px entre elas, viram um
 * bloco só, com a contagem (`falas`). O bloco nunca atravessa o começo de uma
 * cena (`cortes`, em segundos da montagem): fica sob a cena dele. Uma fala
 * estreita isolada segue sozinha. Largura desconhecida (0: a faixa está
 * escondida) não agrupa nada; o redesenho por largura repinta quando ela
 * aparece.
 * @param {{start: number, end: number, text: string}[]} cues em ordem
 * @param {number} duration segundos da montagem
 * @param {number} larguraPx largura da trilha inteira, em px
 * @param {number[]} [cortes] começos das cenas, em ordem
 * @returns {({start: number, end: number, text: string} | {start: number, end: number, falas: number})[]}
 */
export function agruparCues(cues, duration, larguraPx, cortes = [], limiar = LEGENDA_CUE_MIN_PX) {
  if (!(larguraPx > 0) || !(duration > 0)) return cues;
  const px = (segundos) => (segundos / duration) * larguraPx;
  const itens = [];
  let grupo = null;
  let cena = -1;
  const fechar = () => {
    if (grupo) itens.push(grupo.falas === 1 ? grupo.primeira : { start: grupo.start, end: grupo.end, falas: grupo.falas });
    grupo = null;
  };
  for (const cue of cues) {
    while (cena + 1 < cortes.length && cortes[cena + 1] <= cue.start) cena += 1;
    if (px(cue.end - cue.start) >= limiar) {
      fechar();
      itens.push(cue);
    } else if (grupo && grupo.cena === cena && px(cue.start - grupo.end) < limiar) {
      grupo.end = Math.max(grupo.end, cue.end);
      grupo.falas += 1;
    } else {
      fechar();
      grupo = { start: cue.start, end: cue.end, falas: 1, primeira: cue, cena };
    }
  }
  fechar();
  return itens;
}

/** Estado da trilha de legenda sem cues (puro): o porquê, nunca vazio mudo. */
export function legendaVazia(legendas, project) {
  if (!legendas || legendas.revision !== project?.revision || legendas.estado === "carregando") return "carregando legenda…";
  if (legendas.estado === "sem-fala") return "sem fala retida";
  if (legendas.estado === "indisponivel") return "legenda indisponível";
  if (legendas.estado === "erro") return "legenda não carregou";
  return "sem legenda";
}

/** Distância (px) que separa o clique na alça da cena do começo do arraste. */
export const ARRASTE_LIMIAR_PX = 4;

/** Faixa (px) junto à borda da vista que rola a sequência durante o arraste. */
export const ARRASTE_BORDA_PX = 32;

/**
 * Ordem das cenas com `sceneId` levada à posição `destino` (pura), ou null
 * quando nada muda: cena desconhecida, destino fora da lista ou o mesmo lugar.
 * @param {string[]} ids
 * @param {string} sceneId
 * @param {number} destino
 */
export function ordemMovida(ids, sceneId, destino) {
  const de = ids.indexOf(sceneId);
  if (de < 0 || !Number.isInteger(destino) || destino < 0 || destino >= ids.length || destino === de) return null;
  const ordem = ids.filter((id) => id !== sceneId);
  ordem.splice(destino, 0, sceneId);
  return ordem;
}

/**
 * Posição final da cena `de` com o ponteiro no instante `t` (pura): conta as
 * outras cenas cujo meio fica antes dele. `blocos` são as cenas na ordem atual.
 * @param {{ start: number, end: number }[]} blocos
 */
export function destinoDoArraste(blocos, de, t) {
  let destino = 0;
  blocos.forEach((bloco, i) => {
    if (i !== de && (bloco.start + bloco.end) / 2 < t) destino += 1;
  });
  return destino;
}

/**
 * Instante da fronteira onde a cena `de` entra ao ir para `destino` (pura):
 * antes da cena que hoje ocupa o lugar, ou depois dela; null no próprio lugar.
 * @param {{ start: number, end: number }[]} blocos
 */
export function fronteiraDoDestino(blocos, de, destino) {
  if (destino === de || !blocos[destino]) return null;
  return destino < de ? blocos[destino].start : blocos[destino].end;
}

/** Anúncio do arraste pelo teclado (puro): "Cena 2 · posição 4 de 5". */
export function anuncioDoArraste(numero, destino, total) {
  return "Cena " + numero + " · posição " + (destino + 1) + " de " + total;
}

/**
 * Reordena as cenas (studio): um POST project/edit com a ordem inteira, a
 * partir da revisão que estava na tela. Arraste, teclado da faixa e menu da
 * cena passam por aqui; o servidor confere a ordem contra essa revisão.
 * @param {{ call: Function }} api
 * @param {{ revision: number }} project
 * @param {string[]} ordem
 */
export function enviarOrdem(api, project, ordem) {
  return api.call("project/edit", {
    method: "POST",
    body: JSON.stringify({ baseRevision: project.revision, action: { type: "reorder-scenes", order: ordem } }),
    label: "Movendo cena…",
  });
}

/** Guarda do atalho global de desfazer (o módulo monta uma vez por página). */
let undoKeyBound = false;

/**
 * Um pedido por vez (pura): enquanto a promessa de `run` não assenta, novas
 * chamadas são ignoradas. `onChange(busy)` avisa quem pinta o controle; a
 * liberação vale para sucesso e erro. Sem promessa (nada a fazer), não trava.
 * @param {(...args: any[]) => any} run
 * @param {(busy: boolean) => void} [onChange]
 */
export function singleFlight(run, onChange = () => {}) {
  let busy = false;
  const call = (...args) => {
    if (busy) return undefined;
    const pending = run(...args);
    if (!pending || typeof pending.then !== "function") return pending;
    busy = true;
    onChange(true);
    const settle = () => {
      busy = false;
      onChange(false);
    };
    pending.then(settle, settle);
    return pending;
  };
  call.busy = () => busy;
  return call;
}

/** Topo de `steps` ou `redo` em `project.undo`, só enquanto `head` é a revisão atual. */
function historyTop(project, key) {
  const undo = project?.undo;
  const list = undo && undo.head === project.revision ? undo[key] : null;
  return Array.isArray(list) ? list[list.length - 1] ?? null : null;
}

/**
 * Botão de desfazer (puro): anuncia o passo do topo da pilha do servidor
 * (`project.undo`). Só libera quando o GET confirmou a mesma foto
 * (`undoRevision`); pilha quebrada ou foto ilegível deixam travado.
 * @returns {{ disabled: boolean, busy: boolean, title: string, text: string }}
 */
export function undoView(project, undoRevision, busy) {
  const top = historyTop(project, "steps");
  if (busy) return { disabled: true, busy: true, title: "Desfazendo…", text: top ? top.label : "" };
  if (!top || undoRevision == null || top.revision !== undoRevision) {
    return { disabled: true, busy: false, title: "Nenhuma alteração com histórico para desfazer", text: "" };
  }
  return { disabled: false, busy: false, title: "Desfazer: " + top.label, text: top.label };
}

/**
 * Botão de refazer (puro, só no studio): espelho do `undoView` sobre o ramo
 * do refazer (`project.undo.redo`) e a foto confirmada pelo GET (`redoRevision`).
 * Edição nova ou revisão que andou por fora encerram o ramo no servidor.
 * @returns {{ disabled: boolean, busy: boolean, title: string, text: string }}
 */
export function redoView(project, redoRevision, busy) {
  const top = historyTop(project, "redo");
  if (busy) return { disabled: true, busy: true, title: "Refazendo…", text: top ? top.label : "" };
  if (!top || redoRevision == null || top.revision !== redoRevision) {
    return { disabled: true, busy: false, title: "Nada desfeito para refazer", text: "" };
  }
  return { disabled: false, busy: false, title: "Refazer: " + top.label, text: top.label };
}

/**
 * Atalho de histórico (puro): Cmd/Ctrl+Z desfaz nas duas variantes; no studio,
 * Cmd/Ctrl+Shift+Z e Ctrl+Y refazem. Alt nunca é atalho daqui.
 * @returns {"undo" | "redo" | null}
 */
export function historyKey(ev, ui) {
  if (ev.altKey) return null;
  const key = String(ev.key || "").toLowerCase();
  if (key === "z" && (ev.metaKey || ev.ctrlKey)) {
    if (!ev.shiftKey) return "undo";
    return ui === "studio" ? "redo" : null;
  }
  if (key === "y" && ev.ctrlKey && !ev.metaKey && !ev.shiftKey) return ui === "studio" ? "redo" : null;
  return null;
}

function esc(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

/**
 * Monta a faixa: blocos proporcionais, clique→seek, arraste→scrub,
 * playhead→linha + bloco .ativa. `player` expõe `seek(seconds)` e `el()`.
 */
export function mountSequencia({ state, api, player, ui = "legacy" }) {
  const root = () => document.getElementById("faixa");

  /**
   * Desfaz a última edição (mesmo POST do antigo botão do contexto). Clique e
   * Cmd+Z passam por aqui: com um pedido em voo, o segundo é ignorado.
   */
  const undoEdit = singleFlight(() => {
    const p = state.get("project");
    if (!p || redoEdit.busy() || undoView(p, state.get("undoRevision"), false).disabled) return undefined;
    return api.call("project/undo", {
      method: "POST",
      body: JSON.stringify({ baseRevision: p.revision, revision: state.get("undoRevision") }),
      label: "Desfazendo…",
    });
  }, () => placeHistory(state.get("project")));

  /**
   * Refaz o último desfazer (studio). Divide o voo com o desfazer: um pedido
   * de histórico por vez, e cada um parte da revisão que o anterior deixou.
   */
  const redoEdit = singleFlight(() => {
    const p = state.get("project");
    if (ui !== "studio" || !p || undoEdit.busy() || redoView(p, state.get("redoRevision"), false).disabled) return undefined;
    return api.call("project/redo", {
      method: "POST",
      body: JSON.stringify({ baseRevision: p.revision, revision: state.get("redoRevision") }),
      label: "Refazendo…",
    });
  }, () => placeHistory(state.get("project")));

  function placeHistory(p) {
    placeUndo(p);
    placeRedo(p);
  }

  /** Desfazer mora no cabeçalho do texto: é o gesto de quem edita pelo texto. */
  function placeUndo(p) {
    let undo = document.getElementById("undo");
    if (!undo) {
      undo = document.createElement("button");
      undo.type = "button";
      undo.id = "undo";
      undo.className = "icon";
      undo.innerHTML = ICON.undo + '<span class="undo-what" hidden></span>';
      undo.setAttribute("aria-label", "Desfazer edição");
      undo.onclick = () => void undoEdit();
      (document.getElementById("undoSlot") || root()).appendChild(undo);
    }
    const view = undoView(p, state.get("undoRevision"), undoEdit.busy());
    undo.disabled = view.disabled || redoEdit.busy();
    undo.setAttribute("aria-busy", String(view.busy));
    // O botão diz o que vai voltar: "Desfazer: Tirar trecho".
    undo.title = view.title;
    undo.setAttribute("aria-label", view.text ? "Desfazer: " + view.text : "Desfazer edição");
    const what = undo.querySelector(".undo-what");
    if (what) {
      what.textContent = view.text;
      what.hidden = !view.text;
    }
    undo.classList.toggle("has-label", !!view.text);
  }

  /**
   * Refazer (só no studio) fica logo depois do Desfazer, só com o ícone: o
   * rótulo do passo vai no title e no nome acessível.
   */
  function placeRedo(p) {
    if (ui !== "studio") return;
    let redo = document.getElementById("redo");
    if (!redo) {
      redo = document.createElement("button");
      redo.type = "button";
      redo.id = "redo";
      redo.className = "icon";
      redo.innerHTML = ICON.redo;
      redo.onclick = () => void redoEdit();
      (document.getElementById("undoSlot") || root()).appendChild(redo);
    }
    const view = redoView(p, state.get("redoRevision"), redoEdit.busy());
    redo.disabled = view.disabled || undoEdit.busy();
    redo.setAttribute("aria-busy", String(view.busy));
    redo.title = view.title;
    redo.setAttribute("aria-label", view.text ? "Refazer: " + view.text : "Refazer edição");
  }

  const studio = ui === "studio";
  const zoom = () => zoomValido(state.get("zoomSequencia"));
  // Largura da vista da faixa (no 1×), a última não nula: com a faixa
  // escondida (Materiais, Entrega) a medida dá 0, e a legenda que chega então
  // ainda sai agrupada, sem montar milhares de spans para a volta à Edição.
  let vistaLembrada = 0;
  /** Largura da trilha inteira no zoom atual, a partir da medida da vista agora. */
  const larguraTrilha = (vista) => {
    if (vista > 0) vistaLembrada = vista;
    return vistaLembrada * zoom();
  };

  // Arraste de cena (studio): um gesto por vez, do pegar até a resposta do
  // pedido. Enquanto existe, a faixa não se redesenha, a vista não segue o
  // playhead e os atalhos de histórico calam.
  let gesto = null;
  // Anúncios do arraste pelo teclado; o mesmo nó volta a cada redesenho.
  const anuncio = studio ? document.createElement("p") : null;
  if (anuncio) {
    anuncio.className = "faixa-anuncio";
    anuncio.setAttribute("aria-live", "polite");
  }

  let signature = "";
  function render(p) {
    // Os botões vivem fora da faixa: atualizam mesmo quando o desenho não muda.
    placeHistory(p);
    // Arraste em curso: o fim do gesto redesenha com o projeto de então. A
    // alça desabilitada no meio (Reserva perdida) solta o gesto de teclado
    // mesmo onde o navegador não avisa a perda de foco.
    if (gesto) {
      if (gesto.modo === "teclado" && !gesto.enviando && gesto.alca.disabled) cancelarGesto("Movimento cancelado");
      return;
    }
    const next = JSON.stringify(p && (studio
      ? [p.revision, p.scenes, p.assembly.sources, zoom()]
      : [p.revision, p.scenes, p.assembly.sources, p.captions]));
    if (next === signature) return;
    signature = next;
    const el = root();
    if (!el) return;
    if (!p) {
      el.replaceChildren();
      return;
    }
    const blocks = timelineBlocks(p);
    const duration = montageDuration(p);
    // Cabeçalho da faixa: rótulo do painel + total da montagem em mono.
    const head = document.createElement("div");
    head.className = "faixa-head";
    const label = document.createElement("span");
    label.className = "ttl";
    label.textContent = "Sequência";
    const count = document.createElement("span");
    count.className = "count";
    const supports = blocks.filter((block) => block.kind === "support").length;
    count.textContent = p.scenes.length + (p.scenes.length === 1 ? " cena" : " cenas")
      + (supports ? " · " + supports + (supports === 1 ? " apoio" : " apoios") : "");
    const total = document.createElement("span");
    total.className = "mono total";
    total.textContent = clockPrecise(duration);
    head.append(label, count, total);
    if (studio) head.insertBefore(cabecalhoStudio(p), total);
    if (!blocks.length) {
      const empty = document.createElement("div");
      empty.className = "timeline-empty";
      empty.innerHTML = '<div><strong>Sua sequência aparece aqui</strong><p>Prepare os materiais para criar o primeiro corte.</p></div>';
      el.replaceChildren(head, empty);
      return;
    }
    if (studio) {
      renderStudio(p, el, head, blocks, duration);
      return;
    }
    // Régua: marcas nice (rulerTicks) posicionadas por TEMPO, não por
    // índice — space-between mentiria contra os blocos/playhead, que são
    // proporcionais. Primeira e última marcas não recuam (não saem da faixa).
    const ruler = document.createElement("div");
    ruler.className = "ruler";
    const ticks = rulerTicks(duration);
    ticks.forEach((t, i) => {
      const s = document.createElement("span");
      s.textContent = clock(t);
      s.style.left = duration > 0 ? ((t / duration) * 100).toFixed(3) + "%" : "0%";
      if (i === 0 || i === ticks.length - 1) s.style.transform = "none";
      ruler.append(s);
    });
    const strip = document.createElement("div");
    strip.className = "seq-strip";
    // Layout crítico inline (o tema segue em page.css, fora desta tarefa).
    strip.style.cssText = "position:relative;width:100%;cursor:pointer;";
    strip.setAttribute("role", "slider");
    strip.setAttribute("aria-label", "Sequência da montagem");
    strip.setAttribute("aria-valuemin", "0");
    strip.setAttribute("aria-valuemax", String(duration));
    strip.setAttribute("tabindex", "0");
    strip.innerHTML = blocks.map((block) => {
      const width = duration > 0 ? ((block.end - block.start) / duration) * 100 : 0;
      const title = block.label + " · " + formatTimecode(block.start) + "–" + formatTimecode(block.end);
      // Só a cena ganha canvas de waveform; o apoio segue bloco puro.
      const wave = block.kind === "scene"
        ? '<canvas class="seq-wave" hidden></canvas>'
        : "";
      const pos = "position:absolute;left:" + (duration > 0 ? block.start / duration * 100 : 0).toFixed(3) + "%;";
      const scene = p.scenes.find((item) => item.id === block.sceneId);
      const source = p.assembly.sources.find((item) => item.id === scene?.takes[0]?.sourceId);
      const thumb = block.kind === "scene" && source?.hasVideo
        ? '<img class="timeline-thumb" alt="" loading="lazy" src="' + projectPath("project/thumbnail/" + encodeURIComponent(source.id)) + '">' : "";
      return '<div class="seq-bloco' + (block.kind === "support" ? " seq-apoio" : "") + '"'
        + ' data-scene="' + esc(block.sceneId) + '" data-kind="' + esc(block.kind) + '"'
        + ' data-group="' + esc(block.groupId || '') + '"'
        + ' data-start="' + block.start + '" data-end="' + block.end + '"'
        + ' title="' + esc(title) + '"'
        + ' style="width:' + width.toFixed(3) + '%;' + pos + '">'
        + thumb + '<span class="clip-label">' + esc(block.label) + "</span>" + wave
        + '<span class="data dur">' + (block.end - block.start).toFixed(1).replace(".", ",") + " s</span>"
        + "</div>";
    }).join("")
      + '<div class="seq-playhead" hidden style="position:absolute;top:0;bottom:0;width:2px;"></div>';
    const cues = captionCues(p);
    let captions = null;
    if (cues.length) {
      captions = document.createElement("div");
      captions.className = "seq-captions";
      captions.setAttribute("aria-label", "Legendas");
      for (const cue of cues) {
        const cueEl = document.createElement("span");
        cueEl.className = "seq-cue";
        cueEl.title = cue.text;
        cueEl.textContent = cue.text;
        cueEl.style.left = duration > 0 ? ((cue.start / duration) * 100).toFixed(3) + "%" : "0%";
        cueEl.style.width = duration > 0
          ? (Math.max(0, (cue.end - cue.start) / duration) * 100).toFixed(3) + "%" : "0%";
        captions.appendChild(cueEl);
      }
    }
    el.replaceChildren(head, ruler, strip, ...(captions ? [captions] : []));
    paint(state.get("playhead"));
    void hydrateWaves(p);
  }

  /** Studio: o formato com a resolução de saída e o zoom, no cabeçalho da faixa. */
  function cabecalhoStudio(p) {
    const tools = document.createElement("span");
    tools.className = "faixa-ferramentas";
    const atual = ZOOMS.indexOf(zoom());
    // "Formato…" abre o diálogo do studio (studio-formato.js escuta data-acao).
    tools.innerHTML = '<span class="faixa-formato"><span class="mono" title="Formato e resolução de saída da montagem">'
      + esc(formatChip(p.assembly)) + '</span><button type="button" class="small quiet" data-acao="formato">Formato…</button></span>'
      + '<span class="faixa-zoom" role="group" aria-label="Zoom da sequência">'
      + '<button type="button" class="icon small" data-zoom="-1" aria-label="Diminuir zoom da sequência">−</button>'
      + '<span class="mono zoom-valor">' + zoom() + "×</span>"
      + '<button type="button" class="icon small" data-zoom="1" aria-label="Aumentar zoom da sequência">+</button></span>';
    tools.querySelector('[data-zoom="-1"]').disabled = atual <= 0;
    tools.querySelector('[data-zoom="1"]').disabled = atual >= ZOOMS.length - 1;
    return tools;
  }

  /**
   * Studio: trilhas de vídeo (cenas com miniatura), apoio, áudio (onda por
   * cena) e legenda (cues da revisão atual), sob uma régua só e com a
   * largura multiplicada pelo zoom. Dado que falta vira estado escrito.
   */
  function renderStudio(p, el, head, blocks, duration) {
    const z = zoom();
    const pct = (t) => (duration > 0 ? (t / duration) * 100 : 0).toFixed(3) + "%";
    const ruler = document.createElement("div");
    ruler.className = "ruler";
    const ticks = rulerTicks(duration, 6 * z);
    ticks.forEach((t, i) => {
      const s = document.createElement("span");
      s.textContent = clock(t);
      s.style.left = pct(t);
      if (i === 0 || i === ticks.length - 1) s.style.transform = "none";
      ruler.append(s);
    });
    const sources = new Map(p.assembly.sources.map((source) => [source.id, source]));
    const scenes = new Map(p.scenes.map((scene) => [scene.id, scene]));
    const posicao = (block) => ' data-scene="' + esc(block.sceneId) + '" data-start="' + block.start + '" data-end="' + block.end + '"'
      + ' style="width:' + pct(block.end - block.start) + ";position:absolute;left:" + pct(block.start) + ';"';
    const bloco = (block, inner) => {
      const titulo = esc(block.label + " · " + formatTimecode(block.start) + "–" + formatTimecode(block.end));
      return '<div class="seq-bloco' + (block.kind === "support" ? " seq-apoio" : "") + '"'
        + posicao(block) + ' data-kind="' + esc(block.kind) + '" data-group="' + esc(block.groupId || "") + '"'
        + ' title="' + titulo + '">' + inner + "</div>";
    };
    const cenas = blocks.filter((block) => block.kind === "scene");
    const apoios = blocks.filter((block) => block.kind === "support");
    const video = cenas.map((block) => {
      const scene = scenes.get(block.sceneId);
      const source = (scene?.takes || []).map((take) => sources.get(take.sourceId)).find((item) => item?.hasVideo);
      const thumb = source
        ? '<img class="timeline-thumb" alt="" loading="lazy" title="Miniatura de ' + esc(source.name) + '" src="'
          + projectPath("project/thumbnail/" + encodeURIComponent(source.id)) + '">'
        : '<span class="sem-dado">sem miniatura</span>';
      // Miniatura, nome e duração juntos: com zoom, grudam na borda visível do bloco.
      return bloco(block, '<span class="bloco-rosto">' + thumb + '<span class="clip-label">' + esc(block.label) + "</span>"
        + '<span class="data dur">' + (block.end - block.start).toFixed(1).replace(".", ",") + " s</span></span>");
    }).join("");
    const apoio = apoios.length
      ? apoios.map((block) => bloco(block, '<span class="clip-label">' + esc(block.label) + "</span>")).join("")
      : '<span class="lane-vazia">sem apoio</span>';
    // Onda por cena, sob o bloco dela: o canvas só aparece com peaks reais.
    const audio = cenas.map((block) => {
      const scene = scenes.get(block.sceneId);
      const comAudio = (scene?.takes || []).some((take) => sources.get(take.sourceId)?.hasAudio);
      return '<div class="seq-audio"' + posicao(block) + ">"
        + (comAudio ? '<canvas class="seq-wave" hidden></canvas><span class="sem-dado" hidden>sem onda</span>' : '<span class="sem-dado">sem áudio</span>')
        + "</div>";
    }).join("");
    const strip = document.createElement("div");
    strip.className = "seq-strip";
    strip.style.cssText = "position:relative;width:100%;cursor:pointer;";
    strip.setAttribute("role", "slider");
    strip.setAttribute("aria-label", "Sequência da montagem");
    strip.setAttribute("aria-valuemin", "0");
    strip.setAttribute("aria-valuemax", String(duration));
    strip.setAttribute("tabindex", "0");
    const lane = (nome, inner) => '<div class="seq-lane lane-' + nome + '">' + inner + "</div>";
    // Largura da trilha no zoom atual; a da vista anterior serve até o observador de largura repintar.
    const largura = larguraTrilha(el.querySelector(".faixa-rolagem")?.clientWidth || el.clientWidth || 0);
    strip.innerHTML = lane("video", video) + lane("apoio", apoio) + lane("audio", audio) + lane("legenda", legendaHtml(p, duration, largura))
      + '<div class="seq-playhead" hidden style="position:absolute;top:0;bottom:0;width:2px;"></div>';
    const rotulos = document.createElement("div");
    rotulos.className = "faixa-rotulos";
    rotulos.setAttribute("aria-hidden", "true");
    rotulos.innerHTML = '<span class="rotulo-regua"></span><span>Vídeo</span><span>Apoio</span><span>Áudio</span><span>Legenda</span>';
    const trilhas = document.createElement("div");
    trilhas.className = "faixa-trilhas";
    trilhas.style.width = z * 100 + "%";
    trilhas.append(ruler, strip);
    if (cenas.length > 1) trilhas.append(alcasDasCenas(cenas, pct));
    const rolagem = document.createElement("div");
    rolagem.className = "faixa-rolagem";
    rolagem.append(trilhas);
    const corpo = document.createElement("div");
    corpo.className = "faixa-corpo";
    corpo.append(rotulos, rolagem);
    // O redesenho (zoom, revisão nova) mantém o centro da vista e o foco do
    // zoom ou da alça (a cena movida pelo teclado continua com o foco).
    const antes = el.querySelector(".faixa-rolagem");
    const centro = antes && antes.scrollWidth > 0 ? (antes.scrollLeft + antes.clientWidth / 2) / antes.scrollWidth : null;
    const foco = document.activeElement?.closest?.("[data-zoom]")?.dataset.zoom;
    const alcaFoco = document.activeElement?.closest?.(".bloco-alca")?.dataset.alca;
    el.replaceChildren(head, corpo, anuncio);
    // No 1× não há o que rolar: os poucos px da última marca da régua não contam.
    if (z > 1 && Number.isFinite(centro) && rolagem.scrollWidth > 0) {
      rolagem.scrollLeft = Math.max(0, centro * rolagem.scrollWidth - rolagem.clientWidth / 2);
    }
    if (foco) {
      const botoes = [...el.querySelectorAll("[data-zoom]")];
      (botoes.find((item) => item.dataset.zoom === foco && !item.disabled) || botoes.find((item) => !item.disabled))?.focus();
    }
    if (alcaFoco) focarAlca(alcaFoco);
    paint(state.get("playhead"));
    void hydrateWaves(p);
  }

  /**
   * Alças de ordem das cenas (studio): uma por cena, numa camada sobre a
   * trilha de vídeo e fora do slider, então o resto do bloco segue buscando
   * e o leitor de tela enxerga cada alça. Uma parada de Tab só: a alça da
   * cena selecionada (ou da primeira); as setas andam entre elas.
   */
  function alcasDasCenas(cenas, pct) {
    const selecionada = state.get("selectedScene");
    const noTab = cenas.some((block) => block.sceneId === selecionada) ? selecionada : cenas[0].sceneId;
    const alcas = document.createElement("div");
    alcas.className = "faixa-alcas";
    alcas.setAttribute("role", "group");
    alcas.setAttribute("aria-label", "Ordem das cenas");
    alcas.innerHTML = cenas.map((block, i) => {
      const nome = "Mover cena " + (i + 1) + ": " + block.label;
      // Cena sem duração (tudo cortado): a alça fica na fronteira, por cima da vizinha (CSS).
      const vazia = !(block.end > block.start);
      return '<div class="alca-cena' + (vazia ? " vazia" : "") + '" data-scene="' + esc(block.sceneId) + '" style="left:'
        + pct(block.start) + (vazia ? "" : ";width:" + pct(block.end - block.start)) + ';">'
        + '<button type="button" class="bloco-alca" data-alca="' + esc(block.sceneId) + '" tabindex="' + (block.sceneId === noTab ? "0" : "-1") + '"'
        + ' title="Arraste para mudar a ordem" aria-label="' + esc(nome) + '"'
        + ' aria-describedby="faixaAlcaAjuda">' + ICON.grip + "</button></div>";
    }).join("")
      + '<div class="faixa-destino" hidden></div>'
      + '<span id="faixaAlcaAjuda" hidden>Arraste para mudar a ordem. Pelo teclado: Espaço pega a cena, as setas escolhem o lugar, Espaço solta e Esc cancela.</span>';
    return alcas;
  }

  /** Uma parada de Tab nas alças: a da cena `sceneId`; cena sem alça mantém a de agora. */
  function alcaNoTab(sceneId) {
    const alcas = [...(root()?.querySelectorAll(".bloco-alca") || [])];
    if (!alcas.some((btn) => btn.dataset.alca === sceneId)) return;
    for (const btn of alcas) btn.tabIndex = btn.dataset.alca === sceneId ? 0 : -1;
  }

  function focarAlca(sceneId) {
    const btn = [...(root()?.querySelectorAll(".bloco-alca") || [])].find((item) => item.dataset.alca === sceneId);
    if (!btn) return;
    alcaNoTab(sceneId);
    btn.focus();
  }

  /**
   * Conteúdo da trilha de legenda (studio): os cues da revisão atual ou o
   * porquê de não haver. "carregando legenda…" só aparece se demorar (CSS).
   */
  function legendaHtml(p, duration, larguraPx) {
    const pct = (t) => (duration > 0 ? (t / duration) * 100 : 0).toFixed(3) + "%";
    const legendas = state.get("legendasFaixa");
    const cues = cuesDaFaixa(legendas, p);
    if (cues.length) {
      // Fala estreita demais para ler vira parte de um bloco "N falas": milhares
      // de spans de menos de 1 px pesavam em cada quadro da página.
      const cortes = timelineBlocks(p).filter((block) => block.kind === "scene").map((block) => block.start);
      return agruparCues(cues, duration, larguraPx, cortes).map((item) => {
        const posicao = ' style="left:' + pct(item.start) + ";width:" + pct(Math.max(0, item.end - item.start)) + ';"';
        if (!item.falas) return '<span class="seq-cue" title="' + esc(item.text) + '"' + posicao + ">" + esc(item.text) + "</span>";
        const rotulo = item.falas + " falas, " + clock(item.start) + "–" + clock(item.end);
        return '<span class="seq-cue seq-cue-grupo" title="' + rotulo + '"' + posicao + ">"
          + item.falas + " falas</span>";
      }).join("");
    }
    const texto = legendaVazia(legendas, p);
    const motivo = legendas?.revision === p.revision && legendas.motivo ? ' title="' + esc(legendas.motivo) + '"' : "";
    return '<span class="lane-vazia' + (texto === "carregando legenda…" ? " carregando" : "") + '"' + motivo + ">" + texto + "</span>";
  }

  /** A legenda chegou: troca só a trilha dela, sem refazer a faixa (nem o gesto em curso). */
  function pintarLegenda() {
    const p = state.get("project");
    const lane = root()?.querySelector(".seq-strip .lane-legenda");
    // Com o gesto, a faixa segura a ordem de quando pegou; o fim do gesto repinta.
    if (!p || !lane || gesto) return;
    lane.innerHTML = legendaHtml(p, montageDuration(p), larguraTrilha(root()?.querySelector(".faixa-rolagem")?.clientWidth || 0));
  }

  function mudarZoom(passo) {
    const atual = ZOOMS.indexOf(zoom());
    const next = ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, atual + passo))];
    if (next !== zoom()) state.set("zoomSequencia", next);
  }

  // Peaks por fonte com cache no tempo de vida do mount (a invalidação é
  // por sha no servidor; 204/erro vira null e o bloco segue sem waveform).
  // O GET vai direto, fora do api.call: a waveform é enfeite e sua resposta
  // não pode apagar o erro de uma ação nem sincronizar o projeto.
  // No studio só a onda que existe fica guardada: a preparação ainda pode
  // gerá-la e a rede pode voltar. `faltas` diz por que a fonte está sem.
  const peaksCache = new Map();
  const faltas = new Map();
  async function peaksFor(sourceId) {
    if (peaksCache.has(sourceId)) return peaksCache.get(sourceId);
    let peaks = null;
    let falha = false;
    try {
      const res = await fetch(projectPath("project/waveform/" + encodeURIComponent(sourceId)), {
        headers: projectHeaders(),
      });
      falha = !res.ok;
      const body = res.ok && res.status !== 204 ? await res.json() : null;
      if (body && Array.isArray(body.peaks) && body.peaks.length > 0) {
        peaks = body;
      }
    } catch {
      peaks = null;
      falha = true;
    }
    if (!studio || peaks) {
      peaksCache.set(sourceId, peaks);
      faltas.delete(sourceId);
    } else {
      faltas.set(sourceId, falha ? "erro" : "ausente");
    }
    return peaks;
  }

  /**
   * Por que a cena está sem onda (puro sobre `faltas`): erro de rede não é
   * "sem onda"; durante a preparação a onda ainda pode vir.
   */
  function motivoSemOnda(sourceIds, p) {
    if (sourceIds.some((id) => faltas.get(id) === "erro")) return "onda não carregou";
    return p.preparation?.status === "running" ? "preparando onda…" : "sem onda";
  }

  // Pinta um projeto obsoleto por cima do novo quando o fetch demora:
  // o token descarta a hidratação que perdeu a corrida.
  let waveGen = 0;

  /**
   * Desenha os trechos retidos em cada bloco de cena do strip (no studio, no
   * bloco da cena na trilha de áudio). `peaksDe(ids)` dá os peaks na ordem
   * das fontes (do fetch ou só do cache); `vivo()` falso depois da espera
   * para o desenho que perdeu a corrida. `marcar(node, temOnda)`, quando
   * vem, recebe a resposta definitiva de cada bloco.
   */
  async function drawBlocks(p, strip, peaksDe, vivo, marcar) {
    const segments = retainedSegments(p);
    const scenes = new Map(p.scenes.map((scene) => [scene.id, scene]));
    const nodes = [...strip.querySelectorAll('.seq-bloco[data-kind="scene"], .seq-audio')];
    for (const node of nodes) {
      const scene = scenes.get(node.dataset.scene);
      const start = Number(node.dataset.start);
      const end = Number(node.dataset.end);
      const canvas = node.querySelector("canvas.seq-wave");
      if (!scene || !canvas || !(end > start)) continue;
      const sourceIds = [...new Set(scene.takes.map((take) => take.sourceId))];
      const fetched = await peaksDe(sourceIds);
      if (!vivo()) return;
      // O strip pode ter sido re-renderizado enquanto o fetch voava.
      if (!canvas.isConnected) continue;
      const bySource = new Map(sourceIds.map((id, i) => [id, fetched[i]]));
      const temOnda = [...bySource.values()].some(Boolean);
      marcar?.(node, temOnda, sourceIds);
      if (!temOnda) continue;
      const inBlock = segments.filter(
        (seg) => seg.montageEnd > start && seg.montageStart < end,
      );
      drawSceneWave(canvas, inBlock, bySource, start, end - start);
    }
  }

  /** Busca os peaks das fontes da cena e desenha os trechos retidos. */
  async function hydrateWaves(p) {
    if (!p || typeof fetch !== "function") return;
    const token = ++waveGen;
    const el = root();
    const strip = el && el.querySelector(".seq-strip");
    if (!strip) return;
    // Studio: sem peaks de nenhuma fonte da cena, o bloco diz por quê.
    const marcar = studio
      ? (node, temOnda, sourceIds) => {
        const falta = node.querySelector(".sem-dado");
        if (!falta) return;
        falta.hidden = temOnda;
        if (!temOnda) falta.textContent = motivoSemOnda(sourceIds, p);
      }
      : undefined;
    await drawBlocks(p, strip, (sourceIds) => Promise.all(sourceIds.map((id) => peaksFor(id))), () => token === waveGen, marcar);
  }

  /**
   * Desenha os segmentos retidos no canvas do bloco: cada coluna x mapeia
   * para um instante da montagem → trecho retido → bucket de peaks da
   * fonte. O comprimento de cada segmento segue a proporção do
   * timelineBlocks (o canvas ocupa exatamente o bloco da cena). A passada é
   * planejada por planSceneWave (segmentos bucketizados por pixel, métricas
   * por fonte em cache fora do loop); aqui só executa os fillRect.
   */
  function drawSceneWave(canvas, inBlock, bySource, blockStart, sceneDur) {
    // Revela antes de medir: o atributo hidden é display:none, e canvas
    // escondido tem clientWidth/Height 0 (nunca desenharía).
    canvas.hidden = false;
    const width = canvas.clientWidth || 0;
    const height = canvas.clientHeight || 0;
    if (width <= 0 || height <= 0 || inBlock.length === 0) return;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = (typeof getComputedStyle === "function" && getComputedStyle(canvas).color) || "#888";
    for (const op of planSceneWave(inBlock, bySource, blockStart, sceneDur, width, height)) {
      ctx.fillRect(op.x, op.top, 1, op.h);
    }
  }

  /**
   * Linha do playhead + bloco aceso, sem re-render. `acompanhar` vem só do
   * playhead em movimento: o redesenho e o zoom não puxam a vista.
   */
  function paint(playhead, acompanhar = false) {
    const el = root();
    const strip = el && el.querySelector(".seq-strip");
    if (!strip) return;
    // Com o gesto, os blocos seguram a ordem de quando pegou: o realce segue eles.
    const p = gesto?.projeto ?? state.get("project");
    const duration = p ? montageDuration(p) : 0;
    const line = strip.querySelector(".seq-playhead");
    const valid = p && Number.isFinite(playhead) && playhead != null && duration > 0;
    line.hidden = !valid;
    if (valid) {
      const ratio = Math.min(1, Math.max(0, playhead / duration));
      line.style.left = (ratio * 100).toFixed(3) + "%";
      strip.setAttribute("aria-valuenow", String(playhead));
    } else {
      strip.removeAttribute("aria-valuenow");
    }
    // Chip de timecode acima da linha (recriado a cada render da faixa).
    let chip = line.querySelector(".t");
    if (!chip) { chip = document.createElement("span"); chip.className = "t"; line.append(chip); }
    if (valid) chip.textContent = clockPrecise(playhead);
    const hit = valid ? blocksAt(p, playhead) : null;
    for (const node of strip.querySelectorAll(".seq-bloco")) {
      const on = !!hit && node.dataset.scene === hit.sceneId && node.dataset.kind === hit.kind;
      node.classList.toggle("ativa", on);
    }
    if (!studio) return;
    // O áudio que toca é o da cena, mesmo sob um apoio.
    const scene = valid ? activeScene(p, playhead) : null;
    for (const node of strip.querySelectorAll(".seq-audio")) node.classList.toggle("ativa", node.dataset.scene === scene);
    if (acompanhar && valid && !scrubbing && !gesto && player.el?.()?.paused === false) {
      seguir(strip, Math.min(1, Math.max(0, playhead / duration)));
    }
  }

  /** Studio com zoom: o playhead que sai da vista traz a rolagem junto. */
  function seguir(strip, ratio) {
    const rolagem = strip.closest(".faixa-rolagem");
    if (!rolagem || zoom() === 1) return;
    const largura = rolagem.scrollWidth;
    const vista = rolagem.clientWidth;
    if (!(largura > vista)) return;
    const x = ratio * largura;
    if (x < rolagem.scrollLeft || x > rolagem.scrollLeft + vista - 16) rolagem.scrollLeft = Math.max(0, x - vista * 0.25);
  }

  function seekRatio(ratio) {
    const p = state.get("project");
    if (!p) return;
    const seconds = seekFromRatio(p, ratio);
    state.set("selectedScene", activeScene(p, seconds));
    state.set("playhead", seconds);
    try {
      player.seek(seconds);
    } catch (err) {
      if (api && api.notifyError) api.notifyError((err && err.message) || String(err));
    }
  }

  function ratioOfEvent(strip, ev) {
    const rect = strip.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return (ev.clientX - rect.left) / rect.width;
  }

  // Durante o arraste a faixa não rola sozinha atrás do playhead.
  let scrubbing = false;

  /**
   * Pega a cena da alça (ponteiro ou teclado). Só com a faixa parada, sem
   * desfazer/refazer em voo e fora do Modo Leitura (alça desabilitada).
   * Guarda a revisão e a geometria da tela: é delas que o pedido parte.
   */
  function pegar(alca, modo, extra = {}) {
    const p = state.get("project");
    if (!studio || gesto || scrubbing || alca.disabled || !p || undoEdit.busy() || redoEdit.busy()) return null;
    const ids = p.scenes.map((scene) => scene.id);
    const blocos = timelineBlocks(p).filter((block) => block.kind === "scene");
    const duracao = montageDuration(p);
    const de = ids.indexOf(alca.dataset.alca);
    if (de < 0 || blocos.length !== ids.length || !(duracao > 0)) return null;
    gesto = { modo, projeto: p, ids, blocos, duracao, de, destino: de, sceneId: ids[de], alca, ativo: modo === "teclado", enviando: false, ...extra };
    document.addEventListener("keydown", escapeDoGesto, true);
    return gesto;
  }

  /** Esc cancela o gesto antes de qualquer outro atalho (gaveta, menu). */
  function escapeDoGesto(ev) {
    if (ev.key !== "Escape" || !gesto || gesto.enviando) return;
    ev.preventDefault();
    ev.stopPropagation();
    cancelarGesto("Movimento cancelado");
  }

  /** Bloco levantado, deslocado com o ponteiro, e a barra na fronteira de destino. */
  function pintarGesto() {
    const el = root();
    if (!gesto || !el) return;
    el.classList.add("reordenando");
    const bloco = [...el.querySelectorAll(".lane-video .seq-bloco")].find((node) => node.dataset.scene === gesto.sceneId);
    const desloca = gesto.modo === "ponteiro" && gesto.ativo ? "translateX(" + gesto.dx + "px)" : "";
    for (const node of [bloco, gesto.alca.closest(".alca-cena")]) {
      if (!node) continue;
      node.classList.add("arrastando");
      node.style.transform = desloca;
    }
    const barra = el.querySelector(".faixa-destino");
    const t = fronteiraDoDestino(gesto.blocos, gesto.de, gesto.destino);
    if (!barra) return;
    barra.hidden = t == null;
    if (t != null) barra.style.left = ((t / gesto.duracao) * 100).toFixed(3) + "%";
  }

  function limparGesto() {
    const el = root();
    if (!el) return;
    el.classList.remove("reordenando");
    for (const node of el.querySelectorAll(".arrastando")) {
      node.classList.remove("arrastando");
      node.style.transform = "";
    }
    const barra = el.querySelector(".faixa-destino");
    if (barra) barra.hidden = true;
  }

  /** Fim do gesto (cancelado, solto no lugar ou com a resposta): solta a guarda e redesenha. */
  function encerrarGesto() {
    const fim = gesto;
    if (!fim) return;
    gesto = null;
    document.removeEventListener("keydown", escapeDoGesto, true);
    if (fim.quadro && typeof cancelAnimationFrame === "function") cancelAnimationFrame(fim.quadro);
    if (fim.modo === "ponteiro" && fim.alca.hasPointerCapture?.(fim.pointerId)) fim.alca.releasePointerCapture(fim.pointerId);
    limparGesto();
    render(state.get("project"));
    // Sem redesenho (mesma assinatura), legenda e playhead seguram o que chegou no meio.
    pintarLegenda();
    paint(state.get("playhead"));
  }

  function cancelarGesto(aviso) {
    if (!gesto || gesto.enviando) return;
    const teclado = gesto.modo === "teclado";
    encerrarGesto();
    if (teclado && aviso) anunciar(aviso);
  }

  function anunciar(texto) {
    if (anuncio) anuncio.textContent = texto;
  }

  /**
   * Solta a cena: no mesmo lugar não envia nada; senão um pedido só, com a
   * ordem inteira e a revisão da tela (um 409 cai na reconciliação do
   * call()). A faixa segura o desenho até a resposta: sem prévia no estado.
   */
  async function soltar() {
    if (!gesto || gesto.enviando) return;
    const ordem = ordemMovida(gesto.ids, gesto.sceneId, gesto.destino);
    // Desfazer/refazer em voo mudam a base da tela: o pedido cairia num 409.
    if (!ordem || undoEdit.busy() || redoEdit.busy()) {
      cancelarGesto(ordem ? "Movimento cancelado" : "Cena no mesmo lugar");
      return;
    }
    gesto.enviando = true;
    const teclado = gesto.modo === "teclado";
    const movida = "Cena " + (gesto.de + 1) + " movida para a posição " + (gesto.destino + 1) + " de " + gesto.ids.length;
    let ok = false;
    try {
      ok = (await enviarOrdem(api, gesto.projeto, ordem))?.res?.ok === true;
    } catch {
      // call() já mostrou o erro na pílula de status; a faixa volta à verdade.
    } finally {
      encerrarGesto();
    }
    // Só a resposta do servidor diz que a cena mudou de lugar (409 e erro não).
    if (teclado) anunciar(ok ? movida : "A cena não mudou de lugar");
  }

  /** Destino e deslocamento a partir do último x do ponteiro (a rolagem na borda também chama). */
  function acompanharPonteiro() {
    const el = root();
    const strip = el?.querySelector(".seq-strip");
    if (!gesto || !strip) return;
    const rolagem = el.querySelector(".faixa-rolagem");
    const ratio = Math.min(1, Math.max(0, ratioOfEvent(strip, { clientX: gesto.clientX })));
    gesto.destino = destinoDoArraste(gesto.blocos, gesto.de, ratio * gesto.duracao);
    gesto.dx = gesto.clientX - gesto.x0 + (rolagem?.scrollLeft || 0) - gesto.rolagem0;
    pintarGesto();
  }

  /**
   * Com zoom, o ponteiro a ARRASTE_BORDA_PX da borda da vista rola a faixa,
   * mais rápido quanto mais perto, só para o lado em que ele anda desde que
   * pegou e nunca além de `maxRolagem` (medido no pegar: o bloco deslocado
   * alarga o scrollWidth e não pode puxar a vista para o vazio). Sem zoom
   * não há o que rolar.
   */
  function rolarNaBorda() {
    if (!gesto || gesto.modo !== "ponteiro" || gesto.enviando) return;
    const rolagem = root()?.querySelector(".faixa-rolagem");
    if (rolagem && gesto.maxRolagem > 0) {
      const rect = rolagem.getBoundingClientRect();
      const esquerda = gesto.clientX - rect.left;
      const direita = rect.right - gesto.clientX;
      const lado = gesto.clientX > gesto.x0 && direita < ARRASTE_BORDA_PX ? 1
        : gesto.clientX < gesto.x0 && esquerda < ARRASTE_BORDA_PX ? -1 : 0;
      if (lado) {
        const antes = rolagem.scrollLeft;
        const forca = Math.min(1, (ARRASTE_BORDA_PX - (lado > 0 ? direita : esquerda)) / ARRASTE_BORDA_PX);
        rolagem.scrollLeft = Math.min(gesto.maxRolagem, Math.max(0, antes + lado * Math.ceil(forca * 14)));
        if (rolagem.scrollLeft !== antes) acompanharPonteiro();
      }
    }
    gesto.quadro = requestAnimationFrame(rolarNaBorda);
  }

  function pegarComPonteiro(alca, ev) {
    if (ev.button !== 0) return;
    // Sem o padrão: nada de seleção de texto nem foco no meio do gesto.
    ev.preventDefault();
    const rolagem = root()?.querySelector(".faixa-rolagem");
    const trilhas = root()?.querySelector(".faixa-trilhas");
    // Limite da rolagem: a largura das trilhas, não o scrollWidth (a última
    // marca da régua já transborda alguns px no 1×).
    const maxRolagem = trilhas && rolagem ? trilhas.offsetWidth - rolagem.clientWidth : 0;
    if (!pegar(alca, "ponteiro", { pointerId: ev.pointerId, x0: ev.clientX, clientX: ev.clientX, dx: 0, rolagem0: rolagem?.scrollLeft || 0, maxRolagem })) return;
    alca.setPointerCapture?.(ev.pointerId);
  }

  function moverPonteiro(ev) {
    gesto.clientX = ev.clientX;
    if (!gesto.ativo) {
      if (Math.abs(ev.clientX - gesto.x0) < ARRASTE_LIMIAR_PX) return;
      gesto.ativo = true;
      if (typeof requestAnimationFrame === "function") gesto.quadro = requestAnimationFrame(rolarNaBorda);
    }
    acompanharPonteiro();
  }

  function soltarPonteiro(ev) {
    if (gesto.ativo) {
      gesto.clientX = ev.clientX;
      acompanharPonteiro();
      void soltar();
      return;
    }
    // Clique na alça sem arrastar: seleciona a cena, e a alça fica com o foco.
    const sceneId = gesto.sceneId;
    encerrarGesto();
    state.set("selectedScene", sceneId);
    state.set("selectedSupport", null);
    focarAlca(sceneId);
  }

  /**
   * Teclado na alça. Sem cena pega, as setas andam entre as alças e Espaço/
   * Enter pega; com ela, as setas, Home e End escolhem o destino e Espaço/
   * Enter solta (um pedido, por mais posições que ande). Esc cancela.
   */
  function teclaNaAlca(alca, ev) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End", "Enter", " "].includes(ev.key) || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    ev.preventDefault();
    const soltarOuPegar = ev.key === "Enter" || ev.key === " ";
    if (gesto) {
      if (gesto.modo !== "teclado" || gesto.enviando) return;
      if (soltarOuPegar) {
        void soltar();
        return;
      }
      const ultimo = gesto.ids.length - 1;
      gesto.destino = ev.key === "Home" ? 0 : ev.key === "End" ? ultimo
        : Math.min(ultimo, Math.max(0, gesto.destino + (ev.key === "ArrowRight" ? 1 : -1)));
      pintarGesto();
      anunciar(anuncioDoArraste(gesto.de + 1, gesto.destino, gesto.ids.length));
      return;
    }
    if (soltarOuPegar) {
      if (!pegar(alca, "teclado")) return;
      pintarGesto();
      anunciar(anuncioDoArraste(gesto.de + 1, gesto.destino, gesto.ids.length) + ". Setas escolhem o lugar, Espaço solta, Esc cancela.");
      return;
    }
    const alcas = [...root().querySelectorAll(".bloco-alca")];
    const i = alcas.indexOf(alca);
    const j = ev.key === "Home" ? 0 : ev.key === "End" ? alcas.length - 1
      : Math.min(alcas.length - 1, Math.max(0, i + (ev.key === "ArrowRight" ? 1 : -1)));
    focarAlca(alcas[j].dataset.alca);
  }

  function bind() {
    const el = root();
    if (!el || el.dataset.seqBound) return;
    el.dataset.seqBound = "1";
    let scrubMoved = false;
    let lastScrub = 0;
    el.addEventListener("keydown", (ev) => {
      const alca = studio ? ev.target.closest(".bloco-alca") : null;
      if (alca) {
        teclaNaAlca(alca, ev);
        return;
      }
      if (!ev.target.closest(".seq-strip") || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(ev.key)) return;
      ev.preventDefault();
      const p = state.get("project");
      const duration = p ? montageDuration(p) : 0;
      const current = state.get("playhead") || 0;
      const seconds = ev.key === "Home" ? 0 : ev.key === "End" ? duration : current + (ev.key === "ArrowRight" ? 1 : -1);
      seekRatio(duration ? seconds / duration : 0);
    });
    if (studio) {
      // Miniatura que não carrega (fonte sem quadro, erro) vira estado escrito.
      el.addEventListener("error", (ev) => {
        const img = ev.target;
        if (!img?.matches?.("img.timeline-thumb") || !img.parentElement) return;
        const falta = document.createElement("span");
        falta.className = "sem-dado";
        falta.textContent = "sem miniatura";
        img.parentElement.insertBefore(falta, img);
        img.remove();
      }, true);
    }
    el.addEventListener("click", (ev) => {
      const zoomButton = studio ? ev.target.closest("[data-zoom]") : null;
      if (zoomButton) {
        mudarZoom(Number(zoomButton.dataset.zoom));
        return;
      }
      // O clique que fecha um arraste chega depois do pointerup: ignora.
      if (scrubMoved) {
        scrubMoved = false;
        return;
      }
      const strip = ev.target.closest(".seq-strip");
      if (!strip) return;
      seekRatio(Math.min(1, Math.max(0, ratioOfEvent(strip, ev))));
      const block=ev.target.closest(".seq-bloco");
      if(block) {state.set("selectedScene",block.dataset.scene);state.set("selectedSupport",block.dataset.group||null);}
    });
    el.addEventListener("pointerdown", (ev) => {
      // A alça da cena é do arraste: não busca nem faz scrub.
      const alca = studio ? ev.target.closest(".bloco-alca") : null;
      if (alca) {
        pegarComPonteiro(alca, ev);
        return;
      }
      const strip = ev.target.closest(".seq-strip");
      if (!strip) return;
      scrubbing = true;
      scrubMoved = false;
      lastScrub = 0;
      const block = ev.target.closest(".seq-bloco");
      strip.setPointerCapture?.(ev.pointerId);
      seekRatio(Math.min(1, Math.max(0, ratioOfEvent(strip, ev))));
      // Captura retargeta o click para a faixa; selecione pelo alvo original.
      if (block) { state.set("selectedScene", block.dataset.scene); state.set("selectedSupport", block.dataset.group || null); }
    });
    el.addEventListener("pointermove", (ev) => {
      if (gesto?.modo === "ponteiro" && ev.pointerId === gesto.pointerId) {
        if (!gesto.enviando) moverPonteiro(ev);
        return;
      }
      if (!scrubbing) return;
      const now = Date.now();
      if (now - lastScrub < SCRUB_THROTTLE_MS) return;
      lastScrub = now;
      scrubMoved = true;
      const strip = ev.target.closest(".seq-strip") || el.querySelector(".seq-strip");
      if (!strip) return;
      seekRatio(Math.min(1, Math.max(0, ratioOfEvent(strip, ev))));
    });
    const stop = () => {
      scrubbing = false;
    };
    el.addEventListener("pointerup", stop);
    el.addEventListener("pointercancel", stop);
    if (!studio) return;
    const doGesto = (ev) => gesto?.modo === "ponteiro" && ev.pointerId === gesto.pointerId;
    el.addEventListener("pointerup", (ev) => {
      if (doGesto(ev) && !gesto.enviando) soltarPonteiro(ev);
    });
    // Captura perdida ou ponteiro cancelado (toque virou rolagem do sistema): cancela.
    el.addEventListener("pointercancel", (ev) => {
      if (doGesto(ev)) cancelarGesto();
    });
    el.addEventListener("lostpointercapture", (ev) => {
      if (doGesto(ev)) cancelarGesto();
    });
    // Tab ou clique fora tiram o foco da alça com a cena pega: cancela.
    el.addEventListener("focusout", (ev) => {
      if (gesto?.modo === "teclado" && ev.target === gesto.alca) cancelarGesto("Movimento cancelado");
    });
  }

  /**
   * Studio: o atalho só age com os botões à vista. Fora da Edição o #undoSlot
   * some (Materiais e Revisão escondem o texto, a Entrega o cabeçalho), e um
   * Ctrl+Z por hábito criaria revisão sem nada na tela e derrubaria a aprovação.
   */
  function historyShown() {
    const slot = document.getElementById("undoSlot");
    return !slot || typeof slot.getClientRects !== "function" || slot.getClientRects().length > 0;
  }

  // Atalhos document-level de desfazer e refazer (`historyKey`): ignoram foco
  // em campo editável para não roubar o desfazer/refazer nativo do texto.
  if (!undoKeyBound) {
    undoKeyBound = true;
    document.addEventListener("keydown", (ev) => {
      const kind = historyKey(ev, ui);
      if (!kind) return;
      if (ui === "studio" && !historyShown()) return;
      const target = ev.target;
      if (target instanceof HTMLElement) {
        if (target.isContentEditable) return;
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      }
      ev.preventDefault();
      // Arraste de cena em curso: o histórico espera o gesto acabar.
      if (gesto) return;
      void (kind === "redo" ? redoEdit() : undoEdit());
    });
  }

  /**
   * Studio: fora de Edição/Revisão a faixa fica display:none, e a waveform
   * hidratada ali não desenhou (canvas sem largura). Redesenha só com os
   * peaks já em cache: nenhum pedido novo, e sem tocar no waveGen, então
   * uma hidratação ainda em voo desenha sozinha quando chegar.
   */
  function redrawCachedWaves() {
    const p = state.get("project");
    const strip = root()?.querySelector(".seq-strip");
    if (!p || !strip) return;
    void drawBlocks(p, strip, (sourceIds) => sourceIds.map((id) => peaksCache.get(id) ?? null), () => true);
  }
  if (ui === "studio" && typeof ResizeObserver === "function" && root()) {
    let width = 0;
    new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width || 0);
      if (next === width) return;
      width = next;
      if (next > 0) {
        redrawCachedWaves();
        // A faixa apareceu ou mudou de largura: o agrupamento da legenda acompanha.
        pintarLegenda();
      }
    }).observe(root());
  }

  bind();
  if (studio) {
    state.subscribe("legendasFaixa", () => pintarLegenda());
    // A parada de Tab das alças acompanha a cena selecionada (texto, faixa ou playhead).
    state.subscribe("selectedScene", (sceneId) => {
      if (!gesto) alcaNoTab(sceneId);
    });
    state.subscribe("zoomSequencia", () => render(state.get("project")));
    // Fim da preparação: a onda que faltava pode ter sido gerada.
    let preparo = state.get("project")?.preparation?.status ?? null;
    state.subscribe("project", (p) => {
      const agora = p?.preparation?.status ?? null;
      if (agora === preparo) return;
      preparo = agora;
      if (faltas.size) void hydrateWaves(p);
    });
  }
  state.subscribe("undoRevision", () => render(state.get("project")));
  if (ui === "studio") state.subscribe("redoRevision", () => render(state.get("project")));
  state.subscribe("project", (p) => render(p));
  state.subscribe("playhead", (t) => paint(t, true));
  render(state.get("project"));
}
