import type { EditAction, Project, Proposal } from "./types.ts";
import type { EditorialSnapshot } from "./store.ts";
import { compileScenes, validateResolvedProposal } from "./scenes.ts";
import { autoFillerTargets, withFillerCuts, withoutFillerCuts, type FillerSnaps, type FillerTarget } from "./fillers.ts";
import { applyTextEdit, invalidatePreview } from "./words.ts";

/**
 * Edição aprovada como transição de revisão: aplica a ação por palavra e
 * recompila o assembly na mesma revisão — o texto editado e a timeline que
 * preview/export renderizam nunca divergem. `correct` é overlay de grafia
 * e não move mídia: segue só invalidando a prévia.
 */
export function applyEdit(p: Project, action: EditAction): Project {
  const next = applyTextEdit(p, action);
  if (action.type === "correct") return next;
  return { ...next, assembly: { ...compileScenes(next, next.scenes), revision: next.revision } };
}

export function validateProposalScope(p: Project, proposal: Proposal): Proposal {
  if (proposal.baseRevision !== p.revision) {
    throw new Error(`proposta com revisão desatualizada: base ${proposal.baseRevision}, atual ${p.revision}`);
  }
  const valid = validateResolvedProposal(proposal, p);
  const currentIds = new Set(p.scenes.map((scene) => scene.id));
  const nextIds = new Set(valid.scenes.map((scene) => scene.id));
  const changed = new Set(valid.changedSceneIds);
  for (const id of currentIds) {
    if (!nextIds.has(id) && !changed.has(id)) {
      throw new Error(`proposta reescreve cena ${id} fora do escopo`);
    }
  }
  return valid;
}

export function proposalProject(p: Project, proposal: Proposal): Project {
  return { ...p, scenes: validateProposalScope(p, proposal).scenes };
}

export function applyProposal(p: Project, proposal: Proposal): Project {
  return applyProposalWithFillers(p, proposal, {});
}

/** Proposta e camada acústica entram no mesmo bump, antes da única compilação. */
export function applyProposalWithFillers(p: Project, proposal: Proposal, snaps: FillerSnaps): Project {
  const valid = validateProposalScope(p, proposal);
  const proposed = { ...p, scenes: valid.scenes };
  const cut = withFillerCuts(proposed, autoFillerTargets(proposed, valid.changedSceneIds), snaps, "auto");
  const assembly = compileScenes(cut, cut.scenes);
  const revision = p.revision + 1;
  return {
    ...p,
    revision,
    scenes: cut.scenes,
    assembly: { ...assembly, revision },
    proposal: valid,
    template: valid.template === undefined ? p.template : structuredClone(valid.template),
    // Relatório da receita aceita (#68): proposta de template substitui
    // (inclusive sem template, que limpa); proposta comum preserva.
    templateReport: valid.template === undefined ? p.templateReport : valid.templateReport ?? [],
    previewRevision: null,
    finalApprovedRevision: null,
  };
}

/** Corte em lote é uma ação editorial, inclusive no desfazer. */
export function applyFillerEdit(p: Project, targets: FillerTarget[], snaps: FillerSnaps, mode: "cut" | "restore"): Project {
  const changed = mode === "cut" ? withFillerCuts(p, targets, snaps, "user") : withoutFillerCuts(p, targets);
  if (changed === p) return p;
  const next = invalidatePreview(changed);
  return { ...next, assembly: { ...compileScenes(next, next.scenes), revision: next.revision } };
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
    fillerExceptions: structuredClone(snap.fillerExceptions ?? []),
    proposal: snap.proposal,
    template: structuredClone(snap.template ?? null),
    templateReport: structuredClone(snap.templateReport ?? undefined),
    assembly: { ...assembly, revision, rhythmProfile: snap.rhythmProfile ?? null },
    previewRevision: null,
    finalApprovedRevision: null,
  };
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
