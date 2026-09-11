import type { Assembly, Project, Proposal, Scene } from "./types.ts";
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

export function approveStructure(p: Project): Project {
  if (p.scenes.length === 0) throw new Error("não há cenas para aprovar");
  const unresolved = p.scenes.flatMap((scene) => scene.gaps);
  if (unresolved.length > 0) {
    throw new Error(`lacunas não resolvidas: ${unresolved.join("; ")}`);
  }
  return { ...p, structureApprovedRevision: p.revision };
}

export function recordPreview(p: Project, revision: number): Project {
  if (revision !== p.revision) return p;
  if (p.structureApprovedRevision !== p.revision) {
    throw new Error("prévia exige estrutura aprovada na revisão atual");
  }
  return { ...p, previewRevision: revision };
}

export function approveFinal(p: Project): Project {
  if (p.structureApprovedRevision !== p.revision) {
    throw new Error("aprovação final exige estrutura atual");
  }
  if (p.previewRevision !== p.revision) {
    throw new Error("aprovação final exige prévia da revisão atual");
  }
  const unresolved = p.scenes.flatMap((scene: Scene) => scene.gaps);
  if (unresolved.length > 0) {
    throw new Error(`lacunas não resolvidas: ${unresolved.join("; ")}`);
  }
  return { ...p, finalApprovedRevision: p.revision };
}
