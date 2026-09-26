/**
 * Troca localizada de apoio (#65): o usuário seleciona um apoio da cena
 * (sceneId + índice do item em `scene.support`), vê os candidatos vindos
 * da análise existente (`brollCandidates` — sem inventar mídia) e aplica
 * somente a substituição escolhida. Falas, cortes e demais apoios ficam
 * intactos; sem candidato elegível a proposta explica a lacuna e nada muda.
 * Aceitar/rejeitar, revisão desatualizada e desfazer seguem o fluxo das
 * propostas localizadas (#64).
 */
import { randomUUID } from "node:crypto";
import { brollCandidates, candidateSupport, type BrollCandidate } from "./broll.ts";
import { compileScenes, visualCatalog } from "./scenes.ts";
import type { Project, Scene } from "./types.ts";
import { replaceSceneSupport } from "./words.ts";

export type SwapCandidate = BrollCandidate & {
  /** Se o candidato cobre a duração inteira do apoio atual (senão é cortado no fim). */
  fullCoverage: boolean;
};

/** Apoio atual descrito com a origem e a evidência da análise. */
export type CurrentSupport = {
  visualId: string;
  sourceId: string;
  sourceName: string | null;
  sourceStart: number;
  sourceEnd: number;
  offsetFrames: number;
  durationFrames: number;
  evidence: string;
};

export type SupportSwapProposal = {
  id: string;
  baseRevision: number;
  scope: { sceneId: string; supportIndex: number };
  request: string;
  current: CurrentSupport;
  candidates: SwapCandidate[];
  /** Quando não há candidato: a lacuna explicada, e a montagem é preservada. */
  gap: string | null;
};

function currentSupport(project: Project, scene: Scene, index: number): CurrentSupport {
  const entry = scene.support[index];
  if (!entry) throw new Error(`apoio ${index} inexistente na cena ${scene.id}`);
  const span = visualCatalog(project).get(entry.visualId);
  if (!span) throw new Error(`apoio ${entry.visualId} sem evidência na análise`);
  const source = project.assembly.sources.find((item) => item.id === span.sourceId);
  return {
    visualId: entry.visualId,
    sourceId: span.sourceId,
    sourceName: source?.name ?? null,
    sourceStart: span.start,
    sourceEnd: span.end,
    offsetFrames: entry.offsetFrames,
    durationFrames: entry.durationFrames,
    evidence: span.text,
  };
}

/**
 * Materializa a proposta de troca: lista candidatos com origem e evidência,
 * ou explica a lacuna quando não há candidato elegível. Nada é aplicado aqui.
 */
export function buildSupportSwapProposal(
  project: Project,
  scopeInput: { sceneId: string; supportIndex: number },
  request: string,
  id = randomUUID(),
): SupportSwapProposal {
  const scene = project.scenes.find((item) => item.id === scopeInput.sceneId);
  if (!scene) throw new Error(`cena ${scopeInput.sceneId} não encontrada`);
  const current = currentSupport(project, scene, scopeInput.supportIndex);
  const fps = project.assembly.fps.num / project.assembly.fps.den;
  const usedVisualIds = new Set(
    project.scenes.flatMap((item) => item.support.map((entry) => entry.visualId)),
  );
  const candidates: SwapCandidate[] = brollCandidates(project)
    .filter((candidate) =>
      !candidate.visualIds.includes(current.visualId)
      && !candidate.visualIds.some((id) => usedVisualIds.has(id))
    )
    .map((candidate) => ({
      ...candidate,
      // Mesmos arredondamentos de candidateSupport: endpoints são
      // Math.round por borda — a diferença de duração usa frames já
      // arredondados para não anunciar cobertura que não existe.
      fullCoverage:
        Math.round(candidate.end * fps) - Math.round(candidate.start * fps) >= current.durationFrames,
    }));
  let gap: string | null = null;
  if (!candidates.length) {
    const eligible = project.assembly.sources
      .filter((source) => source.included && source.hasVideo && source.role !== "speech");
    gap = eligible.length
      ? "sem candidato elegível: as fontes de apoio não têm trecho observado livre para esta troca"
      : "sem candidato elegível: não há fonte de apoio com vídeo incluída e analisada";
  }
  return {
    id,
    baseRevision: project.revision,
    scope: { sceneId: scene.id, supportIndex: scopeInput.supportIndex },
    request,
    current,
    candidates,
    gap,
  };
}

/**
 * Aplica somente a substituição escolhida: o novo apoio cobre a posição e a
 * duração do antigo (clampado à cobertura do candidato), demais itens de
 * `scene.support`, takes e cortes permanecem. Uma invalidação por aplicação.
 */
export function applySupportSwap(
  project: Project,
  proposal: SupportSwapProposal,
  candidateId: string,
): Project {
  if (proposal.baseRevision !== project.revision) {
    throw new Error(`proposta com revisão desatualizada: base ${proposal.baseRevision}, atual ${project.revision}`);
  }
  const canonical = brollCandidates(project).find((candidate) => candidate.id === candidateId);
  if (!canonical) throw new Error(`candidato ${candidateId} não é elegível`);
  const proposalCandidate = proposal.candidates.find((candidate) => candidate.id === candidateId);
  if (!proposalCandidate) throw new Error(`candidato ${candidateId} fora da proposta`);
  const scene = project.scenes.find((item) => item.id === proposal.scope.sceneId);
  if (!scene) throw new Error(`cena ${proposal.scope.sceneId} não encontrada`);
  const entry = scene.support[proposal.scope.supportIndex];
  if (!entry) throw new Error("apoio selecionado não existe mais");
  const fps = project.assembly.fps.num / project.assembly.fps.den;
  const durationFrames = Math.min(
    entry.durationFrames,
    Math.round(canonical.end * fps) - Math.round(canonical.start * fps),
  );
  const entries = candidateSupport(project, canonical, entry.offsetFrames, durationFrames);
  const next = replaceSceneSupport(project, scene.id, proposal.scope.supportIndex, entries);
  if (next === project) return project;
  return { ...next, assembly: { ...compileScenes(next, next.scenes), revision: next.revision } };
}
