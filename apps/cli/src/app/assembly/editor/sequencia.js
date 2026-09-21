// Faixa-bússola da sequência (Tasks 7–8): blocos proporcionais da montagem
// como navegação. Puras testáveis (blocksAt/activeScene/seekFromRatio);
// o DOM monta os blocos via timelineBlocks de montage.js, clique busca por
// ratio, arraste faz scrub com throttle e o playhead acende bloco + linha.
// O waveform (Task 8) compõe os trechos retidos sobre cada bloco de cena
// num <canvas>; apoio não entra (não tem áudio próprio) e sem peaks a
// faixa segue só com os blocos. O desfazer mora na faixa de transporte
// (botão ⎌ discreto + atalho Cmd/Ctrl+Z), desabilitado na revisão 0.
import { montageDuration, retainedSegments, timelineBlocks } from "./montage.js";

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

/** Guarda do atalho global de desfazer (o módulo monta uma vez por página). */
let undoKeyBound = false;

function esc(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

/**
 * Monta a faixa: blocos proporcionais, clique→seek, arraste→scrub,
 * playhead→linha + bloco .ativa. `player` expõe `seek(seconds)` e `el()`.
 */
export function mountSequencia({ state, api, player }) {
  const root = () => document.getElementById("faixa");

  /** Desfaz a última edição (mesmo POST do antigo botão do contexto). */
  function undoEdit() {
    const p = state.get("project");
    if (!p || state.get("undoRevision") == null) return;
    void api.call("/project/undo", {
      method: "POST",
      body: JSON.stringify({ baseRevision: p.revision, revision: state.get("undoRevision") }),
      label: "Desfazendo…",
    });
  }

  /** Faixa de transporte: botão ⎌ discreto ao lado da faixa, sem revisão 0. */
  function transportRow(p) {
    const bar = document.createElement("div");
    bar.className = "seq-transport";
    bar.style.cssText = "display:flex;gap:8px;align-items:center;";
    const undo = document.createElement("button");
    undo.type = "button";
    undo.id = "undo";
    undo.textContent = "⎌ Desfazer";
    undo.setAttribute("aria-label", "Desfazer edição");
    undo.title = "Desfazer edição";
    undo.disabled = !p || state.get("undoRevision") == null;
    if (undo.disabled) undo.title = "Nenhuma alteração com histórico para desfazer";
    undo.onclick = undoEdit;
    bar.appendChild(undo);
    return bar;
  }

  let signature = "";
  function render(p) {
    const next = JSON.stringify(p && [p.revision, p.scenes, p.assembly.sources, p.captions]);
    if (next === signature) return;
    signature = next;
    const el = root();
    if (!el) return;
    if (!p) {
      el.replaceChildren(transportRow(null));
      return;
    }
    const blocks = timelineBlocks(p);
    const duration = montageDuration(p);
    // Cabeçalho da faixa: rótulo do painel + total da montagem em mono.
    const head = document.createElement("div");
    head.className = "faixa-head";
    const label = document.createElement("span");
    label.className = "panel-label";
    label.textContent = "Timeline";
    const total = document.createElement("span");
    total.className = "data total";
    total.textContent = formatTimecode(duration);
    head.append(label, total);
    const count = document.createElement("span");
    count.className = "muted";
    count.textContent = p.scenes.length + " cenas · " + p.assembly.sources.filter((source) => source.included).length + " materiais";
    head.append(count, transportRow(p));
    if (!blocks.length) {
      const empty = document.createElement("div");
      empty.className = "timeline-empty";
      empty.innerHTML = '<span aria-hidden="true">▤</span><div><strong>Sua sequência aparece aqui</strong><p>Prepare os materiais para criar o primeiro corte.</p></div>';
      el.replaceChildren(head, empty);
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
      s.textContent = formatTimecode(t);
      s.style.left = duration > 0 ? ((t / duration) * 100).toFixed(3) + "%" : "0%";
      if (i === 0 || i === ticks.length - 1) s.style.transform = "none";
      ruler.append(s);
    });
    const strip = document.createElement("div");
    strip.className = "seq-strip";
    // Layout crítico inline (o tema segue em page.css, fora desta tarefa).
    strip.style.cssText = "position:relative;width:100%;min-height:154px;cursor:pointer;";
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
        ? '<img class="timeline-thumb" alt="" loading="lazy" src="/project/thumbnail/' + encodeURIComponent(source.id) + '">' : "";
      return '<div class="seq-bloco' + (block.kind === "support" ? " seq-apoio" : "") + '"'
        + ' data-scene="' + esc(block.sceneId) + '" data-kind="' + esc(block.kind) + '"'
        + ' data-group="' + esc(block.groupId || '') + '"'
        + ' data-start="' + block.start + '" data-end="' + block.end + '"'
        + ' title="' + esc(title) + '"'
        + ' style="width:' + width.toFixed(3) + '%;' + pos + '">'
        + thumb + '<span class="clip-label">' + esc(block.label) + "</span>" + wave
        + '<span class="data dur">' + (block.end - block.start).toFixed(1).replace(".", ",") + "s</span>"
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

  // Peaks por fonte com cache no tempo de vida do mount (a invalidação é
  // por sha no servidor; 204/erro vira null e o bloco segue sem waveform).
  const peaksCache = new Map();
  async function peaksFor(sourceId) {
    if (peaksCache.has(sourceId)) return peaksCache.get(sourceId);
    let peaks = null;
    try {
      const { res, body } = await api.call("/project/waveform/" + encodeURIComponent(sourceId));
      if (res && res.status !== 204 && res.ok && body && Array.isArray(body.peaks) && body.peaks.length > 0) {
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

  /** Busca os peaks das fontes da cena e desenha os trechos retidos. */
  async function hydrateWaves(p) {
    if (!p || !api || typeof api.call !== "function") return;
    const token = ++waveGen;
    const el = root();
    const strip = el && el.querySelector(".seq-strip");
    if (!strip) return;
    const segments = retainedSegments(p);
    const scenes = new Map(p.scenes.map((scene) => [scene.id, scene]));
    const nodes = [...strip.querySelectorAll('.seq-bloco[data-kind="scene"]')];
    for (const node of nodes) {
      const scene = scenes.get(node.dataset.scene);
      const start = Number(node.dataset.start);
      const end = Number(node.dataset.end);
      const canvas = node.querySelector("canvas.seq-wave");
      if (!scene || !canvas || !(end > start)) continue;
      const sourceIds = [...new Set(scene.takes.map((take) => take.sourceId))];
      const fetched = await Promise.all(sourceIds.map((id) => peaksFor(id)));
      if (token !== waveGen) return;
      // O strip pode ter sido re-renderizado enquanto o fetch voava.
      if (!canvas.isConnected) continue;
      const bySource = new Map(sourceIds.map((id, i) => [id, fetched[i]]));
      if (![...bySource.values()].some(Boolean)) continue;
      const inBlock = segments.filter(
        (seg) => seg.montageEnd > start && seg.montageStart < end,
      );
      drawSceneWave(canvas, inBlock, bySource, start, end - start);
    }
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
    if (valid) chip.textContent = formatTimecode(playhead);
    const hit = valid ? blocksAt(p, playhead) : null;
    for (const node of strip.querySelectorAll(".seq-bloco")) {
      const on = !!hit && node.dataset.scene === hit.sceneId && node.dataset.kind === hit.kind;
      node.classList.toggle("ativa", on);
    }
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

  function bind() {
    const el = root();
    if (!el || el.dataset.seqBound) return;
    el.dataset.seqBound = "1";
    let scrubbing = false;
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
    el.addEventListener("click", (ev) => {
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
      undoEdit();
    });
  }

  bind();
  state.subscribe("undoRevision", () => render(state.get("project")));
  state.subscribe("project", (p) => render(p));
  state.subscribe("playhead", (t) => paint(t));
  render(state.get("project"));
}
