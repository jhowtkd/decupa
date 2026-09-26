/**
 * Controle de ritmo (#66): dois perfis documentados — "natural" preserva a
 * respiração do locutor, "direto" enxuga pausas. A escolha gera uma proposta
 * comparável (mesmo trecho, efeito nas pausas, amostra auditável renderizada
 * pela própria linha de prévia) e a aplicação vai pelo mecanismo de revisão
 * existente: bump único, prévia/aprovação invalidadas, desfazer pelo
 * histórico. Palavras e proteções nunca entram no corte — a aplicação só
 * toca os vazios entre palavras alinhadas; fonte sem alinhamento é
 * informada e pulada, sem microcortes. Trocar de perfil não acumula: cada
 * take guarda o que o ritmo removeu (`take.rhythm.removed`), e a nova
 * aplicação desfaz a camada anterior antes de somar a do perfil escolhido.
 */
import { randomUUID } from "node:crypto";
import { compileScenes } from "./scenes.ts";
import type { Assembly, Project, Scene, SourceRange, SpeechTake } from "./types.ts";
import { effectiveWords, invalidatePreview, normalizeRanges, overlaps, subtractRanges } from "./words.ts";

export type RhythmProfileId = "natural" | "direto";

export type RhythmProfile = {
  id: RhythmProfileId;
  name: string;
  /** Descrição do comportamento, definida por escuta. */
  description: string;
  /** Pausas menores que isso ficam intactas. */
  minPauseSeconds: number;
  /** Pausa maior que o mínimo é reduzida para este restante. */
  keepSeconds: number;
  /** Respiro de borda em cada lado do corte, fora do keep. */
  edgeSeconds: number;
};

/**
 * Parâmetros por escuta: natural corta só o que soa parado demais (pausas
 * acima de 0,9s encolhem para ~0,45s, suficiente para respirar); direto
 * pressiona tudo (pausas acima de 0,35s viram ~0,15s, quase sem respiro).
 */
export const RHYTHM_PROFILES: Record<RhythmProfileId, RhythmProfile> = {
  natural: {
    id: "natural",
    name: "Natural",
    description: "mantém a respiração: pausas até 0,9s intactas; as maiores encolhem para ~0,45s",
    minPauseSeconds: 0.9,
    keepSeconds: 0.45,
    edgeSeconds: 0.08,
  },
  direto: {
    id: "direto",
    name: "Direto",
    description: "sem gordura: pausas acima de 0,35s encolhem para ~0,15s",
    minPauseSeconds: 0.35,
    keepSeconds: 0.15,
    edgeSeconds: 0.05,
  },
};

export function rhythmProfile(id: string): RhythmProfile {
  const profile = RHYTHM_PROFILES[id as RhythmProfileId];
  if (!profile) throw new Error(`perfil de ritmo desconhecido: ${id}`);
  return profile;
}

export type RhythmPause = SourceRange & {
  /** Duração original da pausa em segundos. */
  duration: number;
  /** Quanto sobra depois do corte (0 = pausa some). */
  keep: number;
  /** Se alguma parte da pausa é protegida, a parte protegida não é cortada. */
  protectedPart: boolean;
};

/**
 * Pausas entre palavras alinhadas dentro do take: o intervalo cortável fica
 * entre o fim acústico de uma palavra e o início da próxima, recuado pelo
 * edge do perfil e preso ao take. Sem `wordsStatus === "ready"` na fonte,
 * não há alinhamento — retorna null para o chamador informar e pular.
 */
export function rhythmPauses(
  project: Project,
  take: SpeechTake,
  profile: RhythmProfile,
): { pauses: RhythmPause[]; cuts: SourceRange[] } | null {
  const analysis = project.analyses.find((item) => item.sourceId === take.sourceId);
  if (analysis?.wordsStatus !== "ready") return null;
  const words = effectiveWords(project, take.sourceId)
    .filter((word) => word.start < take.end && word.end > take.start);
  const pauses: RhythmPause[] = [];
  const cuts: SourceRange[] = [];
  for (let i = 1; i < words.length; i++) {
    const prev = words[i - 1]!;
    const next = words[i]!;
    // Bordas acústicas quando existem: corta o vazio real, não dentro da fala.
    const gapStart = Math.max(take.start, prev.cutEnd ?? prev.end);
    const gapEnd = Math.min(take.end, next.cutStart ?? next.start);
    const duration = gapEnd - gapStart;
    if (duration <= 0.02) continue;
    if (duration <= profile.minPauseSeconds) {
      pauses.push({ start: gapStart, end: gapEnd, duration, keep: duration, protectedPart: false });
      continue;
    }
    const keep = Math.min(profile.keepSeconds, duration);
    const cut: SourceRange = {
      start: gapStart + profile.edgeSeconds + keep / 2,
      end: gapEnd - profile.edgeSeconds - keep / 2,
    };
    const allowed = subtractRanges([cut], take.protected);
    const applied = allowed.length && cut.start < cut.end ? allowed : [];
    if (!applied.length) {
      pauses.push({
        start: gapStart, end: gapEnd, duration, keep: duration,
        protectedPart: overlaps(cut, take.protected),
      });
      continue;
    }
    cuts.push(...applied);
    const kept = duration - applied.reduce((total, range) => total + (range.end - range.start), 0);
    pauses.push({
      start: gapStart,
      end: gapEnd,
      duration,
      keep: kept,
      protectedPart: applied.length !== 1
        || applied[0]!.start !== cut.start || applied[0]!.end !== cut.end,
    });
  }
  return { pauses, cuts: normalizeRanges(cuts) };
}

type RhythmTakePlan = {
  sceneId: string;
  takeId: string;
  sourceId: string;
  pauses: RhythmPause[];
  cuts: SourceRange[];
  removedSeconds: number;
};

/** Proposta revisável de ritmo: comparação por take + amostra do trecho. */
export type RhythmProposal = {
  id: string;
  baseRevision: number;
  profileId: RhythmProfileId;
  takes: RhythmTakePlan[];
  /** Takes pulados por falta de alinhamento — informados, sem microcortes. */
  unaligned: { takeId: string; sourceId: string }[];
  beforeSeconds: number;
  afterSeconds: number;
  /** Trecho escolhido para a amostra comparativa (antes/depois). */
  sample: { sceneId: string; takeId: string; start: number; end: number } | null;
};

const rangesDuration = (ranges: SourceRange[]): number =>
  ranges.reduce((total, range) => total + (range.end - range.start), 0);

const SAMPLE_SECONDS = 15;

/**
 * Materializa a proposta do perfil contra a montagem atual: calcula pausas
 * por take alinhado, lista as puladas por falta de alinhamento e escolhe o
 * trecho com mais pausa reduzida para a amostra.
 */
export function buildRhythmProposal(
  project: Project,
  profileId: RhythmProfileId,
  id = randomUUID(),
): RhythmProposal {
  const profile = rhythmProfile(profileId);
  const takes: RhythmTakePlan[] = [];
  const unaligned: RhythmProposal["unaligned"] = [];
  let beforeSeconds = 0;
  let afterSeconds = 0;
  let best: { sceneId: string; takeId: string; start: number; end: number; saved: number } | null = null;
  for (const scene of project.scenes) {
    for (const take of scene.takes) {
      const plan = rhythmPauses(project, take, profile);
      if (plan === null) {
        unaligned.push({ takeId: take.id, sourceId: take.sourceId });
        continue;
      }
      // A camada de ritmo anterior sai da conta: o projeto compara sempre
      // a montagem sem a camada anterior com o novo perfil — trocar não
      // empilha cortes.
      const base = subtractRanges(take.removed, take.rhythm?.removed ?? []);
      const afterRemoved = normalizeRanges([...base, ...plan.cuts]);
      beforeSeconds += take.end - take.start - rangesDuration(take.removed);
      afterSeconds += take.end - take.start - rangesDuration(afterRemoved);
      const saved = rangesDuration(plan.cuts);
      takes.push({
        sceneId: scene.id,
        takeId: take.id,
        sourceId: take.sourceId,
        pauses: plan.pauses,
        cuts: plan.cuts,
        removedSeconds: saved,
      });
      if (saved > 0 && (best === null || saved > best.saved)) {
        const first = plan.pauses.find((pause) => pause.keep < pause.duration);
        if (first) {
          const start = Math.max(take.start, first.start - 1);
          best = {
            sceneId: scene.id,
            takeId: take.id,
            start,
            end: Math.min(take.end, start + SAMPLE_SECONDS),
            saved,
          };
        }
      }
    }
  }
  return {
    id,
    baseRevision: project.revision,
    profileId,
    takes,
    unaligned,
    beforeSeconds,
    afterSeconds,
    sample: best ? { sceneId: best.sceneId, takeId: best.takeId, start: best.start, end: best.end } : null,
  };
}

/**
 * Aplica o perfil ao projeto: substitui a camada de ritmo anterior em cada
 * take (sem acumular), protege `protected` e devolve montagem recompilada.
 */
export function applyRhythmProposal(project: Project, proposal: RhythmProposal): Project {
  if (proposal.baseRevision !== project.revision) {
    throw new Error(`proposta com revisão desatualizada: base ${proposal.baseRevision}, atual ${project.revision}`);
  }
  const profile = rhythmProfile(proposal.profileId);
  const updates: { sceneId: string; takeId: string; cuts: SourceRange[] }[] = [];
  for (const plan of proposal.takes) {
    updates.push({ sceneId: plan.sceneId, takeId: plan.takeId, cuts: plan.cuts });
  }
  const cut = applyRhythmCuts(project, updates, profile.id);
  if (cut === project) return project;
  // Um único bump: prévia e aprovação antiga caem, a nova prévia deve
  // corresponder a esta revisão.
  const next = invalidatePreview(cut);
  return {
    ...next,
    assembly: {
      ...compileScenes(next, next.scenes),
      revision: next.revision,
      rhythmProfile: profile.id,
    },
  };
}

/**
 * Aplica cortes de ritmo nos takes: a camada anterior de ritmo (se houver)
 * é removida antes de somar os novos cortes — o perfil nunca empilha
 * remoções irreversíveis. `protected` continua subtraído no caminho.
 */
export function applyRhythmCuts(
  project: Project,
  updates: { sceneId: string; takeId: string; cuts: SourceRange[] }[],
  profileId: string,
): Project {
  let next = project;
  let touched = false;
  const byScene = new Map<string, Map<string, SpeechTake>>();
  for (const { sceneId, takeId, cuts } of updates) {
    const scene = next.scenes.find((item) => item.id === sceneId);
    const take = scene?.takes.find((item) => item.id === takeId);
    if (!scene || !take) continue;
    const base = subtractRanges(take.removed, take.rhythm?.removed ?? []);
    const allowed = subtractRanges(subtractRanges(cuts, take.protected), base);
    const removed = normalizeRanges([...base, ...allowed]);
    const same = removed.length === take.removed.length
      && removed.every((range, i) => range.start === take.removed[i]!.start && range.end === take.removed[i]!.end);
    const rhythmSame = take.rhythm?.profile === profileId
      && allowed.length === (take.rhythm?.removed.length ?? 0)
      && allowed.every((range, i) => range.start === take.rhythm!.removed[i]!.start && range.end === take.rhythm!.removed[i]!.end);
    if (same && rhythmSame) continue;
    touched = true;
    if (!byScene.has(sceneId)) byScene.set(sceneId, new Map());
    byScene.get(sceneId)!.set(takeId, {
      ...take,
      removed,
      rhythm: { profile: profileId, removed: normalizeRanges(allowed) },
    });
  }
  if (!touched) return project;
  return {
    ...next,
    scenes: next.scenes.map((scene) => {
      const changed = byScene.get(scene.id);
      if (!changed) return scene;
      return {
        ...scene,
        takes: scene.takes.map((take) => changed.get(take.id) ?? take),
      };
    }),
  };
}

/**
 * Montagem de um só take para a amostra comparativa: o trecho do
 * `proposal.sample` compilado isolado — "antes" mantém os removed atuais,
 * "depois" troca a camada de ritmo anterior pela do perfil proposto.
 * Renderizada pela mesma linha da prévia completa (renderAssembly).
 */
export function rhythmSampleAssembly(
  project: Project,
  proposal: RhythmProposal,
  which: "antes" | "depois",
): Assembly | null {
  const sample = proposal.sample;
  if (!sample) return null;
  const scene = project.scenes.find((item) => item.id === sample.sceneId);
  const take = scene?.takes.find((item) => item.id === sample.takeId);
  if (!scene || !take) return null;
  const clip = (ranges: SourceRange[]): SourceRange[] => ranges
    .map((range) => ({
      start: Math.max(range.start, sample.start),
      end: Math.min(range.end, sample.end),
    }))
    .filter((range) => range.start < range.end);
  const removed = which === "depois"
    ? normalizeRanges([
      ...subtractRanges(take.removed, take.rhythm?.removed ?? []),
      ...(proposal.takes.find((plan) => plan.takeId === take.id)?.cuts ?? []),
    ])
    : take.removed;
  const excerptScene: Scene = {
    id: scene.id,
    objective: `amostra de ritmo (${which})`,
    rationale: "",
    speechIds: take.speechId ? [take.speechId] : [],
    takes: [{ ...take, start: sample.start, end: sample.end, removed: clip(removed) }],
    visualEvidenceIds: [],
    support: [],
    gaps: [],
  };
  return compileScenes(project, [excerptScene]);
}
