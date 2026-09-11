import type { Assembly, Project, Proposal } from "./types.ts";
import type { EditorialSnapshot } from "./store.ts";
import { compileScenes, validateProposal } from "./scenes.ts";

export function applyProposal(p: Project, proposal: Proposal): Project {
  if (proposal.baseRevision !== p.revision) {
    throw new Error(`proposta com revisão desatualizada: base ${proposal.baseRevision}, atual ${p.revision}`);
  }
  const valid = validateProposal(proposal, p);
  const currentIds = new Set(p.scenes.map((scene) => scene.id));
  const nextIds = new Set(valid.scenes.map((scene) => scene.id));
  const changed = new Set(valid.changedSceneIds);
  for (const id of currentIds) {
    if (!nextIds.has(id) && !changed.has(id)) {
      throw new Error(`proposta reescreve cena ${id} fora do escopo`);
    }
  }
  const assembly = compileScenes({ ...p, scenes: valid.scenes }, valid.scenes);
  const revision = p.revision + 1;
  return {
    ...p,
    revision,
    scenes: valid.scenes,
    assembly: { ...assembly, revision },
    proposal: valid,
    structureApprovedRevision: null,
    previewRevision: null,
    finalApprovedRevision: null,
  };
}

/**
 * Restaura conteúdo editorial como revisão nova (nunca decrementa).
 * Consentimentos, preparação, análises e aprovações seguem os atuais;
 * a prévia anterior segue no disco, stale por revisão.
 */
export function applyHistorySnapshot(p: Project, snap: EditorialSnapshot): Project {
  const assembly = compileScenes({ ...p, scenes: snap.scenes }, snap.scenes);
  const revision = p.revision + 1;
  return {
    ...p,
    revision,
    input: snap.input,
    scenes: snap.scenes,
    corrections: snap.corrections,
    proposal: snap.proposal,
    assembly: { ...assembly, revision },
    structureApprovedRevision: null,
    previewRevision: null,
    finalApprovedRevision: null,
  };
}

export function approveStructure(p: Project): Project {
  if (p.scenes.length === 0) throw new Error("não há cenas para aprovar");
  const unresolved = p.scenes.flatMap((scene) => scene.gaps);
  if (unresolved.length > 0) {
    throw new Error(`lacunas não resolvidas: ${unresolved.join("; ")}`);
  }
  return { ...p, structureApprovedRevision: p.revision };
}

export function recordPreview(
  p: Project,
  artifact: NonNullable<Project["previewArtifact"]>,
): Project {
  if (artifact.revision !== p.revision) {
    throw new Error(`prévia de outra revisão: ${artifact.revision}, atual ${p.revision}`);
  }
  return { ...p, previewRevision: p.revision, previewArtifact: artifact };
}

/**
 * Aprovação final humana: exige o MP4 assistido (artefato da revisão atual),
 * nenhuma lacuna aberta, takes com fonte válida e confirmação de qual
 * revisão foi assistida. Não depende de aprovação estrutural.
 */
export function approveFinal(p: Project, watchedRevision: number): Project {
  if (!p.previewArtifact || p.previewArtifact.revision !== p.revision) {
    throw new Error("prévia desatualizada: gere a prévia da revisão atual");
  }
  if (p.previewRevision !== p.revision) {
    throw new Error("prévia desatualizada: gere a prévia da revisão atual");
  }
  if (watchedRevision !== p.revision) {
    throw new Error(`confirme a revisão assistida: ${p.revision}`);
  }
  for (const scene of p.scenes) {
    if (scene.gaps.length > 0) {
      throw new Error(`cena ${scene.id} com lacunas não resolvidas`);
    }
  }
  const sources = new Map(p.assembly.sources.map((source) => [source.id, source]));
  for (const scene of p.scenes) {
    for (const take of scene.takes) {
      const source = sources.get(take.sourceId);
      if (!source) throw new Error(`take ${take.id} com fonte ausente ${take.sourceId}`);
      if (!source.included) {
        throw new Error(`take ${take.id} usa fonte excluída do escopo: ${take.sourceId}`);
      }
      if (take.start < 0 || take.end > source.durationSeconds || take.start >= take.end) {
        throw new Error(`take ${take.id} fora da fonte ${take.sourceId}`);
      }
    }
  }
  return { ...p, finalApprovedRevision: p.revision };
}
