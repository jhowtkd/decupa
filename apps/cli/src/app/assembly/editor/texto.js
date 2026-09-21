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
  wordAtPlayhead,
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

/**
 * Centro sem mídia: o guia de 3 passos ocupa o #texto no lugar do
 * conteúdo normal (puro; o render condicional já troca os ramos).
 * @param {{ assembly: { sources: unknown[] } }} p
 */
export function needsEmptyGuide(p) {
  return p.assembly.sources.length === 0;
}

/**
 * Assinatura visual do documento central (pura): modo + ids/textos/flags de
 * palavra. Metadados (revisão, prévia, seleção) NÃO entram — um `set` de
 * projeto que só atualiza a prévia gera a mesma assinatura e o render pode
 * pular o rebuild, preservando scroll/foco/reprodução.
 */
export function docSignature(p) {
  if (!p || needsEmptyGuide(p)) return "empty";
  if (p.scenes.length === 0) {
    return "transcript|" + p.assembly.sources.map((source) => {
      const analysis = (p.analyses || []).find((item) => item.sourceId === source.id);
      return source.id + ":" + source.name + ":" + (analysis ? analysis.status : "")
        + ":" + effectiveWords(p, source.id).map((word) => word.text).join(" ");
    }).join("|") + "|" + (p.preparation ? p.preparation.status : "");
  }
  return "prose|" + p.scenes.map((scene) =>
    scene.id + ":" + scene.takes.map((take) =>
      take.id + ":" + takeWords(p, scene, take).map((word) =>
        word.id + "," + (word.display || word.text)
        + (word.removed ? "-r" : "") + (word.protected ? "-p" : "") + (word.corrected ? "-c" : ""),
      ).join(";"),
    ).join("|")
    // Apoios fazem parte da assinatura: troca de apoio muda scene.support
    // sem tocar palavras — sem isso o chip continuaria exibindo o antigo.
    + ":s" + scene.support.map((entry) =>
      entry.visualId + "@" + entry.offsetFrames + "+" + entry.durationFrames,
    ).join(","),
  ).join("||");
}

/** Rótulo pt-BR de um token do accept do filePicker (puro). */
export function acceptLabel(token) {
  const map = { "video/*": "vídeo", "audio/*": "áudio", "image/*": "imagem" };
  return map[token] || token;
}

/**
 * Formatos aceitos em linguagem humana a partir do accept do filePicker
 * (puro): "video/*,audio/*" vira "vídeo e áudio".
 * @param {string} accept
 */
export function acceptedFormatsLabel(accept) {
  const labels = String(accept || "").split(",")
    .map((token) => token.trim()).filter(Boolean).map(acceptLabel);
  if (labels.length <= 1) return labels[0] || "";
  return labels.slice(0, -1).join(", ") + " e " + labels[labels.length - 1];
}

/**
 * Guia de primeiro uso do centro (puro): 3 passos + formatos aceitos
 * derivados do accept + CTA que dispara o fluxo de importação existente
 * (o clique chama filePicker.click(), como a dropzone antiga).
 * @param {string} accept
 */
export function emptyGuideHtml(accept) {
  return '<section data-empty-guide aria-label="Como começar">'
    + "<h1>Monte seu vídeo em 3 passos</h1>"
    + "<ol>"
    + "<li><strong>Importe</strong> seus vídeos e áudios.</li>"
    + "<li><strong>Selecione e arrume o texto</strong> para montar as cenas.</li>"
    + "<li><strong>Revise e entregue</strong>: confira a prévia e exporte o resultado.</li>"
    + "</ol>"
    + '<p class="muted">Formatos aceitos: ' + esc(acceptedFormatsLabel(accept)) + ".</p>"
    + '<p><button type="button" class="primary" data-empty-import>Importar mídia</button></p>'
    + '<p class="muted">Ou arraste os arquivos para esta área.</p>'
    + "</section>";
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

/** Nome da fonte de um trecho visual: visualId → span na análise → fonte. */
function visualSourceName(p, visualId) {
  for (const analysis of p.analyses || []) {
    const span = (analysis.visual || []).find((item) => item.id === visualId);
    if (span) return sourceName(p, span.sourceId);
  }
  return visualId;
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
    + ' aria-label="Apoio ' + esc(visualSourceName(p, support.visualId)) + ", seleciona a cena" + '"'
    + ">🎬 " + esc(visualSourceName(p, support.visualId)) + " · " + dur.toFixed(1) + "s</button>";
}

function renderProse(p, selection) {
  let html = "";
  let cursor = 0;
  p.scenes.forEach((scene, index) => {
    for (const take of scene.takes) cursor += retainedDuration(take);
    const [up, down] = sceneHeaderActions(index, p.scenes.length);
    // Tempos do cabeçalho: primeiro start e último end dos takes da cena
    // (os mesmos segundos que hoje aparecem nos rótulos de fonte).
    const range = scene.takes.length
      ? '<span class="chip">' + Math.min(...scene.takes.map((take) => take.start)).toFixed(1)
        + "-" + Math.max(...scene.takes.map((take) => take.end)).toFixed(1) + "s</span>"
      : "";
    html += '<section class="scene" data-scene-section="' + esc(scene.id) + '">';
    html += '<p class="scene-head" data-scene="' + esc(scene.id) + '">'
      + '<span class="num">cena ' + (index + 1) + "</span>"
      + '<span class="title">' + esc(scene.objective || "") + "</span>"
      + '<span class="spacer"></span>' + range
      + '<button type="button" class="quiet" data-scene-action="up" data-scene="' + esc(scene.id) + '"'
      + (up.disabled ? " disabled" : "")
      + ' aria-label="Mover cena ' + (index + 1) + ' para cima">↥</button>'
      + '<button type="button" class="quiet" data-scene-action="down" data-scene="' + esc(scene.id) + '"'
      + (down.disabled ? " disabled" : "")
      + ' aria-label="Mover cena ' + (index + 1) + ' para baixo">↧</button>'
      + '<button type="button" class="quiet" data-scene-action="delete" data-scene="' + esc(scene.id) + '"'
      + ' aria-label="Excluir cena ' + (index + 1) + '">✕</button>'
      + '<button type="button" class="quiet" data-scene-action="ajustar" data-scene="' + esc(scene.id) + '"'
      + ' aria-label="Ajustar fala da cena ' + (index + 1) + '"'
      + ' title="Pedir ajuste localizado a uma fala desta cena">✂</button>'
      + (scene.support.length ? '<button type="button" class="quiet" data-scene-action="apoio"'
        + ' data-scene="' + esc(scene.id) + '" aria-label="Trocar apoio da cena ' + (index + 1) + '"'
        + ' title="Trocar um apoio desta cena por outro candidato">🎬</button>' : "") + "</p>";
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
      html += '<div class="take"><p class="prose">';
      for (const word of takeWords(p, scene, take)) {
        html += chipAt(pos) + wordButton(scene, take.id, word, selection) + " ";
        pos += 1;
      }
      // Chip de fonte no fim do bloco (os tempos subiram para o cabeçalho).
      html += '</p><span class="src-chip">'
        + esc(source ? source.name : take.sourceId) + "</span></div>";
    }
    html += chipAt(pos);
    // Zonas omitidas (fora da montagem): takeId "" → menu ouvir/incluir,
    // como inset apagado com contador de palavras e atalho "incluir trecho".
    for (const source of p.assembly.sources) {
      const missing = omittedWords(p, scene, source.id);
      if (!missing.length) continue;
      html += '<div class="unused"><span>não usado (' + missing.length + ' palavras)</span> '
        + '<span class="chip">incluir trecho</span><p class="prose">';
      for (const word of missing) {
        html += wordButton(scene, "", word, selection, " omit",
          ' data-source="' + esc(source.id) + '"') + " ";
      }
      html += '</p><span class="src-chip">' + esc(source.name) + "</span></div>";
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
  if (needsEmptyGuide(p)) {
    dropzone.hidden = true;
    const picker = document.getElementById("filePicker");
    const accept = picker?.getAttribute("accept") || "video/*,audio/*";
    texto.innerHTML = '<div class="measure">' + emptyGuideHtml(accept) + "</div>";
    return;
  }
  dropzone.hidden = true;
  const scroller = document.getElementById("center");
  const top = scroller ? scroller.scrollTop : 0;
  // Coluna de leitura: o documento (transcrição ou prosa) inteiro dentro do
  // wrapper .measure; os gestos continuam no #texto, então trocar os filhos
  // não afeta a delegação.
  texto.innerHTML = '<div class="measure">'
    + (p.scenes.length === 0 ? renderTranscript(p) : renderProse(p, selection))
    + "</div>";
  if (scroller) scroller.scrollTop = top;
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

  let lastSig = null;
  function render(p) {
    if (!p) return;
    const sig = docSignature(p);
    if (sig === lastSig) {
      const el = root();
      if (el) paintSelection(el, selection());
      return;
    }
    lastSig = sig;
    renderCenter(p, selection());
    paintProposalBanner(p, state.get("speechProposal"));
    paintSupportSwap(state.get("supportSwap"));
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
    player.playOriginal(found[0].sourceId, Math.max(0, start - LISTEN_PAD), end);
  }

  async function runMenuAction(action) {
    const p = state.get("project");
    if (!p) return;
    if (action === "ouvir") {
      listenSelection();
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

  /** "Corrigir": mesmo POST da antiga barra global, com o texto do campo inline. */
  // Ajuste localizado de fala (#64): seleção explícita da fala + pedido;
  // a comparação mostra cortes e o impacto de duração antes de aplicar.
  const speechDialog = document.createElement("dialog");
  speechDialog.id = "speechDialog";
  speechDialog.innerHTML = '<h1>Ajustar fala</h1>'
    + '<label>Fala <select id="speechPick"></select></label>'
    + '<label>Pedido <input id="speechRequest" type="text"'
    + ' placeholder="ex.: tire as gagueiras e os preenchimentos"></label>'
    + '<div class="row"><button type="button" class="primary" id="proposeSpeech">Propor ajuste</button>'
    + '<button type="button" id="closeSpeech">Fechar</button></div>'
    + '<div id="speechDiff" aria-live="polite"></div>'
    + '<div class="row" id="speechApplyRow" hidden>'
    + '<button type="button" class="primary" id="acceptSpeech">Aplicar ajuste</button>'
    + '<button type="button" id="rejectSpeech">Recusar proposta</button></div>';
  document.body.appendChild(speechDialog);

  function speechSummary(proposal) {
    const delta = proposal.before.durationSeconds - proposal.after.durationSeconds;
    return {
      scope: `fala ${proposal.scope.speechId} · cenas ${proposal.scope.sceneIds.join(", ")}`,
      duration: `${proposal.before.durationSeconds.toFixed(1)}s → ${proposal.after.durationSeconds.toFixed(1)}s (corta ${delta.toFixed(1)}s)`,
      cuts: proposal.cuts.map((cut) =>
        `${cut.start.toFixed(1)}s–${cut.end.toFixed(1)}s` + (cut.reason ? ` — ${cut.reason}` : "")),
      protected: proposal.skippedProtected > 0
        ? `${proposal.skippedProtected} trecho(s) protegido(s) preservado(s)` : "",
    };
  }

  function paintSpeechDiff(proposal) {
    const box = speechDialog.querySelector("#speechDiff");
    const applyRow = speechDialog.querySelector("#speechApplyRow");
    if (!proposal) {
      box.replaceChildren();
      applyRow.hidden = true;
      return;
    }
    const summary = speechSummary(proposal);
    box.innerHTML = '<p class="muted">' + esc(summary.scope) + " · " + esc(summary.duration) + "</p>"
      + '<p>' + esc(proposal.before.text) + "</p>"
      + '<p class="muted">cortes: " + (summary.cuts.length ? "" : "nenhum") + "</p>'
      + "<ul class=\"plain\">" + summary.cuts.map((cut) => "<li>" + esc(cut) + "</li>").join("") + "</ul>"
      + (summary.protected ? '<p class="muted">' + esc(summary.protected) + "</p>" : "");
    applyRow.hidden = false;
  }

  function openSpeechDialog(sceneId) {
    const p = state.get("project");
    if (!p) return;
    const scene = p.scenes.find((item) => item.id === sceneId);
    if (!scene) return;
    const sel = speechDialog.querySelector("#speechPick");
    sel.replaceChildren();
    for (const take of scene.takes) {
      if (!take.speechId) continue;
      const analysis = p.analyses.find((item) => item.sourceId === take.sourceId);
      const speech = analysis?.speech.find((item) => item.id === take.speechId);
      const label = `${sourceName(p, take.sourceId)} · ${take.start.toFixed(1)}–${take.end.toFixed(1)}s`
        + ` — "${(speech?.text || "").slice(0, 60)}"`;
      sel.appendChild(new Option(label, `${take.sourceId}\u0000${take.speechId}`));
    }
    paintSpeechDiff(state.get("speechProposal"));
    speechDialog.showModal();
  }

  speechDialog.querySelector("#closeSpeech").onclick = () => speechDialog.close();
  speechDialog.querySelector("#proposeSpeech").onclick = async () => {
    const p = state.get("project");
    if (!p) return;
    const picked = speechDialog.querySelector("#speechPick").value.split("\u0000");
    const request = speechDialog.querySelector("#speechRequest").value.trim();
    const { res } = await api.call("/project/speech-proposal", {
      method: "POST",
      body: JSON.stringify({
        baseRevision: p.revision,
        sourceId: picked[0], speechId: picked[1],
        request,
      }),
      label: "Propondo ajuste…",
    });
    if (res.ok) paintSpeechDiff(state.get("speechProposal"));
  };
  speechDialog.querySelector("#acceptSpeech").onclick = async () => {
    const p = state.get("project");
    const proposal = state.get("speechProposal");
    if (!p || !proposal) return;
    const { res } = await api.call("/project/speech-accept", {
      method: "POST",
      body: JSON.stringify({ baseRevision: p.revision, proposalId: proposal.id }),
      label: "Aplicando ajuste…",
    });
    if (res.ok) { speechDialog.close(); }
  };
  speechDialog.querySelector("#rejectSpeech").onclick = async () => {
    const p = state.get("project");
    const proposal = state.get("speechProposal");
    if (!p || !proposal) return;
    const { res } = await api.call("/project/speech-reject", {
      method: "POST",
      body: JSON.stringify({ baseRevision: p.revision, proposalId: proposal.id }),
      label: "Recusando proposta…",
    });
    if (res.ok) { paintSpeechDiff(null); }
  };

  /** Banner de proposta pendente no topo do texto (sobrevive a reload). */
  function paintProposalBanner(p, proposal) {
    const el = root();
    if (!el) return;
    el.querySelector(".speech-proposal")?.remove();
    if (!proposal) return;
    const summary = speechSummary(proposal);
    const banner = document.createElement("div");
    banner.className = "speech-proposal warn";
    banner.innerHTML = "<strong>Ajuste de fala pendente</strong> — "
      + esc(summary.scope) + " · " + esc(summary.duration)
      + ' <button type="button" data-speech-apply="1">Aplicar</button>'
      + ' <button type="button" data-speech-reject="1">Recusar</button>';
    el.prepend(banner);
  }
  state.subscribe("speechProposal", (proposal) => {
    paintSpeechDiff(proposal);
    paintProposalBanner(state.get("project"), proposal);
  });

  // Troca localizada de apoio (#65): diálogo lista os apoios da cena e os
  // candidatos com origem + evidência; aceitar aplica só a troca escolhida.
  const supportDialog = document.createElement("dialog");
  supportDialog.id = "supportDialog";
  supportDialog.innerHTML = '<h1>Trocar apoio</h1>'
    + '<div id="supportCurrent"></div>'
    + '<div id="supportCandidates"></div>'
    + '<div class="row"><button type="button" id="closeSupport">Fechar</button></div>';
  document.body.appendChild(supportDialog);
  let swapSceneId = null;

  function openSupportDialog(sceneId) {
    const p = state.get("project");
    if (!p) return;
    const scene = p.scenes.find((item) => item.id === sceneId);
    if (!scene) return;
    swapSceneId = sceneId;
    const current = supportDialog.querySelector("#supportCurrent");
    const list = supportDialog.querySelector("#supportCandidates");
    current.innerHTML = "<p class=\"muted\">apoios da cena " + esc(scene.id) + ":</p>"
      + '<ul class="plain">'
      + scene.support.map((entry, i) =>
        "<li>" + esc(visualSourceName(p, entry.visualId)) + " · "
        + (entry.durationFrames / (p.assembly.fps.num / p.assembly.fps.den)).toFixed(1) + "s "
        + '<button type="button" data-swap-support="' + i + '">buscar candidatos</button></li>').join("")
      + "</ul>";
    list.replaceChildren();
    supportDialog.showModal();
  }

  supportDialog.addEventListener("click", async (ev) => {
    const close = ev.target.closest("#closeSupport");
    if (close) { supportDialog.close(); return; }
    const pick = ev.target.closest("[data-swap-support]");
    const candidate = ev.target.closest("[data-swap-candidate]");
    const reject = ev.target.closest("[data-swap-reject]");
    const p = state.get("project");
    if (!p) return;
    if (pick) {
      const { res } = await api.call("/project/support-swap", {
        method: "POST",
        body: JSON.stringify({
          baseRevision: p.revision,
          sceneId: swapSceneId,
          supportIndex: Number(pick.dataset.swapSupport),
          request: "",
        }),
        label: "Buscando candidatos…",
      });
      void res;
    } else if (candidate) {
      const proposal = state.get("supportSwap");
      if (!proposal) return;
      await api.call("/project/support-swap-accept", {
        method: "POST",
        body: JSON.stringify({
          baseRevision: p.revision, proposalId: proposal.id,
          candidateId: candidate.dataset.swapCandidate,
        }),
        label: "Trocando apoio…",
      });
      // Troca aplicada: a proposta some e a lista de candidatos ficaria
      // velha — fecha o diálogo; os chips já repintam pela assinatura.
      supportDialog.close();
    } else if (reject) {
      const proposal = state.get("supportSwap");
      if (!proposal) return;
      await api.call("/project/support-swap-reject", {
        method: "POST",
        body: JSON.stringify({ baseRevision: p.revision, proposalId: proposal.id }),
        label: "Recusando troca…",
      });
      supportDialog.close();
    }
  });

  /** Preenche candidatos/gap da proposta de troca no diálogo. */
  function paintSupportSwap(proposal) {
    if (!supportDialog.open) return;
    const list = supportDialog.querySelector("#supportCandidates");
    if (!proposal) { list.replaceChildren(); return; }
    let html = '<p class="muted">atual: ' + esc(proposal.current.sourceName || proposal.current.sourceId)
      + " " + proposal.current.sourceStart.toFixed(1) + "–" + proposal.current.sourceEnd.toFixed(1) + "s"
      + (proposal.current.evidence ? ' — "' + esc(proposal.current.evidence) + '"' : "") + "</p>";
    if (proposal.gap) html += '<p class="warn">' + esc(proposal.gap) + "</p>";
    html += '<ul class="plain">' + proposal.candidates.map((candidate) =>
      "<li><button type=\"button\" data-swap-candidate=\"" + esc(candidate.id) + "\">"
      + esc(candidate.sourceId) + " " + candidate.start.toFixed(1) + "–" + candidate.end.toFixed(1) + "s"
      + " · " + esc(candidate.description)
      + (candidate.fullCoverage ? "" : ' <span class="warn">corta no fim</span>')
      + "</button></li>").join("") + "</ul>";
    if (proposal.candidates.length || proposal.gap) {
      html += '<button type="button" data-swap-reject="1">Manter apoio atual</button>';
    }
    list.innerHTML = html;
  }
  state.subscribe("supportSwap", paintSupportSwap);

  async function submitCorrection(text) {
    const p = state.get("project");
    if (!p) return;
    const group = selectedTake(p, selection());
    if (!group) {
      api.notifyError("Selecione palavras de um mesmo trecho.");
      return;
    }
    if (!text) {
      api.notifyError("Digite o texto corrigido.");
      return;
    }
    const ordered = group.words.slice().sort((a, b) => a.start - b.start);
    await api.call("/project/edit", {
      method: "POST",
      body: JSON.stringify({
        baseRevision: p.revision,
        action: {
          type: "correct",
          sourceId: group.sourceId,
          start: ordered[0].start,
          end: ordered[ordered.length - 1].end,
          text,
        },
      }),
      label: "Enviando correção…",
    });
    // O alinhamento conclui em background; a assinatura de "project"
    // retoma o render e o bootstrap (page.js) retoma o polling (V3).
    if (closeMenu) closeMenu();
  }

  /** Expande o campo inline de correção dentro do próprio menu flutuante. */
  function openCorrectForm(menu, btn) {
    const again = menu.querySelector(".texto-correct input");
    if (again) {
      again.focus();
      return;
    }
    btn.disabled = true;
    const form = document.createElement("form");
    form.className = "texto-correct";
    form.style.cssText = "display:flex;gap:4px;";
    const input = document.createElement("input");
    input.type = "text";
    input.setAttribute("aria-label", "Correção do trecho");
    input.placeholder = "Correção do trecho";
    const apply = document.createElement("button");
    apply.type = "submit";
    apply.textContent = "Aplicar";
    form.append(input, apply);
    menu.appendChild(form);
    input.focus();
    form.onsubmit = (ev) => {
      ev.preventDefault();
      void submitCorrection(input.value.trim());
    };
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
      if (item.action === "corrigir") {
        // Corrigir expande o campo inline no próprio menu (sem fechar).
        btn.setAttribute("aria-haspopup", "dialog");
        btn.onclick = () => openCorrectForm(menu, btn);
      } else {
        btn.onclick = () => {
          if (closeMenu) closeMenu();
          void runMenuAction(item.action);
        };
      }
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
    if (sceneAction === "ajustar") {
      openSpeechDialog(scene);
      return;
    }
    if (sceneAction === "apoio") {
      openSupportDialog(scene);
      return;
    }
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
    const importCta = ev.target.closest("[data-empty-import]");
    if (importCta && el.contains(importCta)) {
      document.getElementById("filePicker")?.click();
      return;
    }
    const speechAction = ev.target.closest("[data-speech-apply],[data-speech-reject]");
    if (speechAction && el.contains(speechAction)) {
      const proposal = state.get("speechProposal");
      const p = state.get("project");
      if (proposal && p) {
        void api.call(proposal && speechAction.hasAttribute("data-speech-apply")
          ? "/project/speech-accept" : "/project/speech-reject", {
          method: "POST",
          body: JSON.stringify({ baseRevision: p.revision, proposalId: proposal.id }),
          label: speechAction.hasAttribute("data-speech-apply") ? "Aplicando ajuste…" : "Recusando proposta…",
        });
      }
      return;
    }
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

  function paintPlayhead(playhead) {
    const el = root();
    if (!el || el.hidden) return;
    const hit = wordAtPlayhead(state.get("project"), playhead);
    for (const btn of el.querySelectorAll("button.word")) {
      const on = hit
        && btn.dataset.scene === hit.sceneId
        && btn.dataset.take === hit.takeId
        && btn.dataset.wordId === hit.wordId;
      btn.classList.toggle("ativa", !!on);
    }
  }
  state.subscribe("playhead", (t) => paintPlayhead(t));

  const el = root();
  if (el) {
    el.addEventListener("click", onClick);
    el.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", () => { drag = null; });
  }
  render(state.get("project"));
}


