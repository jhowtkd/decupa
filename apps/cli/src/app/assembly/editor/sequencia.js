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
    if (!p || p.revision === 0) return;
    void api.call("/project/undo", {
      method: "POST",
      body: JSON.stringify({ baseRevision: p.revision, revision: p.revision - 1 }),
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
    undo.disabled = !p || p.revision === 0;
    undo.onclick = undoEdit;
    bar.appendChild(undo);
    return bar;
  }

  function render(p) {
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
    label.textContent = "Sequência";
    const total = document.createElement("span");
    total.className = "data total";
    total.textContent = duration.toFixed(1).replace(".", ",") + "s";
    head.append(label, total);
    // Régua: marcas nice (rulerTicks) distribuídas pela largura da faixa.
    const ruler = document.createElement("div");
    ruler.className = "ruler";
    for (const t of rulerTicks(duration)) {
      const s = document.createElement("span");
      s.textContent = t === 0 ? "0s" : String(t);
      ruler.append(s);
    }
    const strip = document.createElement("div");
    strip.className = "seq-strip";
    // Layout crítico inline (o tema segue em page.css, fora desta tarefa).
    strip.style.cssText = "position:relative;display:flex;width:100%;min-height:28px;cursor:pointer;";
    strip.setAttribute("role", "slider");
    strip.setAttribute("aria-label", "Sequência da montagem");
    strip.setAttribute("aria-valuemin", "0");
    strip.setAttribute("aria-valuemax", String(duration));
    strip.setAttribute("tabindex", "0");
    strip.innerHTML = blocks.map((block) => {
      const width = duration > 0 ? ((block.end - block.start) / duration) * 100 : 0;
      const title = block.label + " · " + block.start.toFixed(1) + "s–" + block.end.toFixed(1) + "s";
      // Só a cena ganha canvas de waveform; o apoio segue bloco puro.
      const wave = block.kind === "scene"
        ? '<canvas class="seq-wave" hidden style="position:absolute;inset:0;width:100%;height:100%;"></canvas>'
        : "";
      const pos = block.kind === "scene" ? "position:relative;overflow:hidden;" : "";
      return '<div class="seq-bloco' + (block.kind === "support" ? " seq-apoio" : "") + '"'
        + ' data-scene="' + esc(block.sceneId) + '" data-kind="' + esc(block.kind) + '"'
        + ' data-start="' + block.start + '" data-end="' + block.end + '"'
        + ' title="' + esc(title) + '"'
        + ' style="width:' + width.toFixed(3) + '%;' + pos + '">'
        + wave
        + '<span class="data dur">' + (block.end - block.start).toFixed(1).replace(".", ",") + "s</span>"
        + "</div>";
    }).join("")
      + '<div class="seq-playhead" hidden style="position:absolute;top:0;bottom:0;width:2px;"></div>';
    el.replaceChildren(head, ruler, strip, transportRow(p));
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
   * timelineBlocks (o canvas ocupa exatamente o bloco da cena).
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
    for (let x = 0; x < width; x++) {
      const montageT = blockStart + ((x + 0.5) / width) * sceneDur;
      const seg = inBlock.find(
        (s) => s.montageStart <= montageT && montageT < s.montageEnd,
      );
      if (!seg) continue;
      const peaks = bySource.get(seg.sourceId);
      if (!peaks || !Number.isFinite(peaks.sampleRate) || peaks.sampleRate <= 0) continue;
      const span = seg.montageEnd - seg.montageStart;
      const frac = span > 0 ? (montageT - seg.montageStart) / span : 0;
      const srcT = seg.srcStart + frac * (seg.srcEnd - seg.srcStart);
      const perBucket = peaks.count / peaks.peaks.length;
      if (!(perBucket > 0)) continue;
      const bucket = peaks.peaks[
        Math.min(peaks.peaks.length - 1, Math.max(0, Math.floor((srcT * peaks.sampleRate) / perBucket)))
      ];
      if (!bucket) continue;
      const yMax = height / 2 - (bucket.max / 32768) * (height / 2);
      const yMin = height / 2 - (bucket.min / 32768) * (height / 2);
      const top = Math.min(yMin, yMax);
      ctx.fillRect(x, top, 1, Math.max(1, Math.abs(yMax - yMin)));
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
    if (valid) chip.textContent = playhead.toFixed(1).replace(".", ",") + "s";
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
    el.addEventListener("click", (ev) => {
      // O clique que fecha um arraste chega depois do pointerup: ignora.
      if (scrubMoved) {
        scrubMoved = false;
        return;
      }
      const strip = ev.target.closest(".seq-strip");
      if (!strip) return;
      seekRatio(Math.min(1, Math.max(0, ratioOfEvent(strip, ev))));
    });
    el.addEventListener("pointerdown", (ev) => {
      const strip = ev.target.closest(".seq-strip");
      if (!strip) return;
      scrubbing = true;
      scrubMoved = false;
      lastScrub = 0;
      strip.setPointerCapture?.(ev.pointerId);
      seekRatio(Math.min(1, Math.max(0, ratioOfEvent(strip, ev))));
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
  state.subscribe("project", (p) => render(p));
  state.subscribe("playhead", (t) => paint(t));
  render(state.get("project"));
}
