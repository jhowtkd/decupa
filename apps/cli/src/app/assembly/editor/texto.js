// Região do texto (Task 6): os dois documentos do centro como timeline com
// gestos de edição no ponto e menu flutuante. Lógica de menu pura e testável
// (menuActionsFor/sceneHeaderActions); o DOM só ancora gestos e dispara
// POST /project/edit (a sincronização do projeto volta pelo api.call do
// bootstrap, como nos outros módulos).
import {
  effectiveWords,
  montageTimeOfWord,
  omittedWords,
  retainedDuration,
  takeWords,
} from "./montage.js";

/** Contexto antes do trecho em "ouvir" — padrão JOIN_PAD da tela de limpeza. */
export const LISTEN_PAD = 0.7;

/**
 * @typedef {{ removed?: boolean, protected?: boolean, takeId?: string }} MenuWord
 * @typedef {{ action: string, label: string, danger?: boolean }} MenuAction
 * @typedef {{ kind: string, direction?: string, disabled: boolean, danger?: boolean }} HeaderAction
 */

/**
 * Ações do menu flutuante para a seleção (pura). Cada palavra informa
 * `{removed, protected, takeId}`; zona omitida usa takeId `""`.
 * Regras (spec, Interações 2): base ouvir/tirar/preservar/corrigir; tirar
 * vira restaurar quando tudo está removido; preservar vira liberar quando
 * tudo está protegido; mistura mantida+removida omite tirar (ambíguo:
 * metade cortaria, metade voltaria); zona omitida vira ouvir/incluir.
 * @param {MenuWord[]} selection
 * @returns {MenuAction[]}
 */
export function menuActionsFor(selection) {
  const words = [...(selection || [])];
  if (!words.length) return [];
  if (words.every((word) => (word.takeId ?? "") === "")) {
    return [
      { action: "ouvir", label: "Ouvir" },
      { action: "incluir", label: "Incluir" },
    ];
  }
  const anyRemoved = words.some((word) => !!word.removed);
  const allRemoved = words.every((word) => !!word.removed);
  const allProtected = words.every((word) => !!word.protected);
  const items = [{ action: "ouvir", label: "Ouvir" }];
  if (!anyRemoved) items.push({ action: "tirar", label: "Tirar", danger: true });
  else if (allRemoved) items.push({ action: "restaurar", label: "Restaurar" });
  items.push(allProtected
    ? { action: "liberar", label: "Liberar" }
    : { action: "preservar", label: "Preservar" });
  items.push({ action: "corrigir", label: "Corrigir" });
  return items;
}

/**
 * Controles do cabeçalho de cena (puro): mover ↥↧ desabilita nos extremos,
 * excluir ✕ segue sempre disponível (rota direta move-scene/delete-scene).
 * @returns {HeaderAction[]}
 */
export function sceneHeaderActions(index, total) {
  return [
    { kind: "move", direction: "up", disabled: index <= 0 },
    { kind: "move", direction: "down", disabled: index >= total - 1 },
    { kind: "delete", disabled: false, danger: true },
  ];
}

/**
 * Chave da ocorrência editorial selecionada (mesma serialização do contexto):
 * cena/take/palavra; zona omitida usa takeId "" (R3).
 */
export function selectionKey(sceneId, takeId, wordId) {
  return sceneId + "\0" + takeId + "\0" + wordId;
}

/**
 * Novo conjunto de seleção sem as ocorrências que saíram do catálogo (puro;
 * ex.: correção alinhada). Inclui as zonas omitidas, que são selecionáveis
 * para o menu ouvir/incluir.
 */
export function pruneSelection(p, selection) {
  const known = new Set();
  for (const scene of p.scenes) {
    for (const take of scene.takes) {
      for (const word of takeWords(p, scene, take)) {
        known.add(selectionKey(scene.id, take.id, word.id));
      }
    }
    for (const source of p.assembly.sources) {
      for (const word of omittedWords(p, scene, source.id)) {
        known.add(selectionKey(scene.id, "", word.id));
      }
    }
  }
  const next = new Set();
  for (const key of selection || []) {
    if (known.has(key)) next.add(key);
  }
  return next;
}

/**
 * Grupo de um mesmo trecho para as ações por palavra (puro): um único
 * take — ou uma única zona omitida (take null + sourceId, para incluir).
 * Vários grupos → null (o chamador avisa para refinar a seleção).
 */
export function selectedTake(project, selection) {
  const groups = new Map();
  for (const scene of project.scenes) {
    for (const take of scene.takes) {
      const prefix = scene.id + "\0" + take.id + "\0";
      const catalog = new Map(takeWords(project, scene, take).map((word) => [word.id, word]));
      const words = [];
      for (const key of selection || []) {
        if (!key.startsWith(prefix)) continue;
        const word = catalog.get(key.slice(prefix.length));
        if (word) words.push(word);
      }
      if (words.length) {
        groups.set(scene.id + "\0" + take.id, { scene, take, sourceId: take.sourceId, words });
      }
    }
    const bySource = new Map();
    for (const source of project.assembly.sources) {
      for (const word of omittedWords(project, scene, source.id)) {
        if (selection && selection.has(selectionKey(scene.id, "", word.id))) {
          if (!bySource.has(source.id)) bySource.set(source.id, []);
          bySource.get(source.id).push(word);
        }
      }
    }
    for (const [sourceId, words] of bySource) {
      groups.set(scene.id + "\0\0" + sourceId, { scene, take: null, sourceId, words });
    }
  }
  return groups.size === 1 ? groups.values().next().value : null;
}

/** Início da cena na montagem (soma das falas retidas das anteriores). */
export function sceneMontageStart(project, sceneId) {
  let cursor = 0;
  for (const scene of project.scenes) {
    if (scene.id === sceneId) return cursor;
    for (const take of scene.takes) cursor += retainedDuration(take);
  }
  return cursor;
}

/** Instante do apoio na montagem: início da cena + offset em frames. */
export function supportMontageStart(project, scene, support) {
  const fps = project.assembly.fps.num / project.assembly.fps.den;
  return sceneMontageStart(project, scene.id) + support.offsetFrames / fps;
}

/* ---- Render (os dois documentos do spec, portados do bootstrap) ---- */

function esc(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

function sourceName(p, id) {
  const found = p.assembly.sources.find((item) => item.id === id);
  return found ? found.name : id;
}

function renderTranscript(p) {
  const running = p.preparation && p.preparation.status === "running";
  let html = "";
  for (const source of p.assembly.sources) {
    const analysis = p.analyses.find((item) => item.sourceId === source.id);
    const statusText = analysis ? analysis.status : "na fila";
    html += '<section class="doc-source"><h2>' + esc(source.name) + " · " + esc(statusText)
      + (running ? ' <span class="parcial">· parcial</span>' : "") + "</h2>";
    const words = effectiveWords(p, source.id);
    if (!words.length) {
      html += '<p class="muted">transcrição ainda não disponível.</p>';
    } else {
      html += '<p class="prose">' + words.map((w) => esc(w.text)).join(" ") + "</p>";
    }
    html += "</section>";
  }
  return html;
}

function wordButton(scene, takeId, word, selection, extraClass = "", extraAttrs = "") {
  const key = selectionKey(scene.id, takeId, word.id);
  return '<button type="button" class="word'
    + (word.removed ? " riscado" : "")
    + (word.protected ? " protected" : "")
    + (word.corrected ? " corrected" : "") + extraClass + '"'
    + ' data-word-id="' + esc(word.id) + '"'
    + ' data-scene="' + esc(scene.id) + '"'
    + ' data-take="' + esc(takeId) + '"' + extraAttrs
    + ' aria-pressed="' + (selection.has(key) ? "true" : "false") + '"'
    + ' aria-label="' + esc(word.text + (word.removed ? " (removida)" : "")) + '"'
    + ">" + esc(word.display || word.text) + "</button>";
}

function chipHtml(p, scene, support, index) {
  const fps = p.assembly.fps.num / p.assembly.fps.den;
  const at = sceneMontageStart(p, scene.id) + support.offsetFrames / fps;
  const dur = support.durationFrames / fps;
  return '<button type="button" class="chip-apoio"'
    + ' data-scene="' + esc(scene.id) + '" data-support="' + index + '"'
    + ' title="apoio em ' + at.toFixed(1) + "s da montagem · " + dur.toFixed(1) + 's"'
    + ' aria-label="Apoio ' + esc(sourceName(p, support.visualId)) + ", seleciona a cena" + '"'
    + ">🎬 " + esc(sourceName(p, support.visualId)) + " · " + dur.toFixed(1) + "s</button>";
}

function renderProse(p, selection) {
  let html = "";
  let cursor = 0;
  p.scenes.forEach((scene, index) => {
    const sceneStart = cursor;
    for (const take of scene.takes) cursor += retainedDuration(take);
    const [up, down] = sceneHeaderActions(index, p.scenes.length);
    html += '<section class="scene" data-scene-section="' + esc(scene.id) + '">';
    html += '<p class="scene-head"><span>Cena ' + (index + 1)
      + (scene.objective ? " · " + esc(scene.objective) : "") + "</span> "
      + '<button type="button" data-scene-action="up" data-scene="' + esc(scene.id) + '"'
      + (up.disabled ? " disabled" : "")
      + ' aria-label="Mover cena ' + (index + 1) + ' para cima">↥</button>'
      + '<button type="button" data-scene-action="down" data-scene="' + esc(scene.id) + '"'
      + (down.disabled ? " disabled" : "")
      + ' aria-label="Mover cena ' + (index + 1) + ' para baixo">↧</button>'
      + '<button type="button" data-scene-action="delete" data-scene="' + esc(scene.id) + '"'
      + ' aria-label="Excluir cena ' + (index + 1) + '">✕</button></p>';
    if (scene.rationale) html += '<p class="muted">' + esc(scene.rationale) + "</p>";
    if (scene.gaps.length) {
      html += '<p class="warn">lacunas: ' + esc(scene.gaps.join("; ")) + "</p>";
    }
    // Âncoras de apoio: índice plano da primeira palavra com tempo de
    // montagem >= início do apoio; sem palavra depois, cai no fim da cena.
    const flat = [];
    for (const take of scene.takes) {
      for (const word of takeWords(p, scene, take)) {
        flat.push({ takeId: take.id, time: montageTimeOfWord(p, scene.id, take.id, word) });
      }
    }
    const anchors = new Map();
    scene.support
      .map((support, i) => ({ support, i, t: supportMontageStart(p, scene, support) }))
      .sort((a, b) => a.t - b.t)
      .forEach((chip) => {
        let at = flat.findIndex((entry) => entry.time != null && entry.time >= chip.t);
        if (at < 0) at = flat.length;
        if (!anchors.has(at)) anchors.set(at, []);
        anchors.get(at).push(chip);
      });
    const chipAt = (pos) => (anchors.get(pos) || [])
      .map((chip) => chipHtml(p, scene, chip.support, chip.i) + " ").join("");
    let pos = 0;
    for (const take of scene.takes) {
      const source = p.assembly.sources.find((item) => item.id === take.sourceId);
      html += '<div class="take"><div class="src">' + esc(source ? source.name : take.sourceId)
        + " · " + take.start.toFixed(1) + "s–" + take.end.toFixed(1) + "s</div><p class=\"prose\">";
      for (const word of takeWords(p, scene, take)) {
        html += chipAt(pos) + wordButton(scene, take.id, word, selection) + " ";
        pos += 1;
      }
      html += "</p></div>";
    }
    html += chipAt(pos);
    // Zonas omitidas (fora da montagem): takeId "" → menu ouvir/incluir.
    for (const source of p.assembly.sources) {
      const missing = omittedWords(p, scene, source.id);
      if (!missing.length) continue;
      html += '<div class="omit"><div class="src">' + esc(source.name)
        + " · fora da montagem</div><p class=\"prose\">";
      for (const word of missing) {
        html += wordButton(scene, "", word, selection, " omit",
          ' data-source="' + esc(source.id) + '"') + " ";
      }
      html += "</p></div>";
    }
    html += "</section>";
  });
  return html;
}

function renderCenter(p, selection) {
  const texto = document.getElementById("texto");
  const dropzone = document.getElementById("dropzone");
  if (!p || !texto || !dropzone) return;
  // Preservação de foco (V8): a palavra focada volta após o re-render.
  const focused = document.activeElement?.dataset;
  const focusedKey = focused && focused.wordId !== undefined
    ? { scene: focused.scene || "", take: focused.take || "", word: focused.wordId }
    : null;
  if (p.assembly.sources.length === 0) {
    dropzone.hidden = false;
    texto.hidden = true;
    texto.replaceChildren();
    return;
  }
  dropzone.hidden = true;
  texto.hidden = false;
  texto.innerHTML = p.scenes.length === 0 ? renderTranscript(p) : renderProse(p, selection);
  if (focusedKey) {
    texto.querySelector(
      `[data-scene="${CSS.escape(focusedKey.scene)}"][data-take="${CSS.escape(focusedKey.take)}"]`
      + `[data-word-id="${CSS.escape(focusedKey.word)}"]`,
    )?.focus();
  }
}

/** Atualiza aria-pressed sem re-render (gestos mantêm o DOM). */
function paintSelection(root, selection) {
  for (const btn of root.querySelectorAll("button.word")) {
    const key = selectionKey(btn.dataset.scene, btn.dataset.take, btn.dataset.wordId);
    btn.setAttribute("aria-pressed", selection.has(key) ? "true" : "false");
  }
}

/**
 * Ocorrências selecionadas com fonte e tempos (para "ouvir" atravessar
 * takes; as ações de corte exigem selectedTake de grupo único).
 */
function collectSelected(project, selection) {
  const out = [];
  for (const scene of project.scenes) {
    for (const take of scene.takes) {
      const prefix = scene.id + "\0" + take.id + "\0";
      const catalog = new Map(takeWords(project, scene, take).map((word) => [word.id, word]));
      for (const key of selection || []) {
        if (!key.startsWith(prefix)) continue;
        const word = catalog.get(key.slice(prefix.length));
        if (word) out.push({ word, sourceId: take.sourceId });
      }
    }
    for (const source of project.assembly.sources) {
      for (const word of omittedWords(project, scene, source.id)) {
        if (selection && selection.has(selectionKey(scene.id, "", word.id))) {
          out.push({ word, sourceId: source.id });
        }
      }
    }
  }
  return out;
}

/** Bandeiras da seleção no formato que menuActionsFor entende. */
function selectedFlags(project, selection) {
  const flags = [];
  for (const scene of project.scenes) {
    for (const take of scene.takes) {
      for (const word of takeWords(project, scene, take)) {
        if (selection.has(selectionKey(scene.id, take.id, word.id))) {
          flags.push({ removed: !!word.removed, protected: !!word.protected, takeId: take.id });
        }
      }
    }
    for (const source of project.assembly.sources) {
      for (const word of omittedWords(project, scene, source.id)) {
        if (selection.has(selectionKey(scene.id, "", word.id))) {
          flags.push({ removed: false, protected: false, takeId: "" });
        }
      }
    }
  }
  return flags;
}

const WORD_ACTION = { tirar: "remove", restaurar: "restore", preservar: "protect", liberar: "unprotect" };
const WORD_ACTION_LABEL = {
  remove: "Removendo trecho…",
  restore: "Restaurando trecho…",
  protect: "Preservando trecho…",
  unprotect: "Liberando trecho…",
  include: "Incluindo trecho…",
};

/** Limiar de arraste: até 6px é clique; além disso, seleção por retângulo. */
const DRAG_PX = 6;

/**
 * Monta a região do texto: renderiza os documentos e instala os gestos
 * (spec, Interações 1-5). Clique em mantida só busca; riscado restaura na
 * hora; arraste abre o menu ancorado; cabeçalho move/exclui a cena.
 */
export function mountTexto({ state, api, player }) {
  const root = () => document.getElementById("texto");
  let drag = null;
  let suppressClick = false;
  let closeMenu = null;

  const selection = () => state.get("selection") || new Set();

  function render(p) {
    if (!p) return;
    renderCenter(p, selection());
  }

  function findWord(btn) {
    const p = state.get("project");
    if (!p) return null;
    const scene = p.scenes.find((item) => item.id === btn.dataset.scene);
    const take = scene?.takes.find((item) => item.id === btn.dataset.take);
    if (!scene || !take) return null;
    const word = takeWords(p, scene, take).find((item) => item.id === btn.dataset.wordId);
    return word ? { scene, take, word } : null;
  }

  function selectScene(sceneId) {
    const p = state.get("project");
    if (!p) return;
    const scene = p.scenes.find((item) => item.id === sceneId);
    if (!scene) return;
    const next = new Set();
    for (const take of scene.takes) {
      for (const word of takeWords(p, scene, take)) {
        next.add(selectionKey(scene.id, take.id, word.id));
      }
    }
    state.set("selection", next);
    const el = root();
    if (el) paintSelection(el, next);
  }

  /** "Ouvir": a fonte original com 0.7s de contexto (fragmento #t=ini,fim). */
  function listenSelection() {
    const p = state.get("project");
    if (!p) return;
    const found = collectSelected(p, selection());
    if (!found.length) {
      api.notifyError("Selecione palavras de um mesmo trecho.");
      return;
    }
    const start = Math.min(...found.map((entry) => entry.word.start));
    const end = Math.max(...found.map((entry) => entry.word.end));
    const el = player.el();
    if (!el) return;
    el.src = "/project/media/" + encodeURIComponent(found[0].sourceId)
      + "?view=playback#t=" + Math.max(0, start - LISTEN_PAD).toFixed(2) + "," + end.toFixed(2);
    el.removeAttribute("data-rev");
    el.play().catch(() => {});
  }

  async function runMenuAction(action) {
    const p = state.get("project");
    if (!p) return;
    if (action === "ouvir") {
      listenSelection();
      return;
    }
    if (action === "corrigir") {
      // O campo mora no contexto; a seleção já está no estado para ele.
      document.getElementById("correctText")?.focus();
      return;
    }
    const group = selectedTake(p, selection());
    if (!group) {
      api.notifyError("Selecione palavras de um mesmo trecho.");
      return;
    }
    const ordered = group.words.slice().sort((a, b) => a.start - b.start);
    const wordIds = ordered.map((word) => word.id);
    if (action === "incluir") {
      if (group.take) {
        api.notifyError("Este trecho já está na montagem.");
        return;
      }
      await api.call("/project/edit", {
        method: "POST",
        body: JSON.stringify({
          baseRevision: p.revision,
          action: { type: "include", sceneId: group.scene.id, sourceId: group.sourceId, wordIds },
        }),
        label: WORD_ACTION_LABEL.include,
      });
      return;
    }
    const type = WORD_ACTION[action];
    if (!type || !group.take) {
      api.notifyError("Selecione palavras de um mesmo trecho.");
      return;
    }
    await api.call("/project/edit", {
      method: "POST",
      body: JSON.stringify({
        baseRevision: p.revision,
        action: { type, sceneId: group.scene.id, takeId: group.take.id, wordIds },
      }),
      label: WORD_ACTION_LABEL[type],
    });
  }

  function openSelectionMenu(anchorRect) {
    if (closeMenu) closeMenu();
    const p = state.get("project");
    if (!p) return;
    const items = menuActionsFor(selectedFlags(p, selection()));
    if (!items.length) return;
    const menu = document.createElement("div");
    menu.className = "texto-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Ações do trecho");
    menu.style.cssText = "position:fixed;z-index:30;display:flex;gap:4px;padding:6px;"
      + "border-radius:8px;background:var(--panel,#1d2429);border:1px solid var(--line,#333);"
      + "box-shadow:0 4px 16px rgba(0,0,0,.4);";
    menu.style.left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - 260)) + "px";
    const below = anchorRect.bottom + 6;
    menu.style.top = (below + 60 > window.innerHeight
      ? Math.max(8, anchorRect.top - 60) : below) + "px";
    for (const item of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = item.label;
      btn.setAttribute("role", "menuitem");
      btn.onclick = () => {
        if (closeMenu) closeMenu();
        void runMenuAction(item.action);
      };
      menu.appendChild(btn);
    }
    document.body.appendChild(menu);
    const onDoc = (ev) => {
      if (!menu.contains(ev.target) && closeMenu) closeMenu();
    };
    const onKey = (ev) => {
      if (ev.key === "Escape" && closeMenu) closeMenu();
    };
    document.addEventListener("pointerdown", onDoc);
    document.addEventListener("keydown", onKey);
    closeMenu = () => {
      closeMenu = null;
      document.removeEventListener("pointerdown", onDoc);
      document.removeEventListener("keydown", onKey);
      menu.remove();
    };
    menu.querySelector("button")?.focus();
  }

  async function sceneEdit(btn) {
    const p = state.get("project");
    if (!p) return;
    const { sceneAction, scene } = btn.dataset;
    if (sceneAction === "delete") {
      await api.call("/project/edit", {
        method: "POST",
        body: JSON.stringify({ baseRevision: p.revision, action: { type: "delete-scene", sceneId: scene } }),
        label: "Excluindo cena…",
      });
      return;
    }
    await api.call("/project/edit", {
      method: "POST",
      body: JSON.stringify({
        baseRevision: p.revision,
        action: { type: "move-scene", sceneId: scene, direction: sceneAction === "up" ? "up" : "down" },
      }),
      label: "Movendo cena…",
    });
  }

  function onClick(ev) {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    const el = root();
    if (!el) return;
    const sceneBtn = ev.target.closest("[data-scene-action]");
    if (sceneBtn && el.contains(sceneBtn)) {
      void sceneEdit(sceneBtn);
      return;
    }
    const chip = ev.target.closest(".chip-apoio");
    if (chip && el.contains(chip)) {
      // Chip é localizador, não alça: seleciona a cena (o contexto opera
      // sobre ela e o pedido NL muda o apoio); sem seek e sem edição.
      selectScene(chip.dataset.scene);
      return;
    }
    const btn = ev.target.closest("button.word");
    if (!btn || !el.contains(btn)) return;
    if (btn.dataset.take === "") {
      // Zona omitida fora da montagem: clique seleciona e abre o menu.
      const next = new Set([selectionKey(btn.dataset.scene, "", btn.dataset.wordId)]);
      state.set("selection", next);
      paintSelection(el, next);
      openSelectionMenu(btn.getBoundingClientRect());
      return;
    }
    if (btn.classList.contains("riscado")) {
      // Clique em cortado restaura na hora, sem seek (spec, Interação 3).
      const found = findWord(btn);
      if (!found) return;
      void api.call("/project/edit", {
        method: "POST",
        body: JSON.stringify({
          baseRevision: state.get("project").revision,
          action: {
            type: "restore",
            sceneId: found.scene.id,
            takeId: found.take.id,
            wordIds: [found.word.id],
          },
        }),
        label: WORD_ACTION_LABEL.restore,
      });
      return;
    }
    // Clique em mantida só busca na montagem, sem alternar seleção (1).
    const found = findWord(btn);
    if (!found) return;
    const t = montageTimeOfWord(state.get("project"), found.scene.id, found.take.id, found.word);
    if (t != null) {
      state.set("playhead", t);
      player.seek(t);
    }
  }

  function intersects(rect, area) {
    return rect.left < area.right && rect.right > area.left
      && rect.top < area.bottom && rect.bottom > area.top;
  }

  function onPointerDown(ev) {
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    // Um arraste anterior pode ter terminado fora do #texto (sem click para
    // consumir a supressão): todo gesto novo começa sem supressão pendente.
    suppressClick = false;
    drag = { x: ev.clientX, y: ev.clientY };
  }

  function onPointerUp(ev) {
    if (!drag) return;
    const start = drag;
    drag = null;
    if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) <= DRAG_PX) return;
    const el = root();
    if (!el) return;
    const area = {
      left: Math.min(start.x, ev.clientX),
      right: Math.max(start.x, ev.clientX),
      top: Math.min(start.y, ev.clientY),
      bottom: Math.max(start.y, ev.clientY),
    };
    const hit = [...el.querySelectorAll("button.word")]
      .filter((btn) => intersects(btn.getBoundingClientRect(), area));
    if (!hit.length) return;
    const next = new Set(hit.map((btn) => selectionKey(btn.dataset.scene, btn.dataset.take, btn.dataset.wordId)));
    state.set("selection", next);
    paintSelection(el, next);
    suppressClick = true;
    openSelectionMenu(hit[hit.length - 1].getBoundingClientRect());
  }

  function sameKeys(a, b) {
    if (a === b) return true;
    if (!a || !b || a.size !== b.size) return false;
    for (const key of a) if (!b.has(key)) return false;
    return true;
  }

  state.subscribe("project", (p) => {
    if (closeMenu) closeMenu();
    if (!p) return;
    const pruned = pruneSelection(p, selection());
    if (!sameKeys(pruned, selection())) state.set("selection", pruned);
    render(p);
  });
  state.subscribe("selection", (next) => {
    const el = root();
    if (el) paintSelection(el, next || new Set());
  });

  const el = root();
  if (el) {
    el.addEventListener("click", onClick);
    el.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", () => { drag = null; });
  }
  render(state.get("project"));
}


