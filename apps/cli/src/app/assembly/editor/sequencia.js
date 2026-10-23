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
// ele falta ("sem miniatura", "sem onda", "sem áudio").
import { clock, clockPrecise, formatChip } from "./format.js";
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

/** Zoom da faixa do studio (largura das trilhas sobre a área visível). */
export const ZOOMS = [1, 2, 4, 8];

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

/** Estado da trilha de legenda sem cues (puro): o porquê, nunca vazio mudo. */
export function legendaVazia(legendas, project) {
  if (!legendas || legendas.revision !== project?.revision || legendas.estado === "carregando") return "carregando legenda…";
  if (legendas.estado === "sem-fala") return "sem fala retida";
  return "sem legenda";
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

/**
 * Botão de desfazer (puro): anuncia o passo do topo da pilha do servidor
 * (`project.undo`). Só libera quando o GET confirmou a mesma foto
 * (`undoRevision`); pilha quebrada ou foto ilegível deixam travado.
 * @returns {{ disabled: boolean, busy: boolean, title: string, text: string }}
 */
export function undoView(project, undoRevision, busy) {
  const undo = project?.undo;
  const top = undo && undo.head === project.revision ? undo.steps[undo.steps.length - 1] : null;
  if (busy) return { disabled: true, busy: true, title: "Desfazendo…", text: top ? top.label : "" };
  if (!top || undoRevision == null || top.revision !== undoRevision) {
    return { disabled: true, busy: false, title: "Nenhuma alteração com histórico para desfazer", text: "" };
  }
  return { disabled: false, busy: false, title: "Desfazer: " + top.label, text: top.label };
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
    if (!p || undoView(p, state.get("undoRevision"), false).disabled) return undefined;
    return api.call("project/undo", {
      method: "POST",
      body: JSON.stringify({ baseRevision: p.revision, revision: state.get("undoRevision") }),
      label: "Desfazendo…",
    });
  }, () => placeUndo(state.get("project")));

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
    undo.disabled = view.disabled;
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

  const studio = ui === "studio";
  const zoom = () => zoomValido(state.get("zoomSequencia"));

  let signature = "";
  function render(p) {
    // O botão vive fora da faixa: atualiza mesmo quando o desenho não muda.
    placeUndo(p);
    const next = JSON.stringify(p && (studio
      ? [p.revision, p.scenes, p.assembly.sources, state.get("legendasFaixa"), zoom()]
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
    const legendas = state.get("legendasFaixa");
    const cues = cuesDaFaixa(legendas, p);
    const legenda = cues.length
      ? cues.map((cue) => '<span class="seq-cue" title="' + esc(cue.text) + '" style="left:' + pct(cue.start)
        + ";width:" + pct(Math.max(0, cue.end - cue.start)) + ';">' + esc(cue.text) + "</span>").join("")
      : '<span class="lane-vazia">' + legendaVazia(legendas, p) + "</span>";
    const strip = document.createElement("div");
    strip.className = "seq-strip";
    strip.style.cssText = "position:relative;width:100%;cursor:pointer;";
    strip.setAttribute("role", "slider");
    strip.setAttribute("aria-label", "Sequência da montagem");
    strip.setAttribute("aria-valuemin", "0");
    strip.setAttribute("aria-valuemax", String(duration));
    strip.setAttribute("tabindex", "0");
    const lane = (nome, inner) => '<div class="seq-lane lane-' + nome + '">' + inner + "</div>";
    strip.innerHTML = lane("video", video) + lane("apoio", apoio) + lane("audio", audio) + lane("legenda", legenda)
      + '<div class="seq-playhead" hidden style="position:absolute;top:0;bottom:0;width:2px;"></div>';
    const rotulos = document.createElement("div");
    rotulos.className = "faixa-rotulos";
    rotulos.setAttribute("aria-hidden", "true");
    rotulos.innerHTML = '<span class="rotulo-regua"></span><span>Vídeo</span><span>Apoio</span><span>Áudio</span><span>Legenda</span>';
    const trilhas = document.createElement("div");
    trilhas.className = "faixa-trilhas";
    trilhas.style.width = z * 100 + "%";
    trilhas.append(ruler, strip);
    const rolagem = document.createElement("div");
    rolagem.className = "faixa-rolagem";
    rolagem.append(trilhas);
    const corpo = document.createElement("div");
    corpo.className = "faixa-corpo";
    corpo.append(rotulos, rolagem);
    // O redesenho (zoom, revisão nova) mantém o centro da vista e o foco do zoom.
    const antes = el.querySelector(".faixa-rolagem");
    const centro = antes && antes.scrollWidth > 0 ? (antes.scrollLeft + antes.clientWidth / 2) / antes.scrollWidth : null;
    const foco = document.activeElement?.closest?.("[data-zoom]")?.dataset.zoom;
    el.replaceChildren(head, corpo);
    if (Number.isFinite(centro) && rolagem.scrollWidth > 0) {
      rolagem.scrollLeft = Math.max(0, centro * rolagem.scrollWidth - rolagem.clientWidth / 2);
    }
    if (foco) {
      const botoes = [...el.querySelectorAll("[data-zoom]")];
      (botoes.find((item) => item.dataset.zoom === foco && !item.disabled) || botoes.find((item) => !item.disabled))?.focus();
    }
    paint(state.get("playhead"));
    void hydrateWaves(p);
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
  const peaksCache = new Map();
  async function peaksFor(sourceId) {
    if (peaksCache.has(sourceId)) return peaksCache.get(sourceId);
    let peaks = null;
    try {
      const res = await fetch(projectPath("project/waveform/" + encodeURIComponent(sourceId)), {
        headers: projectHeaders(),
      });
      const body = res.ok && res.status !== 204 ? await res.json() : null;
      if (body && Array.isArray(body.peaks) && body.peaks.length > 0) {
        peaks = body;
      }
    } catch {
      peaks = null;
    }
    peaksCache.set(sourceId, peaks);
    return peaks;
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
      marcar?.(node, temOnda);
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
    // Studio: sem peaks de nenhuma fonte da cena, o bloco diz "sem onda".
    const marcar = studio
      ? (node, temOnda) => { const falta = node.querySelector(".sem-dado"); if (falta) falta.hidden = temOnda; }
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

  /** Linha do playhead + bloco aceso, sem re-render. */
  function paint(playhead) {
    const el = root();
    const strip = el && el.querySelector(".seq-strip");
    if (!strip) return;
    const p = state.get("project");
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
    if (valid && !scrubbing) seguir(strip, Math.min(1, Math.max(0, playhead / duration)));
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

  function bind() {
    const el = root();
    if (!el || el.dataset.seqBound) return;
    el.dataset.seqBound = "1";
    let scrubMoved = false;
    let lastScrub = 0;
    el.addEventListener("keydown", (ev) => {
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
  }

  // Atalho document-level Cmd/Ctrl+Z: ignora foco em campo editável para
  // não roubar o desfazer nativo do texto.
  if (!undoKeyBound) {
    undoKeyBound = true;
    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "z" && ev.key !== "Z") return;
      if (!ev.metaKey && !ev.ctrlKey) return;
      if (ev.shiftKey || ev.altKey) return;
      const target = ev.target;
      if (target instanceof HTMLElement) {
        if (target.isContentEditable) return;
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      }
      ev.preventDefault();
      void undoEdit();
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
      if (next > 0) redrawCachedWaves();
    }).observe(root());
  }

  bind();
  if (studio) {
    state.subscribe("legendasFaixa", () => render(state.get("project")));
    state.subscribe("zoomSequencia", () => render(state.get("project")));
  }
  state.subscribe("undoRevision", () => render(state.get("project")));
  state.subscribe("project", (p) => render(p));
  state.subscribe("playhead", (t) => paint(t));
  render(state.get("project"));
}
