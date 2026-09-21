import { approvedSnapshot, validateTemplateReport } from "../templates/store.ts";
import type { Recipe } from "../templates/types.ts";
import { validateAnimationNotes } from "./handoff.ts";
import { selectBroll } from "./broll.ts";
import { decideAssemblyCuts, resolveCutCandidates, type AssemblyDecisionContext, validateDecisionReport } from "./assembly-decisions.ts";
import { randomUUID } from "node:crypto";
import type { Executor } from "../pipeline.ts";
import { createAnalysisClient } from "@decupa/triage";
import type {
  Assembly,
  Clip,
  Project,
  Proposal,
  Scene,
  Source,
  Span,
  SpeechTake,
  VisualSpan,
} from "./types.ts";
import { parseModelJson, requestValidated } from "./model-response.ts";
import { validateAssembly } from "./validate.ts";
import { effectiveWords, retainedRanges, subtractRanges, tightenSpeechTake } from "./words.ts";

export const SCENE_PROMPT = `Você monta a sequência de cenas a partir das unidades de fala e mapa abaixo.
- Informe objective e rationale por cena. Opcionalmente retorne cutCandidates: [{sceneId, speechId, reason}] para remoção de um take completo que ainda esteja presente nas cenas propostas. Não execute esses cortes na proposta: a decisão será feita separadamente. Duração alvo não autoriza truncar uma frase.
- Monte a sequência de cenas usando apenas estes IDs de fala e este mapa visual (com confiança e cobertura); explique lacunas em gaps.
- Para cada cena, devolva \`selections\` ordenada: {"takeId"} reaproveita um take existente com todos os cortes e proteções; {"speechId"} acrescenta fala do catálogo como take novo.
- Nunca proponha speechId de um take já existente na mesma cena: use takeId para preservar cortes e proteções.
- Fontes têm categoria (role): speech, support ou both. Fala usa fontes speech/both; apoio usa fontes support/both. Fala nunca vira apoio de outra cena por acidente; fala + apoio autoriza ambos os usos na mesma cena.
- Para cada cena com apoio visual adequado, devolva \`visualEvidenceIds\` com os IDs observados que fundamentam as escolhas (observed ou uncertain; unavailable nunca fundamenta escolha).
- Não corte frase ou nome para caber no tempo: use falas inteiras. Pedido inviável retorna lacuna visível em gaps para revisão.
- Devolva a lista completa de cenas na ordem final; preserve IDs de cenas existentes não alteradas; para cenas fora de changedSceneIds, devolva só o id (o servidor preserva o restante).
- Não repita falas entre cenas. Proibido inventar IDs, tempos ou categorias — o servidor rejeita referências fora deste catálogo.`;

export function speechCatalog(project: Project): Map<string, Span> {
  const catalog = new Map<string, Span>();
  for (const analysis of project.analyses) {
    for (const span of analysis.speech) catalog.set(span.id, span);
  }
  return catalog;
}

export function visualCatalog(project: Project): Map<string, VisualSpan> {
  const catalog = new Map<string, VisualSpan>();
  for (const analysis of project.analyses) {
    for (const span of analysis.visual) catalog.set(span.id, span);
  }
  return catalog;
}

function takeCatalog(project: Project): Map<string, SpeechTake> {
  const catalog = new Map<string, SpeechTake>();
  for (const scene of project.scenes) {
    for (const take of scene.takes) catalog.set(take.id, take);
  }
  return catalog;
}

export function validateProposal(raw: unknown, project: Project): Proposal {
  if (!isRecord(raw)) throw new Error("proposta precisa ser um objeto");
  if (typeof raw.id !== "string") throw new Error("proposta.id precisa ser texto");
  if (Number(raw.baseRevision) !== project.revision) {
    throw new Error(
      `proposta com revisão desatualizada: base ${String(raw.baseRevision)}, atual ${project.revision}`,
    );
  }
  if (!Array.isArray(raw.scenes)) throw new Error("proposta.scenes precisa ser um array");
  if (!Array.isArray(raw.changedSceneIds)) throw new Error("changedSceneIds precisa ser um array");
  const changed = new Set(raw.changedSceneIds.map(String));
  const speech = speechCatalog(project);
  const visual = visualCatalog(project);
  const takes = takeCatalog(project);
  const sources = new Map(project.assembly.sources.map((source) => [source.id, source]));
  const currentById = new Map(project.scenes.map((scene) => [scene.id, scene]));
  const scenes: Scene[] = [];
  const seenIds = new Set<string>();
  for (const [index, item] of raw.scenes.entries()) {
    if (!isRecord(item) || typeof item.id !== "string") {
      throw new Error(`cena ${index} precisa de id`);
    }
    if (seenIds.has(item.id)) throw new Error(`cena duplicada na proposta: ${item.id}`);
    seenIds.add(item.id);
    const current = currentById.get(item.id);
    if (!current) {
      if (!changed.has(item.id)) {
        throw new Error(`cena nova ${item.id} precisa estar em changedSceneIds`);
      }
      scenes.push(resolveScene(item, index, null, { speech, visual, takes, sources, project }));
      continue;
    }
    if (!changed.has(item.id)) {
      // Fora do escopo: eco só-com-id ou eco fiel preserva; divergência rejeita.
      const keys = Object.keys(item).filter((key) => key !== "id");
      if (keys.length === 0) {
        scenes.push(current);
        continue;
      }
      const resolved = resolveScene(item, index, current, { speech, visual, takes, sources, project });
      if (canonical(resolved) !== canonical(current)) {
        throw new Error(`cena ${item.id} modificada fora do escopo (changedSceneIds)`);
      }
      scenes.push(current);
      continue;
    }
    scenes.push(resolveScene(item, index, current, { speech, visual, takes, sources, project }));
  }
  for (const id of changed) {
    if (!seenIds.has(id)) throw new Error(`changedSceneIds referencia cena ausente: ${id}`);
  }
  for (const previous of project.scenes.filter(scene => scene.support.length)) {
    const next = scenes.find(scene => scene.id === previous.id);
    if (!next || canonical(next.support) !== canonical(previous.support)) {
      throw Error(`apoio existente da cena ${previous.id} exige edição manual`);
    }
    const supports = (scene: Scene) => compileScenes(project, [scene]).tracks.find(track => track.name === "V2")!.clips;
    if (canonical(supports(previous)) !== canonical(supports(next))) {
      throw Error(`ajuste truncaria apoio existente da cena ${previous.id}; ajuste o apoio manualmente primeiro`);
    }
  }
  const annotated = annotateSupport(project, scenes);
  return {
    id: String(raw.id),
    baseRevision: Number(raw.baseRevision),
    scenes: annotated,
    changedSceneIds: raw.changedSceneIds.map(String),
    explanation: String(raw.explanation ?? ""),
    ...(raw.template !== undefined ? {template:approvedSnapshot(raw.template),templateReport:validateTemplateReport(raw.templateReport??[],approvedSnapshot(raw.template))} : {}),
  };
}

/** Revalida o resultado interno sem converter takes existentes em falas novas. */
export function validateResolvedProposal(proposal: Proposal, project: Project): Proposal {
  const existing = takeCatalog(project);
  const valid = validateProposal({...proposal, scenes: proposal.scenes.map(scene => ({
    ...scene,
    ...(scene.takes ? {selections: scene.takes.map(take => existing.has(take.id) ? {takeId: take.id} : {speechId: take.speechId})} : {}),
  }))}, project);
  if (proposal.decisionReport !== undefined) valid.decisionReport = validateDecisionReport(proposal.decisionReport);
  return valid;
}

type Catalogs = {
  project?: Project;
  speech: Map<string, Span>;
  visual: Map<string, VisualSpan>;
  takes: Map<string, SpeechTake>;
  sources: Map<string, Source>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Selection = { takeId: string } | { speechId: string };

function parseSelections(item: Record<string, unknown>, index: number): Selection[] {
  const raw = item.selections ?? (Array.isArray(item.speechIds)
    ? (item.speechIds as unknown[]).map((id) => ({ speechId: String(id) }))
    : undefined);
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`cena ${index} com selections inválido`);
  return raw.map((entry, i) => {
    if (!isRecord(entry)) throw new Error(`cena ${index} com seleção ${i} inválida`);
    const takeId = entry.takeId !== undefined ? String(entry.takeId) : null;
    const speechId = entry.speechId !== undefined ? String(entry.speechId) : null;
    if (!takeId === !speechId) {
      throw new Error(`cena ${index} com seleção ${i} ambígua: use takeId ou speechId`);
    }
    return (takeId ? { takeId } : { speechId: speechId! }) as Selection;
  });
}

function requireSpeechRole(source: Source | undefined, label: string): Source {
  if (!source) throw new Error(`${label} referencia fonte ausente`);
  if (source.role !== "speech" && source.role !== "both") {
    throw new Error(`${label} usa fonte ${source.id} de categoria ${source.role} para fala`);
  }
  return source;
}

function resolveScene(
  item: Record<string, unknown>,
  index: number,
  current: Scene | null,
  catalogs: Catalogs,
): Scene {
  const id = item.id as string;
  const selections = parseSelections(item, index);
  const currentTakeIds = new Set((current?.takes ?? []).map((take) => take.id));
  const currentSpeechIds = new Set((current?.takes ?? []).map((take) => take.speechId));
  const takes: SpeechTake[] = [];
  const speechIds: string[] = [];
  for (const selection of selections) {
    if ("takeId" in selection) {
      const take = catalogs.takes.get(selection.takeId);
      if (!take) throw new Error(`take inexistente na proposta: ${selection.takeId}`);
      requireSpeechRole(catalogs.sources.get(take.sourceId), `take ${take.id}`);
      takes.push({ ...take, removed: [...take.removed], protected: [...take.protected] });
      if (take.speechId) speechIds.push(take.speechId);
      continue;
    }
    const span = catalogs.speech.get(selection.speechId);
    if (!span) throw new Error(`referência de fala inexistente: ${selection.speechId}`);
    const source = requireSpeechRole(
      catalogs.sources.get(span.sourceId),
      `fala ${selection.speechId}`,
    );
    if (currentSpeechIds.has(selection.speechId) || currentTakeIds.has(`${id}:${selection.speechId}`)) {
      throw new Error(
        `fala ${selection.speechId} já tem take na cena ${id}: use takeId para preservar cortes`,
      );
    }
    const newTake:SpeechTake={
      id: `${id}:${selection.speechId}`,
      sourceId: source.id,
      speechId: span.id,
      start: span.start,
      end: span.end,
      removed: [],
      protected: [],
    };
    takes.push(catalogs.project?tightenSpeechTake(catalogs.project,newTake):newTake);
    speechIds.push(span.id);
  }
  const evidence = Array.isArray(item.visualEvidenceIds)
    ? item.visualEvidenceIds.map(String)
    : [];
  for (const evidenceId of evidence) {
    const span = catalogs.visual.get(evidenceId);
    if (!span) throw new Error(`referência visual inexistente: ${evidenceId}`);
    if (span.confidence === "unavailable") {
      throw new Error(`evidência visual ${evidenceId} indisponível não fundamenta escolha`);
    }
    const evidenceSource = catalogs.sources.get(span.sourceId);
    if (evidenceSource && !evidenceSource.included) {
      throw new Error(`evidência ${evidenceId} de fonte excluída do escopo: ${span.sourceId}`);
    }
  }
  for (const take of takes) {
    const takeSource = catalogs.sources.get(take.sourceId);
    if (takeSource && !takeSource.included) {
      throw new Error(`take ${take.id} usa fonte excluída do escopo: ${take.sourceId}`);
    }
  }
  const support = Array.isArray(item.support) ? item.support : [];
  const gaps = Array.isArray(item.gaps) ? (item.gaps as unknown[]).map(String) : [];
  const scene: Scene = {
    id,
    ...((item.animationNotes ?? current?.animationNotes) !== undefined ? {animationNotes: validateAnimationNotes(item.animationNotes ?? current?.animationNotes)} : {}),
    objective: String(item.objective ?? current?.objective ?? ""),
    rationale: String(item.rationale ?? current?.rationale ?? ""),
    speechIds: [...new Set(speechIds)],
    takes,
    visualEvidenceIds: evidence,
    support: support.map((entry, i) => validateSupport(entry, i, catalogs, id)),
    gaps,
  };
  if (current) checkProtectionKept(current, scene);
  return scene;
}

function validateSupport(
  entry: unknown,
  i: number,
  catalogs: Catalogs,
  sceneId: string,
): Scene["support"][number] {
  if (!isRecord(entry)) throw new Error(`apoio ${i} da cena ${sceneId} precisa ser um objeto`);
  const visualId = String(entry.visualId ?? "");
  const span = catalogs.visual.get(visualId);
  if (!span) throw new Error(`referência visual inexistente: ${visualId}`);
  const source = catalogs.sources.get(span.sourceId);
  if (!source) throw new Error(`apoio ${visualId} referencia fonte ausente ${span.sourceId}`);
  if (!source.included) {
    throw new Error(`apoio ${visualId} usa fonte excluída do escopo: ${source.id}`);
  }
  if (source.role !== "support" && source.role !== "both") {
    throw new Error(`apoio ${visualId} usa fonte ${source.id} de categoria ${source.role}`);
  }
  const offsetFrames = Number(entry.offsetFrames);
  const durationFrames = Number(entry.durationFrames);
  if (!Number.isInteger(offsetFrames) || offsetFrames < 0) {
    throw new Error(`apoio ${visualId} com offset inválido`);
  }
  if (!Number.isInteger(durationFrames) || durationFrames <= 0) {
    throw new Error(`apoio ${visualId} com duração inválida`);
  }
  const sourceEnd = source.durationSeconds;
  if (span.end > sourceEnd + 0.001) {
    throw new Error(`apoio ${visualId} termina depois da fonte ${source.id}`);
  }
  return { visualId, offsetFrames, durationFrames };
}

/** Ajuste automático nunca remove intervalo protegido sem rejeitar. */
function checkProtectionKept(current: Scene, next: Scene): void {
  const bySource = new Map<string, { start: number; end: number }[]>();
  for (const take of next.takes) {
    const list = bySource.get(take.sourceId) ?? [];
    list.push(...retainedRanges(take));
    bySource.set(take.sourceId, list);
  }
  for (const take of current.takes) {
    if (take.protected.length === 0) continue;
    const retained = bySource.get(take.sourceId) ?? [];
    const lost = subtractRanges(take.protected, retained);
    if (lost.length > 0) {
      throw new Error(
        `proposta remove trecho protegido do take ${take.id}: libere a proteção antes`,
      );
    }
  }
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
      );
    }
    return entry;
  });
}

function legacyTakes(scene: Scene, speech: Map<string, Span>): SpeechTake[] {
  return scene.speechIds.map((id) => {
    const span = speech.get(id);
    if (!span) throw new Error(`referência de fala inexistente: ${id}`);
    return {
      id: `${scene.id}:${span.id}`,
      sourceId: span.sourceId,
      speechId: span.id,
      start: span.start,
      end: span.end,
      removed: [],
      protected: [],
    };
  });
}

function emptyAssembly(project: Project): Assembly {
  const tracks = [
    { kind: "Video", name: "V1", clips: [] },
    { kind: "Video", name: "V2", clips: [] },
    { kind: "Audio", name: "A1", clips: [] },
  ] as Assembly["tracks"];
  return {
    version: 1,
    revision: project.assembly.revision,
    name: project.assembly.name,
    fps: project.assembly.fps,
    width: project.assembly.width,
    height: project.assembly.height,
    rhythmProfile: project.assembly.rhythmProfile,
    sources: project.assembly.sources,
    tracks,
  };
}

export function compileScenes(project: Project, scenes: Scene[]): Assembly {
  const speech = speechCatalog(project);
  const visual = visualCatalog(project);
  const fpsNum = project.assembly.fps.num;
  const fpsDen = project.assembly.fps.den;
  const toFrames = (seconds: number): number => Math.round((seconds * fpsNum) / fpsDen);
  const toSeconds = (frames: number): number => (frames * fpsDen) / fpsNum;
  const bySource = new Map(project.assembly.sources.map((source) => [source.id, source]));
  const v1: Clip[] = [];
  const v2: Clip[] = [];
  const a1: Clip[] = [];
  let cursor = 0;
  const bounds = new Map<string, { start: number; end: number }>();
  for (const scene of scenes) {
    const sceneStart = cursor;
    const takes = scene.takes.length > 0 ? scene.takes : legacyTakes(scene, speech);
    for (const take of takes) {
      const source = bySource.get(take.sourceId);
      if (!source) throw new Error(`take ${take.id} referencia fonte ausente ${take.sourceId}`);
      retainedRanges(take).forEach((fragment, i) => {
        const first = Math.floor((fragment.start * fpsNum) / fpsDen);
        const lastRounded = Math.round((fragment.end * fpsNum) / fpsDen);
        const last = Math.max(first + 1, lastRounded);
        if (last <= first) return;
        const id = `${scene.id}-${take.id}#${i}`;
        const clip = {
          id,
          sceneId: scene.id,
          sourceId: take.sourceId,
          sourceStartSeconds: toSeconds(first),
          startFrame: cursor,
          durationFrames: last - first,
        };
        if (source.hasVideo) v1.push({ ...clip, id: `${id}-v` });
        if (source.hasAudio) a1.push({ ...clip, id: `${id}-a` });
        cursor += last - first;
      });
    }
    bounds.set(scene.id, { start: sceneStart, end: cursor });
    for (const item of scene.support) {
      const span = visual.get(item.visualId);
      if (!span) throw new Error(`referência visual inexistente: ${item.visualId}`);
      const source = bySource.get(span.sourceId);
      if (!source) throw new Error(`apoio ${item.visualId} referencia fonte ausente ${span.sourceId}`);
      if (!source.hasVideo) continue;
      const sceneBounds = bounds.get(scene.id)!;
      const available = sceneBounds.end - (sceneBounds.start + item.offsetFrames);
      const srcAvailable = toFrames(span.end) - toFrames(span.start);
      const durationFrames = Math.min(item.durationFrames, available, srcAvailable);
      // Apoio sem duração na cena é descartado aqui e anotado na validação;
      // nunca atravessa outra cena silenciosamente.
      if (durationFrames <= 0) continue;
      v2.push({
        id: `${scene.id}-${item.visualId}-${item.offsetFrames}`,
        sceneId: scene.id,
        sourceId: span.sourceId,
        sourceStartSeconds: toSeconds(toFrames(span.start)),
        startFrame: sceneBounds.start + item.offsetFrames,
        durationFrames,
      });
    }
  }
  return validateAssembly({
    ...emptyAssembly(project),
    tracks: [
      { kind: "Video", name: "V1", clips: v1 },
      { kind: "Video", name: "V2", clips: v2 },
      { kind: "Audio", name: "A1", clips: a1 },
    ],
    revision: project.assembly.revision,
  });
}

/**
 * Anota no rationale o apoio limitado à duração disponível, comparando o
 * pedido com o compilado. Lacunas do modelo (gaps) seguem intactas.
 */
function annotateSupport(project: Project, scenes: Scene[]): Scene[] {
  const compiled = compileScenes(project, scenes);
  const v2 = new Map(
    compiled.tracks.flatMap((track) => track.name === "V2" ? track.clips : []).map((clip) => [clip.id, clip]),
  );
  return scenes.map((scene) => {
    const notes: string[] = [];
    for (const item of scene.support) {
      const clip = v2.get(`${scene.id}-${item.visualId}-${item.offsetFrames}`);
      if (!clip) {
        notes.push(`apoio ${item.visualId} removido: sem duração na cena`);
      } else if (clip.durationFrames < item.durationFrames) {
        notes.push(`apoio ${item.visualId} limitado a ${clip.durationFrames}f`);
      }
    }
    if (notes.length === 0) return scene;
    return { ...scene, rationale: `${scene.rationale} [${notes.join("; ")}]`.trim() };
  });
}

export function effectiveSpanText(project: Project, sourceId: string, span: Span): string {
  const words = effectiveWords(project, sourceId)
    .filter((word) => word.start < span.end && span.start < word.end)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  if (words.length === 0) return span.text;
  return words.map((word) => word.text).join(" ");
}

export async function proposeScenes(
  project: Project,
  input: string,
  signal: AbortSignal,
  deps?: { send: (content: unknown[], signal?: AbortSignal) => Promise<string>; model?: string; template?: Recipe | null; decision?: AssemblyDecisionContext; onDecision?: (note: string) => Promise<void> },
  _exec?: Executor,
): Promise<Proposal> {
  const client = deps ?? {
    send: (content: unknown[], signal?: AbortSignal) => createAnalysisClient().send(content, signal),
  };
  // Snapshot profundo: mutação do chamador durante o send não contamina
  // nem o prompt nem a validação.
  const snapshot: Project = structuredClone(project);
  const selected=deps?.template===undefined?project.template:deps.template;
  const template=approvedSnapshot(selected);
  snapshot.template=template;
  const inScope = new Set(
    snapshot.assembly.sources.filter((source) => source.included).map((source) => source.id),
  );
  const speech = snapshot.analyses
    .filter((analysis) => inScope.has(analysis.sourceId))
    .flatMap((analysis) =>
      analysis.speech.map((span) => ({
        id: span.id,
        sourceId: span.sourceId,
        start: span.start,
        end: span.end,
        text: effectiveSpanText(snapshot, span.sourceId, span),
      }))
    );
  // A proposta organiza falas; o catálogo completo fica na seleção de b-roll.
  const retainedVisualIds = new Set(snapshot.scenes.flatMap(scene => [
    ...scene.visualEvidenceIds, ...scene.support.map(item => item.visualId),
  ]));
  const visual = snapshot.analyses
    .filter((analysis) => inScope.has(analysis.sourceId))
    .flatMap((analysis) =>
      analysis.visual.filter(span => retainedVisualIds.has(span.id)).map((span) => ({
        id: span.id,
        sourceId: span.sourceId,
        start: span.start,
        end: span.end,
        text: span.text,
        confidence: span.confidence,
        tags: span.tags,
      }))
    );
  const missingVisual = snapshot.analyses.flatMap((analysis) => analysis.visualCoverage.missing).length;
  const content = [
    {
      type: "text",
      text: [
        SCENE_PROMPT,
        "Monte a narrativa pelas falas. O mapa visual contém apenas evidências já usadas nas cenas atuais; a ausência de outras imagens neste prompt não significa falta de cobertura. A seleção automática de apoio será feita separadamente pelo Jev usando o catálogo completo: não acrescente support nem visualEvidenceIds a cenas novas. Preserve os apoios e evidências atuais.",
        ...(template ? ["Use a receita editorial como orientação adaptável: preserve sentido das falas, não copie mídia nem texto da referência, não force número de cenas. Relate cada orientação ativa em templateReport:[{ruleId,status:applied|adapted|unavailable,reason}]. Animações não executadas entram em scenes[].animationNotes:[{id,description,destination:Resolve|After Effects}], nunca como efeito já produzido. Formato e duração são orientações; sinalize adaptações às configurações e ao conteúdo deste projeto.",`receita: ${JSON.stringify({id:template.id,revision:template.revision,rules:template.rules.filter(r=>r.enabled)})}`] : []),
        `briefing salvo: ${JSON.stringify(snapshot.input)}`,
        `pedido adicional: ${input}`,
        `fontes: ${JSON.stringify(snapshot.assembly.sources.map((source) => ({
          id: source.id,
          name: source.name,
          role: source.role,
          included: source.included,
          durationSeconds: source.durationSeconds,
        })))}`,
        `unidades de fala e mapa: ${JSON.stringify({ speech, visual })}`,
        `cobertura visual: ${missingVisual} segundo(s) sem exame`,
        `fontes excluídas do escopo: ${JSON.stringify(snapshot.assembly.sources.filter((source) => !source.included).map((source) => source.id))}`,
        `cenas atuais: ${JSON.stringify(snapshot.scenes)}`,
        `responda somente o JSON da proposta: {id, baseRevision: ${snapshot.revision}, scenes, changedSceneIds, explanation}`,
      ].join("\n\n"),
    },
  ];
  const generated = await requestValidated(content, (parts, requestSignal) => client.send(parts, requestSignal), (text) => {
    const raw = parseModelJson(text) as Record<string, unknown>;
    if (Array.isArray(raw.scenes)) raw.scenes = raw.scenes.map((item: Record<string, unknown>) => {
      const previous = snapshot.scenes.find(s => s.id === item.id);
      if (previous?.support.length && Array.isArray(raw.changedSceneIds) && raw.changedSceneIds.includes(item.id)) return {...item, support: previous.support, visualEvidenceIds: [...new Set([...previous.visualEvidenceIds,...previous.support.map(e=>e.visualId)])]};
      if (!previous?.support.length && Array.isArray(item.support) && item.support.length) throw Error("apoio novo deve ser escolhido pelo Jev, retorne support vazio");
      return item;
    });
    const proposal = validateProposal({ ...raw, template, templateReport:template?raw.templateReport:[], id: randomUUID(), baseRevision: snapshot.revision }, snapshot);
    return {proposal, candidates: resolveCutCandidates(snapshot, proposal, raw.cutCandidates)};
  }, signal);
  signal.throwIfAborted();
  if (generated.candidates.length && deps?.decision?.client && deps.decision.mode !== "off") await deps.onDecision?.("Jev avaliando cortes");
  const decisionProject = {...snapshot, preparation: snapshot.preparation ? {...snapshot.preparation, request: input} : null};
  // O pedido adicional também existe na rota legada, sem Preparation persistida.
  if (!decisionProject.preparation) decisionProject.preparation = {id:"decision",revision:snapshot.revision,mode:"adjust",request:input,status:"running",stage:"proposal",sources:{}};
  const context = deps?.decision ?? {mode:"off" as const,model:"jev-latest"};
  const decided = await decideAssemblyCuts(decisionProject, generated.proposal, generated.candidates, context, signal);
  return selectBroll(decisionProject, decided, context, signal, () => deps?.onDecision?.("Jev escolhendo imagens de apoio") ?? Promise.resolve());
}

export function setSceneSupport(project: Project, sceneId: string, support: Scene["support"]): Scene[] {
  const current=project.scenes.find(s=>s.id===sceneId);
  if(!current) throw Error("cena não encontrada");
  const visual=visualCatalog(project),fps=project.assembly.fps.num/project.assembly.fps.den;
  const sources=new Map(project.assembly.sources.map(s=>[s.id,s]));
  const catalogs={speech:speechCatalog(project),visual,takes:takeCatalog(project),sources};
  const entries=support.map((entry,i)=>validateSupport(entry,i,catalogs,sceneId));
  const bare={...current,support:[]};
  const assembly=compileScenes(project,[bare]);
  const duration=Math.max(0,...assembly.tracks.flatMap(t=>t.clips.map(c=>c.startFrame+c.durationFrames)));
  let end=0;
  for(const entry of [...entries].sort((a,b)=>a.offsetFrames-b.offsetFrames)) {
    const span=visual.get(entry.visualId)!,source=sources.get(span.sourceId)!;
    if(!source.hasVideo || span.confidence!=="observed") throw Error("apoio exige vídeo observado");
    if(entry.offsetFrames<end) throw Error("apoios sobrepostos");
    if(entry.durationFrames>Math.round(span.end*fps)-Math.round(span.start*fps) || entry.offsetFrames+entry.durationFrames>duration) throw Error("apoio fora dos limites da fonte ou cena");
    end=entry.offsetFrames+entry.durationFrames;
  }
  const removed=new Set(current.support.map(e=>e.visualId));
  const evidence=[...new Set([...current.visualEvidenceIds.filter(id=>!removed.has(id)),...entries.map(e=>e.visualId)])];
  return project.scenes.map(s=>s.id===sceneId?{...s,support:entries,visualEvidenceIds:evidence}:s);
}
