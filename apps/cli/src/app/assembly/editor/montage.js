// Lógica pura de montagem (sem DOM): espelhos das funções de words.ts do
// servidor mais os tempos de montagem usados pelas regiões do editor.
// Recebe `project` como argumento; nunca lê estado global.

/**
 * Catálogo efetivo de palavras da fonte (espelho de effectiveWords do
 * servidor): o reconhecido com as correções `aligned` substituídas no
 * intervalo corrigido. Correções `pending`/`error` não alteram o catálogo.
 */
export function effectiveWords(project, sourceId) {
  const analysis = project.analyses.find((item) => item.sourceId === sourceId);
  if (!analysis) return [];
  let words = [...analysis.words];
  for (const correction of project.corrections) {
    if (correction.sourceId !== sourceId) continue;
    if (correction.status !== "aligned" || !correction.words.length) continue;
    words = words.filter(
      (word) => !(word.start < correction.end && correction.start < word.end),
    );
    words.push(...correction.words);
  }
  return words.sort((a, b) => a.start - b.start || a.end - b.end);
}

function inRanges(ranges, start, end) {
  return ranges.some((range) => range.start < end && start < range.end);
}

export function normalizeRanges(ranges) {
  const ordered = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const range of ordered) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ start: range.start, end: range.end });
  }
  return merged;
}

/** Intervalos retidos de um take: o take menos as remoções. */
export function retainedOfTake(take) {
  const bounds = [{ start: take.start, end: take.end }];
  const inside = (take.removed || [])
    .map((range) => ({
      start: Math.max(range.start, take.start),
      end: Math.min(range.end, take.end),
    }))
    .filter((range) => range.start < range.end);
  let current = normalizeRanges(bounds);
  for (const cut of normalizeRanges(inside)) {
    const next = [];
    for (const range of current) {
      if (cut.end <= range.start || cut.start >= range.end) {
        next.push(range);
        continue;
      }
      if (cut.start > range.start) next.push({ start: range.start, end: cut.start });
      if (cut.end < range.end) next.push({ start: cut.end, end: range.end });
    }
    current = next;
  }
  return current;
}

export function retainedDuration(take) {
  return retainedOfTake(take).reduce((sum, range) => sum + (range.end - range.start), 0);
}

/**
 * Posição na montagem (segundos) do início de uma palavra: soma das
 * durações retidas dos takes anteriores na ordem das cenas mais o deslocamento
 * da palavra dentro do próprio take (descontando remoções anteriores).
 */
export function montageTimeOfWord(project, sceneId, takeId, word) {
  let elapsed = 0;
  for (const scene of project.scenes) {
    for (const take of scene.takes) {
      if (scene.id === sceneId && take.id === takeId) {
        let offset = word.start - take.start;
        for (const range of normalizeRanges(take.removed || [])) {
          if (range.end <= word.start) offset -= range.end - Math.max(range.start, take.start);
        }
        return Math.max(0, elapsed + Math.max(0, offset));
      }
      elapsed += retainedDuration(take);
    }
  }
  return null;
}

/** Palavras da fonte fora da seleção atual da cena (para inclusão). */
export function omittedWords(project, scene, sourceId) {
  const retained = scene.takes
    .filter((take) => take.sourceId === sourceId)
    .flatMap((take) => retainedOfTake(take));
  return effectiveWords(project, sourceId).filter(
    (word) => !retained.some((range) => range.start < word.end && word.start < range.end),
  );
}

/** Palavras do take com marcas de remoção/proteção/correção. */
export function takeWords(project, scene, take) {
  const kept = [];
  for (const word of effectiveWords(project, take.sourceId)) {
    if (word.start < take.start || word.end > take.end) continue;
    const removed = take.removed ? inRanges(take.removed, word.start, word.end) : false;
    const keptWord = { ...word, takeId: take.id, sceneId: scene.id, removed };
    keptWord.protected = take.protected ? inRanges(take.protected, word.start, word.end) : false;
    kept.push(keptWord);
  }
  // O catálogo acima já reflete as correções alinhadas; IDs de correção
  // têm o formato `${sourceId}:${sha}:c:${correctionId}:wNNNNNN`.
  return kept.map((word) => ({
    ...word,
    corrected: word.id.includes(":c:"),
    display: word.text,
  }));
}

export function timelineBlocks(project) {
  const blocks = [];
  let cursor = 0;
  for (const scene of project.scenes) {
    let sceneEnd = cursor;
    for (const take of scene.takes) {
      const dur = retainedDuration(take);
      sceneEnd += dur;
    }
    blocks.push({ kind: "scene", sceneId: scene.id,
      label: scene.objective || scene.id, start: cursor, end: sceneEnd });
    const fps = project.assembly.fps.num / project.assembly.fps.den;
    for (const group of supportGroups(project, scene)) {
      const start = cursor + group.offsetFrames / fps;
      blocks.push({kind:"support",sceneId:scene.id,groupId:group.id,label:group.description,
        start,end:start+group.durationFrames/fps});
    }
    cursor = sceneEnd;
  }
  return blocks;
}

/**
 * Trechos retidos na ordem da montagem, para o waveform da faixa: cada
 * intervalo retido de cada take vira um segmento com a posição na fonte e
 * na montagem. Apoio não entra (não tem áudio próprio).
 */
export function retainedSegments(project) {
  const segments = [];
  let cursor = 0;
  for (const scene of project.scenes) {
    for (const take of scene.takes) {
      for (const range of retainedOfTake(take)) {
        const montageStart = cursor;
        cursor += range.end - range.start;
        segments.push({
          sourceId: take.sourceId,
          srcStart: range.start,
          srcEnd: range.end,
          montageStart,
          montageEnd: cursor,
        });
      }
    }
  }
  return segments;
}

export function montageDuration(project) {
  const blocks = timelineBlocks(project);
  return blocks.reduce((max, b) => Math.max(max, b.end), 0);
}

/**
 * Palavra retida sob o playhead da montagem (pura). Usa o mesmo eixo de
 * montageTimeOfWord: a prosa acende o botão cujo intervalo contém t.
 */
export function wordAtPlayhead(project, playhead) {
  if (typeof playhead !== "number" || !Number.isFinite(playhead) || !project) return null;
  let best = null;
  let bestStart = -Infinity;
  for (const scene of project.scenes) {
    for (const take of scene.takes) {
      for (const word of takeWords(project, scene, take)) {
        if (word.removed) continue;
        const start = montageTimeOfWord(project, scene.id, take.id, word);
        if (start == null) continue;
        const srcStart = word.cutStart ?? word.start;
        const srcEnd = word.cutEnd ?? word.end;
        const end = start + Math.max(0, srcEnd - srcStart);
        if (playhead >= start && playhead < end && start >= bestStart) {
          best = { sceneId: scene.id, takeId: take.id, wordId: word.id };
          bestStart = start;
        }
      }
    }
  }
  return best;
}

/** Um apoio visual contínuo pode ocupar vários spans de análise. */
export function supportGroups(project, scene) {
  const catalog=new Map(project.analyses.flatMap(a=>a.visual).map(v=>[v.id,v]));
  const fps=project.assembly.fps.num/project.assembly.fps.den,groups=[];
  for(const [index,entry] of scene.support.map((e,i)=>[i,e]).sort((a,b)=>a[1].offsetFrames-b[1].offsetFrames)) {
    const span=catalog.get(entry.visualId),previous=groups.at(-1),sourceStart=span?Math.round(span.start*fps):null;
    if(span && previous && previous.sourceId===span.sourceId && previous.sourceEnd===sourceStart && previous.offsetFrames+previous.durationFrames===entry.offsetFrames) {
      previous.durationFrames+=entry.durationFrames;previous.sourceEnd+=entry.durationFrames;previous.indices.push(index);
    } else groups.push({id:entry.visualId+":"+entry.offsetFrames,sourceId:span?.sourceId,sourceStart,sourceEnd:sourceStart===null?null:sourceStart+entry.durationFrames,
      description:span?.text||entry.visualId,offsetFrames:entry.offsetFrames,durationFrames:entry.durationFrames,indices:[index]});
  }
  return groups;
}
export function replaceSupportGroup(project,scene,groupId,entries) {
  const indices=new Set(supportGroups(project,scene).find(g=>g.id===groupId)?.indices||[]);
  return [...scene.support.filter((_,i)=>!indices.has(i)),...entries].sort((a,b)=>a.offsetFrames-b.offsetFrames);
}
export function candidateEntries(candidate,offsetFrames,durationFrames) {
  if(!Number.isSafeInteger(offsetFrames)||offsetFrames<0||!Number.isSafeInteger(durationFrames)||durationFrames<=0) throw Error("Início e duração inválidos");
  const available=candidate.entries.reduce((n,e)=>n+e.durationFrames,0);
  if(durationFrames>available) throw Error("Duração maior que o apoio disponível");
  return candidate.entries.filter(e=>e.offsetFrames<durationFrames).map(e=>({...e,offsetFrames:e.offsetFrames+offsetFrames,durationFrames:Math.min(e.durationFrames,durationFrames-e.offsetFrames)}));
}
