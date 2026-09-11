// Faixa-bússola da sequência (Task 7): blocos proporcionais da montagem
// como navegação. Puras testáveis (blocksAt/activeScene/seekFromRatio);
// o DOM monta os blocos via timelineBlocks de montage.js, clique busca por
// ratio, arraste faz scrub com throttle e o playhead acende bloco + linha.
// Sem waveform até a Task 8 (reserva div.wave vazia).
import { montageDuration, timelineBlocks } from "./montage.js";

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

/** Intervalo entre seeks de scrub durante o arraste. */
export const SCRUB_THROTTLE_MS = 60;

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

  function render(p) {
    const el = root();
    if (!el) return;
    if (!p) {
      el.replaceChildren();
      return;
    }
    const blocks = timelineBlocks(p);
    const duration = montageDuration(p);
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
      return '<div class="seq-bloco' + (block.kind === "support" ? " seq-apoio" : "") + '"'
        + ' data-scene="' + esc(block.sceneId) + '" data-kind="' + esc(block.kind) + '"'
        + ' data-start="' + block.start + '" data-end="' + block.end + '"'
        + ' title="' + esc(title) + '"'
        + ' style="width:' + width.toFixed(3) + '%"></div>';
    }).join("")
      + '<div class="seq-playhead" hidden style="position:absolute;top:0;bottom:0;width:2px;"></div>'
      + '<div class="wave"></div>';
    el.replaceChildren(strip);
    paint(state.get("playhead"));
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

  bind();
  state.subscribe("project", (p) => render(p));
  state.subscribe("playhead", (t) => paint(t));
  render(state.get("project"));
}
