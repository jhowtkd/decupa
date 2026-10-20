// Região do texto (Task 6): os dois documentos do centro como timeline com
// gestos de edição no ponto e menu flutuante. Lógica de menu pura e testável
// (menuActionsFor/sceneHeaderActions); o DOM só ancora gestos e dispara
// POST project/edit (a sincronização do projeto volta pelo api.call do
// bootstrap, como nos outros módulos).
import { clock, clockPrecise, seconds1 } from "./format.js";
import { ICON } from "./icons.js";
import {
  effectiveWords,
  montageDuration,
  montageTimeOfWord,
  montageWordTimes,
  omittedWords,
  omittedWordCount,
  retainedDuration,
  supportGroups,
  takeWords,
  wordAtPlayhead,
} from "./montage.js";
import { singleFlight } from "./sequencia.js";

/** Contexto antes do trecho em "ouvir" — padrão JOIN_PAD da tela de limpeza. */
export const LISTEN_PAD = 0.7;

/** Inclui as palavras vizinhas e a folga dos dois lados no original. */
export function fillerListenRange(item, duration = Infinity) {
  return { start: Math.max(0, item.listen.start - LISTEN_PAD), end: Math.min(duration, item.listen.end + LISTEN_PAD) };
}


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
 * Ordem e exclusão da cena (puro): mover desabilita nos extremos,
 * excluir segue sempre disponível (rota direta move-scene/delete-scene).
 * @returns {HeaderAction[]}
 */
export function sceneHeaderActions(index, total) {
  return [
    { kind: "move", direction: "up", disabled: index <= 0 },
    { kind: "move", direction: "down", disabled: index >= total - 1 },
    { kind: "delete", disabled: false, danger: true },
  ];
}

/** Menu "Ações da cena" (puro): mover, ajustar fala, trocar apoio e apagar num lugar só. */
export function sceneMenuItems(index, total, hasSupport) {
  const [up, down, del] = sceneHeaderActions(index, total);
  return [
    { action: "up", label: "Mover para cima", disabled: up.disabled },
    { action: "down", label: "Mover para baixo", disabled: down.disabled },
    { action: "ajustar", label: "Ajustar fala…", disabled: false },
    ...(hasSupport ? [{ action: "apoio", label: "Trocar apoio…", disabled: false }] : []),
    { action: "delete", label: "Apagar cena", disabled: del.disabled, danger: true },
  ];
}

const MENU_GAP = 6;
const MENU_MARGIN = 8;

/**
 * Caixa do menu flutuante (pura). Abre abaixo do gatilho; se a altura não
 * couber, abre acima. Se nenhum lado comporta o menu inteiro, limita
 * maxHeight para o DOM rolar. align "end" encosta na direita do gatilho.
 */
export function floatMenuBox(anchor, size, viewport, align = "end") {
  const spaceBelow = viewport.height - anchor.bottom - MENU_GAP - MENU_MARGIN;
  const spaceAbove = anchor.top - MENU_GAP - MENU_MARGIN;
  const below = size.height <= spaceBelow || spaceBelow >= spaceAbove;
  const room = Math.max(0, below ? spaceBelow : spaceAbove);
  const height = Math.min(size.height, room);
  const top = below
    ? anchor.bottom + MENU_GAP
    : Math.max(MENU_MARGIN, anchor.top - MENU_GAP - height);
  const prefer = align === "end" ? anchor.right - size.width : anchor.left;
  const left = Math.max(MENU_MARGIN, Math.min(prefer, viewport.width - size.width - MENU_MARGIN));
  return { top, left, maxHeight: size.height > room ? room : null, placement: below ? "below" : "above" };
}

/** Faixa da cena no tempo da montagem (puro): "0:00 – 0:21 · 21,3 s". */
export function sceneRangeLabel(project, scene) {
  const start = sceneMontageStart(project, scene.id);
  const duration = scene.takes.reduce((sum, take) => sum + retainedDuration(take), 0);
  return clock(start) + " – " + clock(start + duration) + " · " + seconds1(duration);
}

/** Pílula do cabeçalho do texto (puro). */
export function textoMetaView(sceneCount, running, durationSeconds) {
  if (sceneCount > 0) {
    return { hidden: false, accent: false, text: sceneCount + (sceneCount === 1 ? " cena · " : " cenas · ") + clockPrecise(durationSeconds) };
  }
  return { hidden: !running, accent: true, text: "Transcrição parcial" };
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
 * para o menu ouvir/incluir. Só confere os takes e zonas que a seleção cita:
 * seleção vazia sai na hora, e o custo não cresce com o projeto inteiro.
 */
export function pruneSelection(p, selection) {
  const next = new Set();
  if (!selection || selection.size === 0) return next;
  const cited = new Set();
  for (const key of selection) {
    const [sceneId, takeId] = key.split("\0");
    cited.add(sceneId + "\0" + takeId);
  }
  const known = new Set();
  for (const scene of p.scenes) {
    for (const take of scene.takes) {
      if (!cited.has(scene.id + "\0" + take.id)) continue;
      for (const word of takeWords(p, scene, take)) {
        known.add(selectionKey(scene.id, take.id, word.id));
      }
    }
    if (!cited.has(scene.id + "\0")) continue;
    for (const source of p.assembly.sources) {
      for (const word of omittedWords(p, scene, source.id)) {
        known.add(selectionKey(scene.id, "", word.id));
      }
    }
  }
  for (const key of selection) {
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
  return "prose|" + sourceDocSignature(p) + "|" + p.scenes.map((scene) =>
    scene.id + ":" + scene.takes.map((take) =>
      take.id + ":" + takeWords(p, scene, take).map((word) =>
        word.id + "," + (word.display || word.text)
        + (word.removed ? "-r" : "") + (word.protected ? "-p" : "") + (word.corrected ? "-c" : ""),
      ).join(";"),
    ).join("|")
    // Apoios fazem parte da assinatura: troca de apoio muda scene.support
    // sem tocar palavras — sem isso o chip continuaria exibindo o antigo.
    + ":s" + (scene.support || []).map((entry) =>
      entry.visualId + "@" + entry.offsetFrames + "+" + entry.durationFrames,
    ).join(",") + JSON.stringify([scene.objective, scene.rationale, scene.gaps, scene.takes]),
  ).join("||");
}

// Metadados compartilhados; o catálogo omitido só entra na assinatura local
// das zonas abertas. Fechadas, elas dependem apenas da contagem.
const sourceSignatures = new WeakMap();
function sourceDocSignature(p) {
  const deps = [p.assembly.sources, p.assembly.fps, p.analyses, p.corrections];
  const cached = sourceSignatures.get(p);
  if (cached && cached.deps.every((dep, i) => dep === deps[i])) return cached.signature;
  const signature = JSON.stringify([p.assembly.sources, p.assembly.fps,
    (p.analyses || []).map((analysis) => (analysis.visual || []).map((span) => [span.id, span.sourceId])),
  ]);
  sourceSignatures.set(p, { deps, signature });
  return signature;
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
  return '<section class="empty-guide" data-empty-guide aria-label="Como começar">'
    + '<div class="empty-hero"><span class="empty-icon">' + ICON.importMedia + "</span>"
    + "<h1>Seu próximo vídeo começa aqui</h1>"
    + "<p>Solte vídeos e áudios nesta área ou escolha os arquivos no computador.</p>"
    + '<button type="button" class="primary big" data-empty-import>' + ICON.plus + "Importar mídia</button>"
    + '<p class="empty-foot">Formatos aceitos: ' + esc(acceptedFormatsLabel(accept))
    + " · os originais ficam neste computador</p></div>"
    + '<ol class="empty-steps" aria-label="Como funciona">'
    + '<li><span class="num is-current">1</span><strong>Importe</strong><span>Importe seus vídeos e áudios.</span></li>'
    + '<li><span class="num">2</span><strong>Arrume pelo texto</strong><span>Selecione e arrume o texto para montar as cenas.</span></li>'
    + '<li><span class="num">3</span><strong>Revise e entregue</strong><span>Confira a prévia e exporte o resultado.</span></li>'
    + "</ol></section>";
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

/** Etapas em que o usuário já está trabalhando: a transcrição não troca o foco. */
const ACTIVE_EDIT_STAGES = new Set(["edicao", "revisao", "entrega"]);

function projectWithWords(project) {
  if (!project?.assembly?.sources || !Array.isArray(project.analyses)) return null;
  return Array.isArray(project.corrections) ? project : { ...project, corrections: [] };
}

/** Fontes incluídas que já têm palavras no documento (ordem da montagem). */
function sourcesWithTranscript(project) {
  const safe = projectWithWords(project);
  if (!safe) return [];
  return safe.assembly.sources.filter((source) => {
    if (source.included === false) return false;
    const analysis = safe.analyses.find((item) => item.sourceId === source.id);
    if (!analysis || !Array.isArray(analysis.words) || analysis.words.length === 0) return false;
    return effectiveWords(safe, source.id).length > 0;
  });
}

/** Status da análise por fonte, em português (o enum do servidor não vai para a tela). */
export function analysisStatusLabel(status) {
  return { ready: "transcrita", partial: "parcial", error: "com erro" }[status] || "na fila";
}

/**
 * Documento da transcrição (antes da proposta de cenas). Enquanto a
 * preparação roda, a pílula "Transcrição parcial" do cabeçalho avisa.
 * Cada fonte entra com as palavras dela assim que essa fonte é salva.
 */
export function transcriptHtml(project) {
  let html = "";
  for (const source of project.assembly.sources) {
    const analysis = project.analyses.find((item) => item.sourceId === source.id);
    html += '<section class="doc-source" data-source="' + esc(source.id) + '">'
      + '<header class="doc-head"><h2>' + esc(source.name) + '</h2><span class="pill">'
      + esc(analysisStatusLabel(analysis?.status)) + "</span></header>";
    const words = effectiveWords(project, source.id);
    html += words.length
      ? '<p class="prose is-draft">' + words.map((w) => esc(w.text)).join(" ") + "</p>"
      : '<p class="muted">Transcrição ainda não disponível.</p>';
    html += "</section>";
  }
  return html;
}

/**
 * O que fazer quando o snapshot do projeto muda durante a preparação.
 * Materiais (ou etapa ainda não escolhida) abre a etapa de texto sozinha
 * na primeira fonte com palavras. Edição, revisão e entrega ficam onde
 * estão; o aviso nomeia cada fonte já salva.
 * @param {string | undefined} stage
 * @param {object | null | undefined} previous
 * @param {object | null | undefined} next
 * @returns {{ stage: string, transcriptNotice: string }}
 */
export function partialTranscriptView(stage, previous, next) {
  const current = stage || "materiais";
  if (!next) return { stage: current, transcriptNotice: "" };
  const preparing = next.preparation?.status === "running";
  const ready = sourcesWithTranscript(next);
  const known = new Set(sourcesWithTranscript(previous).map((source) => source.id));
  const arrived = preparing ? ready.filter((source) => !known.has(source.id)) : [];
  const nextStage = !ACTIVE_EDIT_STAGES.has(current) && arrived.length > 0 ? "edicao" : current;
  const notice = preparing && ready.length > 0
    ? "Transcrição disponível · " + ready.map((source) => source.name || source.id).join(", ")
    : "";
  return { stage: nextStage, transcriptNotice: notice };
}

function wordButton(scene, takeId, word, selection, extraClass = "", extraAttrs = "") {
  const key = selectionKey(scene.id, takeId, word.id);
  return '<button type="button" tabindex="-1" aria-haspopup="menu" class="word'
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
  const name = visualSourceName(p, support.visualId);
  return '<button type="button" class="chip-apoio"'
    + ' data-scene="' + esc(scene.id) + '" data-support="' + index + '"'
    + ' title="Apoio em ' + esc(clockPrecise(at)) + " da montagem · " + esc(seconds1(dur)) + '"'
    + ' aria-label="Apoio ' + esc(name) + ', seleciona a cena">'
    + ICON.image + esc(name) + " · " + esc(seconds1(dur)) + "</button>";
}

function renderScene(p, scene, index, selection) {
  let html = "";
  const { starts } = montageWordTimes(p);
  html += '<header class="scene-head" data-scene="' + esc(scene.id) + '">'
    + '<span class="num">' + (index + 1) + "</span>"
    + '<h2 class="title">' + esc(scene.objective || "Cena " + (index + 1)) + "</h2>"
    + '<span class="spacer"></span>'
    + '<span class="pill mono">' + esc(sceneRangeLabel(p, scene)) + "</span>"
    + '<button type="button" class="icon" data-scene-menu="' + esc(scene.id) + '" aria-haspopup="menu"'
    + ' aria-expanded="false" aria-label="Ações da cena ' + (index + 1) + '">' + ICON.more + "</button></header>";
  html += '<div class="scene-body">';
  if (scene.rationale) html += '<p class="scene-note">' + esc(scene.rationale) + "</p>";
  for (const gap of scene.gaps) html += '<p class="scene-gap">Lacuna: ' + esc(gap) + "</p>";
  // Âncoras de apoio: índice plano da primeira palavra com tempo de
  // montagem >= início do apoio; sem palavra depois, cai no fim da cena.
  const flat = [];
  for (const take of scene.takes) {
    for (const word of takeWords(p, scene, take)) {
      flat.push({ takeId: take.id, time: starts.get(selectionKey(scene.id, take.id, word.id)) ?? null });
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
    html += '</p><span class="src-chip">' + esc(source ? source.name : take.sourceId) + " · "
      + esc(take.start.toFixed(1).replace(".", ",")) + "–" + esc(take.end.toFixed(1).replace(".", ",")) + " s</span></div>";
  }
  html += chipAt(pos) + "</div>";
  // Zonas omitidas: resumo com "Incluir trecho" (inclui tudo de uma vez) e
  // o texto recolhido; palavra a palavra continua no menu ouvir/incluir.
  for (const source of p.assembly.sources) {
    const count = omittedWordCount(p, scene, source.id);
    if (!count) continue;
    html += '<div class="unused"><div class="unused-head"><span>Trecho não usado</span>'
      + '<span class="mono">' + esc(source.name) + " · " + count + (count === 1 ? " palavra" : " palavras") + "</span>"
      + '<span class="spacer"></span>'
      + '<button type="button" class="small" data-include-zone data-scene="' + esc(scene.id) + '" data-source="' + esc(source.id) + '">Incluir trecho</button></div>'
      + '<details data-omitted-source="' + esc(source.id) + '" data-scene="' + esc(scene.id) + '">'
      + '<summary>Ver o texto</summary><p class="prose"></p></details></div>';
  }
  return html;
}

function renderCenter(p) {
  const texto = document.getElementById("texto");
  const dropzone = document.getElementById("dropzone");
  if (!p || !texto || !dropzone) return;
  if (needsEmptyGuide(p)) {
    dropzone.hidden = true;
    const picker = document.getElementById("filePicker");
    const accept = picker?.getAttribute("accept") || "video/*,audio/*";
    texto.innerHTML = '<div class="measure">' + emptyGuideHtml(accept) + "</div>";
    return;
  }
  dropzone.hidden = true;
  const scroller = texto;
  const top = scroller ? scroller.scrollTop : 0;
  // Coluna de leitura: o documento (transcrição ou prosa) inteiro dentro do
  // wrapper .measure; os gestos continuam no #texto, então trocar os filhos
  // não afeta a delegação.
  texto.innerHTML = '<div class="measure">'
    + transcriptHtml(p)
    + "</div>";
  if (scroller) scroller.scrollTop = top;
}

const wordIndexes = new WeakMap();

function wordIndex(root) {
  if (!wordIndexes.has(root)) wordIndexes.set(root, { buttons: new Map(), selected: new Set() });
  return wordIndexes.get(root);
}

/** O índice contém apenas as ocorrências montadas, atualizado por região. */
function indexWords(root, region, add) {
  const { buttons } = wordIndex(root);
  for (const btn of region.querySelectorAll("button.word")) {
    const key = selectionKey(btn.dataset.scene, btn.dataset.take, btn.dataset.wordId);
    if (add) buttons.set(key, btn);
    else buttons.delete(key);
  }
}

/** Atualiza só as ocorrências cuja marca mudou, sem varrer o documento. */
function paintSelection(root, selection) {
  const index = wordIndex(root);
  for (const key of index.selected) {
    if (!selection.has(key)) index.buttons.get(key)?.setAttribute("aria-pressed", "false");
  }
  for (const key of selection) {
    if (!index.selected.has(key)) index.buttons.get(key)?.setAttribute("aria-pressed", "true");
  }
  index.selected = new Set(selection);
}

/**
 * Cascas permanentes mantêm os ids usados pelo rail e pela faixa. Só a cena
 * visível e suas vizinhas têm conteúdo; ao sair, sua altura medida ocupa o
 * lugar do texto. A seleção continua sendo a mesma Set do estado, inclusive
 * para ocorrências que estão temporariamente fora do DOM.
 */
function sceneDocument(root, selection, didPaint) {
  const measure = document.createElement("div");
  measure.className = "measure";
  root.replaceChildren(measure);
  const previousAnchoring = root.style.overflowAnchor;
  root.style.overflowAnchor = "none";
  let project;
  let entries = [];
  let forcedScene = null;
  let restoringFocusScene = null;
  let frame = null;
  let disposed = false;
  const expanded = new Map();

  function anchor() {
    const top = root.getBoundingClientRect().top;
    const entry = entries.find((item) => item.el.getBoundingClientRect().bottom > top);
    return entry ? { el: entry.el, offset: entry.el.getBoundingClientRect().top - top } : null;
  }

  function restoreAnchor(saved, scrollTop) {
    root.scrollTop = saved && root.contains(saved.el)
      ? scrollTop + saved.el.getBoundingClientRect().top - root.getBoundingClientRect().top - saved.offset
      : scrollTop;
  }

  function estimate(scene) {
    const width = Math.max(120, Math.min(640, root.clientWidth || 640) - 32);
    const words = scene.takes.reduce((sum, take) => sum + takeWords(project, scene, take).length, 0);
    const zones = project.assembly.sources.filter((source) => omittedWordCount(project, scene, source.id) > 0).length;
    return 60 + Math.ceil(words * 80 / width) * 34 + scene.takes.length * 34
      + (scene.rationale ? 40 : 0) + scene.gaps.length * 24 + zones * 100;
  }

  function fillOmitted(details, scene) {
    const prose = details.querySelector(".prose");
    indexWords(root, prose, false);
    prose.innerHTML = details.open
      ? omittedWords(project, scene, details.dataset.omittedSource).map((word) =>
        wordButton(scene, "", word, selection(), " omit", ' data-source="' + esc(details.dataset.omittedSource) + '"') + " ",
      ).join("")
      : "";
    indexWords(root, prose, true);
  }

  function viewSignature(entry) {
    return entry.baseSignature + JSON.stringify([
      entry.scene.takes.map((take) => takeWords(project, entry.scene, take)),
      project.assembly.sources.map((source) => omittedWordCount(project, entry.scene, source.id)),
      [...(expanded.get(entry.scene.id) || [])].map((sourceId) => omittedWords(project, entry.scene, sourceId)),
    ]);
  }

  function mount(entry) {
    const active = document.activeElement;
    const focused = entry.el.contains(active) ? active?.dataset : null;
    const focusKey = focused?.wordId !== undefined
      ? selectionKey(focused.scene, focused.take, focused.wordId) : null;
    indexWords(root, entry.el, false);
    entry.el.style.height = "";
    entry.el.innerHTML = renderScene(project, entry.scene, entry.index, selection());
    entry.el.dataset.sceneMounted = "true";
    entry.mounted = true;
    entry.dirty = false;
    for (const details of entry.el.querySelectorAll("details[data-omitted-source]")) {
      if (!expanded.get(entry.scene.id)?.has(details.dataset.omittedSource)) continue;
      details.open = true;
      fillOmitted(details, entry.scene);
    }
    indexWords(root, entry.el, true);
    if (focusKey) wordIndex(root).buttons.get(focusKey)?.focus({ preventScroll: true });
  }

  function unmount(entry) {
    const height = entry.el.getBoundingClientRect().height;
    if (height > 0) entry.height = height;
    indexWords(root, entry.el, false);
    entry.el.style.height = entry.height + "px";
    entry.el.replaceChildren();
    entry.el.dataset.sceneMounted = "false";
    entry.mounted = false;
    // A assinatura pode conter o catálogo omitido inteiro. A remontagem
    // recalcula esse valor, então não retenha sua cópia fora do DOM.
    entry.signature = null;
  }

  function refresh() {
    if (disposed || !project) return;
    const saved = anchor();
    const scrollTop = root.scrollTop;
    const viewport = root.getBoundingClientRect();
    const visible = entries.filter((entry) => {
      const rect = entry.el.getBoundingClientRect();
      return root.clientHeight > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom;
    });
    const wanted = new Set();
    // Região escondida ou ainda sem layout: começa com duas cenas.
    for (const entry of visible.length ? visible : entries.slice(0, 1)) {
      for (let i = Math.max(0, entry.index - 1); i <= Math.min(entries.length - 1, entry.index + 1); i += 1) wanted.add(entries[i]);
    }
    const forced = entries.find((entry) => entry.scene.id === forcedScene);
    if (forced) {
      for (let i = Math.max(0, forced.index - 1); i <= Math.min(entries.length - 1, forced.index + 1); i += 1) wanted.add(entries[i]);
    }
    for (const entry of entries) {
      // Foco de teclado não desaparece quando a pessoa rola com o ponteiro.
      if (entry.scene.id === restoringFocusScene
        || (entry.mounted && entry.el.contains(document.activeElement))) wanted.add(entry);
      if (wanted.has(entry)) {
        if (!entry.mounted || entry.dirty) {
          const signature = viewSignature(entry);
          if (!entry.mounted || entry.signature !== signature) mount(entry);
          entry.signature = signature;
          entry.dirty = false;
        }
        const height = entry.el.getBoundingClientRect().height;
        if (height > 0) entry.height = height;
      } else if (entry.mounted) unmount(entry);
    }
    restoreAnchor(saved, scrollTop);
    didPaint();
  }

  function schedule() {
    if (disposed || frame !== null) return;
    if (typeof requestAnimationFrame !== "function") { refresh(); return; }
    frame = requestAnimationFrame(() => { frame = null; refresh(); });
  }

  function onScroll() {
    forcedScene = null;
    schedule();
  }

  function onToggle(ev) {
    const details = ev.target;
    if (!details?.hasAttribute?.("data-omitted-source")) return;
    const entry = entries.find((item) => item.scene.id === details.dataset.scene);
    if (!entry?.el.contains(details)) return;
    if (!expanded.has(entry.scene.id)) expanded.set(entry.scene.id, new Set());
    const sources = expanded.get(entry.scene.id);
    const wasOpen = sources.has(details.dataset.omittedSource);
    if (wasOpen === details.open) return;
    if (details.open) sources.add(details.dataset.omittedSource);
    else sources.delete(details.dataset.omittedSource);
    const saved = anchor();
    const top = root.scrollTop;
    fillOmitted(details, entry.scene);
    entry.signature = viewSignature(entry);
    entry.height = entry.el.getBoundingClientRect().height || entry.height;
    restoreAnchor(saved, top);
    refresh();
  }

  root.addEventListener("scroll", onScroll, { passive: true });
  // toggle não propaga; a captura permite delegar também aos details novos.
  root.addEventListener("toggle", onToggle, true);
  window.addEventListener("resize", schedule);
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
  observer?.observe(root);
  observer?.observe(measure);

  return {
    update(p) {
      const saved = anchor();
      const top = root.scrollTop;
      // insertBefore pode desfocar o subtree no navegador. Capture antes de
      // reordenar as cascas, inclusive para mover cena e desfazer.
      const active = document.activeElement;
      const focused = root.contains(active) && active?.dataset?.wordId !== undefined
        ? { scene: active.dataset.scene,
          key: selectionKey(active.dataset.scene, active.dataset.take, active.dataset.wordId) } : null;
      restoringFocusScene = focused?.scene ?? null;
      project = p;
      const sources = sourceDocSignature(p);
      const old = new Map(entries.map((entry) => [entry.scene.id, entry]));
      entries = p.scenes.map((scene, index) => {
        const signature = sources + JSON.stringify([scene, index, sceneMontageStart(p, scene.id)]);
        let entry = old.get(scene.id);
        if (!entry) {
          const el = document.createElement("section");
          el.className = "scene";
          el.id = "cena-" + scene.id;
          el.dataset.sceneSection = scene.id;
          el.dataset.sceneMounted = "false";
          entry = { el, mounted: false, height: estimate(scene) };
          el.style.height = entry.height + "px";
        }
        entry.dirty = true;
        entry.baseSignature = signature;
        entry.scene = scene;
        entry.index = index;
        old.delete(scene.id);
        return entry;
      });
      for (const [id, entry] of old) {
        indexWords(root, entry.el, false);
        entry.el.remove();
        expanded.delete(id);
      }
      entries.forEach((entry, index) => {
        if (measure.children[index] !== entry.el) measure.insertBefore(entry.el, measure.children[index] || null);
      });
      restoreAnchor(saved, top);
      refresh();
      if (focused) wordIndex(root).buttons.get(focused.key)?.focus({ preventScroll: true });
      restoringFocusScene = null;
      schedule();
    },
    ensure(sceneId) {
      forcedScene = sceneId;
      refresh();
    },
    destroy() {
      disposed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      observer?.disconnect();
      root.removeEventListener("scroll", onScroll);
      root.removeEventListener("toggle", onToggle, true);
      window.removeEventListener?.("resize", schedule);
      root.style.overflowAnchor = previousAnchoring;
      wordIndexes.delete(root);
    },
  };
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

/** Limiar de arraste: até 6px é clique; além disso, intervalo âncora/foco. */
const DRAG_PX = 6;

/**
 * "Propor ajuste" de fala: chamada paga, um pedido por vez. Em voo, o
 * botão fica travado com o rótulo de andamento; sucesso ou erro (inclusive
 * o 409 de outra proposta em voo) devolvem o botão ao normal. O erro já
 * aparece no status pelo api.call.
 * @param {{ state: any, api: any, button: any, readTarget: () => { sourceId: string, speechId: string, request: string }, onProposal: () => void }} deps
 */
export function speechProposalAction({ state, api, button, readTarget, onProposal }) {
  const idleLabel = button.textContent;
  return singleFlight(() => {
    const p = state.get("project");
    if (!p) return undefined;
    const { sourceId, speechId, request } = readTarget();
    return api.call("project/speech-proposal", {
      method: "POST",
      body: JSON.stringify({ baseRevision: p.revision, sourceId, speechId, request }),
      label: "Propondo ajuste…",
    }).then(({ res }) => { if (res.ok) onProposal(); }, () => {});
  }, (busy) => {
    button.disabled = busy;
    button.setAttribute("aria-busy", String(busy));
    button.textContent = busy ? "Propondo ajuste…" : idleLabel;
  });
}

/**
 * "Apagar cena" só sai depois de confirmar: a pergunta nomeia a cena e
 * lembra que o Desfazer volta atrás. Cancelar não chama o servidor.
 * @param {{ state: any, api: any, confirm: (message: string) => boolean }} deps
 * @returns {Promise<boolean>} se o pedido foi enviado
 */
export async function deleteScene({ state, api, confirm }, sceneId) {
  const p = state.get("project");
  const index = p ? p.scenes.findIndex((item) => item.id === sceneId) : -1;
  if (index < 0) return false;
  const scene = p.scenes[index];
  const name = "cena " + (index + 1) + (scene.objective ? " (" + scene.objective + ")" : "");
  if (!confirm("Apagar a " + name + "? Dá para voltar com Desfazer.")) return false;
  await api.call("project/edit", {
    method: "POST",
    body: JSON.stringify({ baseRevision: p.revision, action: { type: "delete-scene", sceneId } }),
    label: "Excluindo cena…",
  });
  return true;
}

/**
 * Monta a região do texto: renderiza os documentos e instala os gestos
 * Clique em mantida seleciona e busca; riscado restaura na hora; arraste
 * seleciona um intervalo e abre o menu. Setas navegam, Shift estende, e
 * Enter/Shift+F10 abrem ações; cabeçalho move/exclui a cena (excluir
 * pergunta antes, por `confirm`).
 */
export function mountTexto({ state, api, player, confirm: confirmAction = (message) => window.confirm(message) }) {
  const root = () => document.getElementById("texto");
  let drag = null;
  let suppressClick = false;
  let closeMenu = null;
  let correctionMenu = null;
  let selectionAnchor = null;
  let selectionFocus = null;
  const tabWords = new Map();

  const selection = () => state.get("selection") || new Set();
  const wordKey = (btn) => selectionKey(btn.dataset.scene, btn.dataset.take, btn.dataset.wordId);
  const blockKey = (btn) => selectionKey(btn.dataset.scene, btn.dataset.take, btn.dataset.source || "");
  const wordsInDocument = () => [...(root()?.querySelectorAll("button.word") || [])];
  const visibleWords = () => wordsInDocument().filter((btn) => {
    const details = btn.closest("details");
    return !details || details.open;
  });
  const wordForKey = (key) => wordsInDocument().find((btn) => wordKey(btn) === key);

  /** Posição editorial independente dos IDs que o alinhamento substitui. */
  function focusSnapshot(btn) {
    if (!btn) return null;
    return {
      key: wordKey(btn), block: blockKey(btn), scene: btn.dataset.scene, word: btn.dataset.wordId,
      offset: [...btn.closest(".prose").querySelectorAll("button.word")].indexOf(btn),
      visibleIndex: visibleWords().indexOf(btn),
    };
  }

  function focusTarget(snapshot) {
    if (!snapshot) return null;
    const words = visibleWords();
    const block = words.filter((btn) => blockKey(btn) === snapshot.block);
    return words.find((btn) => wordKey(btn) === snapshot.key)
      // Incluir muda a ocorrência de omitido para take, mantendo a palavra.
      || words.find((btn) => btn.dataset.scene === snapshot.scene && btn.dataset.wordId === snapshot.word)
      || block[Math.min(snapshot.offset, block.length - 1)]
      || words.find((btn) => btn.dataset.scene === snapshot.scene)
      || words[Math.max(0, Math.min(snapshot.visibleIndex, words.length - 1))];
  }

  /** Um ponto de Tab por parágrafo; a palavra visitada sobrevive ao render. */
  function paintWordTabs(focused = null) {
    for (const block of root()?.querySelectorAll(".prose") || []) {
      const words = [...block.querySelectorAll("button.word")];
      if (!words.length) continue;
      const region = blockKey(words[0]);
      const picked = words.includes(focused) ? focused
        : words.find((btn) => wordKey(btn) === tabWords.get(region)) || words[0];
      tabWords.set(region, wordKey(picked));
      for (const btn of words) {
        const tabindex = btn === picked ? "0" : "-1";
        if (btn.getAttribute("tabindex") !== tabindex) btn.setAttribute("tabindex", tabindex);
      }
    }
  }

  /** Mesmo intervalo para ponteiro e teclado, sem buracos entre linhas. */
  function selectWord(btn, extend = false, anchor = null) {
    const words = visibleWords();
    const key = wordKey(btn);
    if (anchor) selectionAnchor = anchor;
    if (!extend || !words.some((word) => wordKey(word) === selectionAnchor)) selectionAnchor = key;
    selectionFocus = key;
    const from = words.findIndex((word) => wordKey(word) === selectionAnchor);
    const to = words.indexOf(btn);
    state.set("selection", new Set(words.slice(Math.min(from, to), Math.max(from, to) + 1).map(wordKey)));
    state.set("selectedSupport", null);
    state.set("selectedScene", btn.dataset.scene);
    paintWordTabs(btn);
  }

  let lastSig = null;
  let prose = null;
  let activeWord = null;
  function render(p, sig = p ? docSignature(p) : null) {
    if (!p) return;
    paintMeta(p);
    if (sig === lastSig) {
      const el = root();
      // Mesmo conteúdo visível pode trazer um catálogo omitido mais recente.
      // Atualiza a foto e só as regiões cuja assinatura local mudou.
      prose?.update(p);
      if (el) paintSelection(el, selection());
      return;
    }
    lastSig = sig;
    const before = wordsInDocument();
    const focused = before.includes(document.activeElement) ? document.activeElement : null;
    const snapshot = focusSnapshot(focused || wordForKey(selectionFocus));
    const el = root();
    if (el && !needsEmptyGuide(p) && p.scenes.length > 0) {
      const dropzone = document.getElementById("dropzone");
      if (dropzone) dropzone.hidden = true;
      // As zonas omitidas abertas ficam no estado do documento, por cena.
      if (!prose) prose = sceneDocument(el, selection, () => {
        // Cenas e omitidos montados fora do render também ganham um ponto de Tab.
        paintWordTabs(document.activeElement);
        paintCurrentScene();
        paintPlayhead(state.get("playhead"));
      });
      prose.update(p);
    } else {
      prose?.destroy();
      prose = null;
      if (el) wordIndexes.delete(el);
      renderCenter(p);
    }
    const nextFocus = focusTarget(snapshot);
    paintWordTabs(nextFocus);
    if (focused && nextFocus) nextFocus.focus();
    paintCurrentScene();
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

  function selectScene(sceneId, supportIndex = null) {
    const p = state.get("project");
    if (!p) return;
    const scene = p.scenes.find((item) => item.id === sceneId);
    if (!scene) return;
    const group = supportIndex == null ? null : supportGroups(p, scene).find((item) => item.indices.includes(supportIndex));
    state.set("selectedSupport", group?.id ?? null);
    state.set("selectedScene", scene.id);
    selectionAnchor = null;
    selectionFocus = null;
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
      await api.call("project/edit", {
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
    await api.call("project/edit", {
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
      + '<p class="muted">cortes: ' + (summary.cuts.length ? "" : "nenhum") + "</p>"
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
  const proposeSpeech = speechProposalAction({
    state, api,
    button: speechDialog.querySelector("#proposeSpeech"),
    readTarget: () => {
      const picked = speechDialog.querySelector("#speechPick").value.split("\u0000");
      const request = speechDialog.querySelector("#speechRequest").value.trim();
      return { sourceId: picked[0], speechId: picked[1], request };
    },
    onProposal: () => paintSpeechDiff(state.get("speechProposal")),
  });
  speechDialog.querySelector("#proposeSpeech").onclick = () => proposeSpeech();
  speechDialog.querySelector("#acceptSpeech").onclick = async () => {
    const p = state.get("project");
    const proposal = state.get("speechProposal");
    if (!p || !proposal) return;
    const { res } = await api.call("project/speech-accept", {
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
    const { res } = await api.call("project/speech-reject", {
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
      const { res } = await api.call("project/support-swap", {
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
      await api.call("project/support-swap-accept", {
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
      await api.call("project/support-swap-reject", {
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
    const closeSubmittedMenu = closeMenu;
    const { res } = await api.call("project/edit", {
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
    if (res.ok && closeMenu === closeSubmittedMenu && closeMenu) closeMenu();
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
    const input = document.createElement("input");
    input.type = "text";
    input.setAttribute("aria-label", "Correção do trecho");
    input.placeholder = "Correção do trecho";
    const apply = document.createElement("button");
    apply.type = "submit";
    apply.textContent = "Aplicar";
    form.append(input, apply);
    menu.appendChild(form);
    correctionMenu = menu;
    input.focus();
    const send = singleFlight(() => submitCorrection(input.value.trim()).catch(() => {
      // api.call já apresenta o erro; o formulário conserva a correção para tentar de novo.
    }), (busy) => { input.disabled = busy; apply.disabled = busy; });
    form.onsubmit = (ev) => {
      ev.preventDefault();
      void send();
    };
  }

  /** Mede o menu já no documento e o coloca onde cabe. */
  function placeFloatMenu(menu, anchor, align) {
    menu.style.top = "0px";
    menu.style.left = "0px";
    menu.style.maxHeight = "";
    menu.style.overflowY = "";
    const rect = menu.getBoundingClientRect();
    const box = floatMenuBox(
      anchor,
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
      align,
    );
    menu.style.top = box.top + "px";
    menu.style.left = box.left + "px";
    if (box.maxHeight != null) {
      menu.style.maxHeight = box.maxHeight + "px";
      menu.style.overflowY = "auto";
    }
  }

  /** Liga um menu flutuante ao documento: fora ou Escape fecham, foco no primeiro item. */
  function attachMenu(menu, trigger, anchor, align) {
    const returnTo = trigger || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const returnSnapshot = focusSnapshot(returnTo?.dataset.wordId !== undefined ? returnTo : wordForKey(selectionFocus));
    if (trigger) trigger.setAttribute("aria-expanded", "true");
    menu.style.visibility = "hidden";
    document.body.appendChild(menu);
    if (anchor) placeFloatMenu(menu, anchor, align);
    menu.style.visibility = "";
    const onDoc = (ev) => {
      if (!menu.contains(ev.target) && closeMenu) closeMenu();
    };
    const onKey = (ev) => {
      if (ev.key === "Escape" && closeMenu) {
        ev.preventDefault();
        closeMenu();
        return;
      }
      // O campo de correção conserva setas e atalhos nativos de edição.
      if (!menu.contains(ev.target) || ev.target.closest("input,textarea,select")) return;
      if (ev.key === "Tab" && !correctionMenu) {
        if (closeMenu) closeMenu();
        return;
      }
      const items = [...menu.querySelectorAll('[role="menuitem"]')].filter((btn) => !btn.disabled);
      const index = items.indexOf(document.activeElement);
      let next;
      if (["ArrowRight", "ArrowDown"].includes(ev.key)) next = items[(index + 1) % items.length];
      else if (["ArrowLeft", "ArrowUp"].includes(ev.key)) next = items[(index - 1 + items.length) % items.length];
      else if (ev.key === "Home") next = items[0];
      else if (ev.key === "End") next = items.at(-1);
      if (next) { ev.preventDefault(); next.focus(); }
    };
    document.addEventListener("pointerdown", onDoc);
    document.addEventListener("keydown", onKey);
    closeMenu = () => {
      closeMenu = null;
      correctionMenu = null;
      document.removeEventListener("pointerdown", onDoc);
      document.removeEventListener("keydown", onKey);
      menu.remove();
      if (trigger?.isConnected) trigger.setAttribute("aria-expanded", "false");
      const target = returnTo?.isConnected && (returnTo.dataset.wordId === undefined || visibleWords().includes(returnTo))
        ? returnTo : focusTarget(returnSnapshot);
      if (target) {
        if (target.dataset.wordId !== undefined) paintWordTabs(target);
        target.focus();
      }
    };
    menu.querySelector("button:not(:disabled)")?.focus();
  }

  function openSceneMenu(btn) {
    if (closeMenu) closeMenu();
    const p = state.get("project");
    if (!p) return;
    const index = p.scenes.findIndex((scene) => scene.id === btn.dataset.sceneMenu);
    if (index < 0) return;
    const scene = p.scenes[index];
    const menu = document.createElement("div");
    menu.className = "float-menu is-list";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Ações da cena " + (index + 1));
    const rect = btn.getBoundingClientRect();
    for (const item of sceneMenuItems(index, p.scenes.length, scene.support.length > 0)) {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.textContent = item.label;
      b.dataset.sceneAction = item.action;
      b.dataset.scene = scene.id;
      b.disabled = item.disabled;
      if (item.danger) b.className = "danger";
      b.onclick = () => {
        if (closeMenu) closeMenu();
        void sceneEdit(b);
      };
      menu.appendChild(b);
    }
    attachMenu(menu, btn, rect, "end");
  }

  /** "Incluir trecho": seleciona a zona omitida inteira e inclui (mesmo POST do menu). */
  function includeZone(sceneId, sourceId) {
    const p = state.get("project");
    const scene = p?.scenes.find((item) => item.id === sceneId);
    if (!scene) return;
    state.set("selection", new Set(omittedWords(p, scene, sourceId).map((word) => selectionKey(sceneId, "", word.id))));
    void runMenuAction("incluir");
  }

  function paintCurrentScene() {
    const el = root();
    const p = state.get("project");
    if (!el || !p) return;
    const current = state.get("selectedScene") ?? p.scenes[0]?.id;
    for (const head of el.querySelectorAll(".scene-head")) {
      const on = head.dataset.scene === current;
      head.classList.toggle("is-current", on);
      head.querySelector(".num")?.classList.toggle("is-current", on);
    }
  }

  function paintMeta(p) {
    const meta = document.getElementById("textoMeta");
    if (!meta) return;
    const view = textoMetaView(p.scenes.length, p.preparation?.status === "running",
      p.scenes.length ? montageDuration(p) : 0);
    meta.hidden = view.hidden;
    meta.textContent = view.text;
    meta.classList.toggle("pill-accent", view.accent);
  }

  function openSelectionMenu(anchorRect, trigger = null) {
    if (closeMenu) closeMenu();
    const p = state.get("project");
    if (!p) return;
    const items = menuActionsFor(selectedFlags(p, selection()));
    if (!items.length) return;
    const menu = document.createElement("div");
    menu.className = "texto-menu float-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Ações do trecho");
    for (const item of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = item.label;
      if (item.danger) btn.className = "danger";
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
    attachMenu(menu, trigger, anchorRect, "start");
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
      await deleteScene({ state, api, confirm: confirmAction }, scene);
      return;
    }
    await api.call("project/edit", {
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
      const teamMode = document.querySelector('meta[name="decupa-team-mode"]')?.getAttribute("content") === "true";
      if (teamMode) window.dispatchEvent(new CustomEvent("decupa:open-media"));
      else document.getElementById("filePicker")?.click();
      return;
    }
    const sceneMenuBtn = ev.target.closest("[data-scene-menu]");
    if (sceneMenuBtn && el.contains(sceneMenuBtn)) {
      openSceneMenu(sceneMenuBtn);
      return;
    }
    const zone = ev.target.closest("[data-include-zone]");
    if (zone && el.contains(zone)) {
      includeZone(zone.dataset.scene, zone.dataset.source);
      return;
    }
    const speechAction = ev.target.closest("[data-speech-apply],[data-speech-reject]");
    if (speechAction && el.contains(speechAction)) {
      const proposal = state.get("speechProposal");
      const p = state.get("project");
      if (proposal && p) {
        void api.call(proposal && speechAction.hasAttribute("data-speech-apply")
          ? "project/speech-accept" : "project/speech-reject", {
          method: "POST",
          body: JSON.stringify({ baseRevision: p.revision, proposalId: proposal.id }),
          label: speechAction.hasAttribute("data-speech-apply") ? "Aplicando ajuste…" : "Recusando proposta…",
        });
      }
      return;
    }
    const chip = ev.target.closest(".chip-apoio");
    if (chip && el.contains(chip)) {
      // Chip é localizador, não alça: seleciona a cena (o contexto opera
      // sobre ela e o pedido NL muda o apoio); sem seek e sem edição.
      selectScene(chip.dataset.scene, Number(chip.dataset.support));
      return;
    }
    const btn = ev.target.closest("button.word");
    if (!btn || !el.contains(btn)) return;
    // Ativação assistiva sem ponteiro tem o mesmo caminho de Enter.
    if (ev.detail === 0) {
      if (!selection().has(wordKey(btn))) selectWord(btn);
      openSelectionMenu(btn.getBoundingClientRect(), btn);
      return;
    }
    selectWord(btn, ev.shiftKey);
    if (ev.shiftKey) return;
    if (btn.dataset.take === "") {
      // Zona omitida fora da montagem: clique seleciona e abre o menu.
      openSelectionMenu(btn.getBoundingClientRect(), btn);
      return;
    }
    if (btn.classList.contains("riscado")) {
      // Clique em cortado restaura na hora, sem seek (spec, Interação 3).
      const found = findWord(btn);
      if (!found) return;
      void api.call("project/edit", {
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
    // Clique em mantida posiciona a seleção e busca na montagem.
    const found = findWord(btn);
    if (!found) return;
    const t = montageTimeOfWord(state.get("project"), found.scene.id, found.take.id, found.word);
    if (t != null) {
      state.set("playhead", t);
      player.seek(t);
      state.set("selectedScene", found.scene.id);
    }
  }

  function onPointerDown(ev) {
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    // Um arraste anterior pode ter terminado fora do #texto (sem click para
    // consumir a supressão): todo gesto novo começa sem supressão pendente.
    suppressClick = false;
    const word = ev.target.closest("button.word");
    if (!word && ev.target.closest("button,summary,input,textarea,select")) return;
    drag = { x: ev.clientX, y: ev.clientY, word, extend: ev.shiftKey, moved: false };
  }

  function nearestWord(x, y, preferLast = false) {
    let nearest = null;
    let distance = Infinity;
    for (const btn of visibleWords()) {
      const rect = btn.getBoundingClientRect();
      const d = Math.hypot(Math.max(rect.left - x, 0, x - rect.right), Math.max(rect.top - y, 0, y - rect.bottom));
      if (d < distance || (preferLast && d === distance)) { nearest = btn; distance = d; }
    }
    return nearest;
  }

  function onPointerMove(ev) {
    if (!drag || (!drag.moved && Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) <= DRAG_PX)) return;
    const start = drag.word || nearestWord(drag.x, drag.y);
    // Touch usa captura implícita: event.target pode continuar na âncora.
    const target = document.elementFromPoint
      ? document.elementFromPoint(ev.clientX, ev.clientY)?.closest("button.word")
      : ev.target.closest("button.word");
    const end = root()?.contains(target) ? target : nearestWord(ev.clientX, ev.clientY, true);
    if (!start || !end) return;
    if (!drag.moved) {
      if (!drag.extend || !selectionAnchor) selectionAnchor = wordKey(start);
      drag.moved = true;
    }
    ev.preventDefault();
    selectWord(end, true);
  }

  function onPointerUp(ev) {
    if (!drag) return;
    onPointerMove(ev);
    const moved = drag.moved;
    drag = null;
    if (!moved) return;
    suppressClick = true;
    const end = wordForKey(selectionFocus);
    if (end) {
      end.focus();
      openSelectionMenu(end.getBoundingClientRect(), end);
    }
  }

  function onWordKey(ev) {
    const btn = ev.target.closest("button.word");
    if (!btn || !root()?.contains(btn) || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (["Enter", " ", "ContextMenu"].includes(ev.key) || (ev.key === "F10" && ev.shiftKey)) {
      ev.preventDefault();
      if (!selection().has(wordKey(btn))) selectWord(btn);
      openSelectionMenu(btn.getBoundingClientRect(), btn);
      return;
    }
    const words = visibleWords();
    const index = words.indexOf(btn);
    let next = null;
    if (ev.key === "ArrowLeft") next = words[Math.max(0, index - 1)];
    else if (ev.key === "ArrowRight") next = words[Math.min(words.length - 1, index + 1)];
    else if (ev.key === "Home" || ev.key === "End") {
      const block = [...btn.closest(".prose").querySelectorAll("button.word")];
      next = ev.key === "Home" ? block[0] : block.at(-1);
    } else if (ev.key === "ArrowUp" || ev.key === "ArrowDown") {
      const rect = btn.getBoundingClientRect();
      const x = (rect.left + rect.right) / 2;
      const y = (rect.top + rect.bottom) / 2;
      const direction = ev.key === "ArrowUp" ? -1 : 1;
      const rows = words.map((word) => ({ word, rect: word.getBoundingClientRect() }))
        .filter((item) => direction * ((item.rect.top + item.rect.bottom) / 2 - y) > rect.height / 2);
      // Primeira linha visual na direção escolhida, palavra mais perto de x.
      rows.sort((a, b) => direction * (a.rect.top - b.rect.top));
      const row = rows[0]?.rect;
      next = row ? rows.filter((item) => Math.abs(item.rect.top - row.top) < row.height / 2)
        .sort((a, b) => Math.abs((a.rect.left + a.rect.right) / 2 - x) - Math.abs((b.rect.left + b.rect.right) / 2 - x))[0]?.word : btn;
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      selectionAnchor = null;
      selectionFocus = null;
      state.set("selection", new Set());
      return;
    } else return;
    ev.preventDefault();
    if (!next) return;
    const anchor = selectionFocus === wordKey(btn) ? null : wordKey(btn);
    selectWord(next, ev.shiftKey, anchor);
    next.focus();
  }

  function sameKeys(a, b) {
    if (a === b) return true;
    if (!a || !b || a.size !== b.size) return false;
    for (const key of a) if (!b.has(key)) return false;
    return true;
  }

  state.subscribe("project", (p) => {
    if (!p) {
      if (closeMenu) closeMenu();
      prose?.destroy();
      prose = null;
      lastSig = null;
      return;
    }
    const pruned = pruneSelection(p, selection());
    const lost = !sameKeys(pruned, selection());
    const sig = docSignature(p);
    // Reconciliação de conflito pode mudar outra parte do documento. Enquanto
    // as palavras seguem válidas, a correção digitada fica disponível para retry.
    if (closeMenu && (lost || (sig !== lastSig && !correctionMenu))) closeMenu();
    if (lost) state.set("selection", pruned);
    render(p, sig);
  });
  state.subscribe("selection", (next) => {
    const el = root();
    if (el) paintSelection(el, next || new Set());
  });

  /** Acende só a palavra sob o playhead: troca duas classes, sem varrer a prosa. */
  function paintPlayhead(playhead) {
    const el = root();
    if (!el || el.hidden) return;
    const hit = wordAtPlayhead(state.get("project"), playhead);
    const target = hit
      ? wordIndex(el).buttons.get(selectionKey(hit.sceneId, hit.takeId, hit.wordId))
      : null;
    if (activeWord !== target) activeWord?.classList.remove("ativa");
    target?.classList.add("ativa");
    activeWord = target;
  }
  state.subscribe("playhead", (t) => paintPlayhead(t));
  state.subscribe("selectedScene", (sceneId) => {
    prose?.ensure(sceneId);
    paintCurrentScene();
  });

  const el = root();
  if (el) {
    el.addEventListener("click", onClick);
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("keydown", onWordKey);
    el.addEventListener("focusin", (ev) => {
      const word = ev.target.closest("button.word");
      if (word) paintWordTabs(word);
    });
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", () => { drag = null; });
  }
  render(state.get("project"));
}
