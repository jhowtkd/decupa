import { randomUUID } from "node:crypto";
import { ZaiClient } from "@decupa/triage";
import type { Assembly, Clip, Project, Proposal, Scene, Source, Span, VisualSpan } from "./types.ts";
import { validateAssembly } from "./validate.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function speechCatalog(project: Project): Map<string, Span> {
  const map = new Map<string, Span>();
  for (const analysis of project.analyses) {
    for (const span of analysis.speech) map.set(span.id, span);
  }
  return map;
}

export function visualCatalog(project: Project): Map<string, VisualSpan> {
  const map = new Map<string, VisualSpan>();
  for (const analysis of project.analyses) {
    for (const span of analysis.visual) map.set(span.id, span);
  }
  return map;
}

export function validateProposal(raw: unknown, project: Project): Proposal {
  if (!isRecord(raw)) throw new Error("proposta precisa ser um objeto");
  if (raw.baseRevision !== project.revision) {
    throw new Error("proposta com revisão desatualizada");
  }
  if (!Array.isArray(raw.scenes) || !Array.isArray(raw.changedSceneIds)) {
    throw new Error("proposta incompleta");
  }
  const speech = speechCatalog(project);
  const visual = visualCatalog(project);
  const scenes: Scene[] = raw.scenes.map((item, i) => {
    if (!isRecord(item)) throw new Error(`cena ${i} inválida`);
    const speechIds = Array.isArray(item.speechIds) ? item.speechIds.map(String) : [];
    for (const id of speechIds) {
      if (!speech.has(id)) throw new Error(`referência de fala inexistente: ${id}`);
    }
    const supportRaw = Array.isArray(item.support) ? item.support : [];
    const support = supportRaw.map((entry, j) => {
      if (!isRecord(entry)) throw new Error(`apoio ${j} da cena ${String(item.id)} inválido`);
      const visualId = String(entry.visualId ?? "");
      if (!visual.has(visualId)) throw new Error(`referência visual inexistente: ${visualId}`);
      return {
        visualId,
        offsetFrames: Number(entry.offsetFrames),
        durationFrames: Number(entry.durationFrames),
      };
    });
    for (const itemSupport of support) {
      if (!Number.isSafeInteger(itemSupport.offsetFrames) || itemSupport.offsetFrames < 0) {
        throw new Error(`apoio ${itemSupport.visualId} com offset inválido`);
      }
      if (!Number.isSafeInteger(itemSupport.durationFrames) || itemSupport.durationFrames <= 0) {
        throw new Error(`apoio ${itemSupport.visualId} com duração inválida`);
      }
    }
    return {
      id: String(item.id),
      objective: String(item.objective ?? ""),
      rationale: String(item.rationale ?? ""),
      speechIds,
      // Takes nascem na edição (tarefa 3) ou na proposta com evidência (tarefa 6).
      takes: [],
      support,
      gaps: Array.isArray(item.gaps) ? item.gaps.map(String) : [],
    };
  });
  return {
    id: String(raw.id),
    baseRevision: Number(raw.baseRevision),
    scenes,
    changedSceneIds: raw.changedSceneIds.map(String),
    explanation: String(raw.explanation ?? ""),
  };
}

function quantize(span: Span, fps: number): { inFrame: number; durationFrames: number; sourceStartSeconds: number } {
  const inFrame = Math.round(span.start * fps);
  const outFrame = Math.round(span.end * fps);
  const durationFrames = outFrame - inFrame;
  if (durationFrames <= 0) throw new Error(`fala ${span.id} tem duração zero depois da quantização`);
  return { inFrame, durationFrames, sourceStartSeconds: inFrame / fps };
}

function sourceById(project: Project, id: string): Source {
  const source = project.assembly.sources.find((item) => item.id === id);
  if (!source) throw new Error(`fonte ${id} ausente na montagem`);
  return source;
}

export function compileScenes(project: Project, scenes: Scene[]): Assembly {
  const speech = speechCatalog(project);
  const visual = visualCatalog(project);
  const fps = project.assembly.fps.num / project.assembly.fps.den;
  const v1: Clip[] = [];
  const v2: Clip[] = [];
  const a1: Clip[] = [];
  let cursor = 0;
  for (const scene of scenes) {
    const sceneStart = cursor;
    for (const id of scene.speechIds) {
      const span = speech.get(id);
      if (!span) throw new Error(`referência de fala inexistente: ${id}`);
      const q = quantize(span, fps);
      const source = sourceById(project, span.sourceId);
      const clip = {
        id: `${scene.id}-${id}`,
        sceneId: scene.id,
        sourceId: span.sourceId,
        sourceStartSeconds: q.sourceStartSeconds,
        startFrame: cursor,
        durationFrames: q.durationFrames,
      };
      if (source.hasVideo) v1.push({ ...clip, id: `${clip.id}-v` });
      if (source.hasAudio) a1.push({ ...clip, id: `${clip.id}-a` });
      cursor += q.durationFrames;
    }
    for (const item of scene.support) {
      const span = visual.get(item.visualId);
      if (!span) throw new Error(`referência visual inexistente: ${item.visualId}`);
      const source = sourceById(project, span.sourceId);
      if (!source.hasVideo) continue;
      v2.push({
        id: `${scene.id}-${item.visualId}`,
        sceneId: scene.id,
        sourceId: span.sourceId,
        sourceStartSeconds: span.start,
        startFrame: sceneStart + item.offsetFrames,
        durationFrames: item.durationFrames,
      });
    }
  }
  return validateAssembly({
    ...project.assembly,
    tracks: [
      { kind: "Video", name: "V1", clips: v1 },
      { kind: "Video", name: "V2", clips: v2 },
      { kind: "Audio", name: "A1", clips: a1 },
    ],
  });
}

export const SCENE_PROMPT = `Proponha cenas usando só os IDs do catálogo.
Não invente fala nem altere o sentido do texto. Texto exibido virá da transcrição.
Com roteiro, siga a sequência e marque lacunas sem cobertura.
Com briefing, narre com o material disponível. Duração inviável vira lacuna, não fala esticada.
Responda somente um objeto JSON neste formato:
{"scenes":[{"id":"s1","objective":"objetivo","rationale":"justificativa","speechIds":["ID_EXATO_DO_CATALOGO"],"support":[],"gaps":[]}],"changedSceneIds":["s1"],"explanation":"resumo das mudanças"}.
Cada apoio em support tem {"visualId":"ID_VISUAL_EXATO","offsetFrames":0,"durationFrames":25}; os valores são frames inteiros no fps informado.
Sem catálogo visual, support deve ser []. gaps contém textos das lacunas.
Devolva a lista completa de cenas na ordem final; preserve IDs de cenas existentes não alteradas.
Não gere id da proposta nem baseRevision: o servidor controla esses metadados.`;

export async function proposeScenes(
  project: Project,
  request: string,
  signal: AbortSignal,
  deps?: { send: (content: unknown[], signal?: AbortSignal) => Promise<string> },
): Promise<Proposal> {
  const snapshot = structuredClone(project);
  const proposalId = randomUUID();
  const speech = [...speechCatalog(snapshot).values()].map((s) => ({
    id: s.id, sourceId: s.sourceId, start: s.start, end: s.end, text: s.text,
  }));
  const visual = [...visualCatalog(snapshot).values()].map((s) => ({
    id: s.id, sourceId: s.sourceId, start: s.start, end: s.end, text: s.text, tags: s.tags,
  }));
  const send = deps?.send ?? ((content: unknown[], inner?: AbortSignal) => new ZaiClient().send(content, inner ?? signal));
  const text = await send([
    {
      type: "text",
      text: `${SCENE_PROMPT}\n\nkind: ${snapshot.input.kind}\ntext: ${snapshot.input.text}\n`
        + `targetSeconds: ${snapshot.input.targetSeconds}\npedido: ${request}\n`
        + `falas: ${JSON.stringify(speech)}\nvisuais: ${JSON.stringify(visual)}\n`
        + `fps: ${snapshot.assembly.fps.num}/${snapshot.assembly.fps.den}\n`
        + `cenas atuais: ${JSON.stringify(snapshot.scenes)}`,
    },
  ], signal);
  const unfenced = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const raw: unknown = JSON.parse(unfenced);
  if (!isRecord(raw)) throw new Error("proposta precisa ser um objeto");
  return validateProposal({ ...raw, id: proposalId, baseRevision: snapshot.revision }, snapshot);
}
