/**
 * O subconjunto do `speech_index.json` que a triagem consome.
 *
 * O arquivo do motor tem muito mais campo do que isto. Declarar só o que é
 * usado deixa explícito de que parte do contrato a triagem depende — e o resto
 * do índice pode mudar sem quebrar nada aqui.
 */

export interface IndexUnit {
  id: string;
  index: number;
  start: number;
  end: number;
  duration: number;
  text: string;
  hasTerminalPunct: boolean;
  isQuestion: boolean;
  /** Unidade anterior que o motor marcou como quase-duplicata, ou null. */
  nearDuplicateOf: string | null;
  /** Score SequenceMatcher do motor (0–1), ou null se o campo não veio. */
  similarity: number | null;
  wordCount: number;
  cps: number;
  leadGap: number;
  disfluency: { hard: unknown[]; soft: unknown[]; stutter: unknown[] };
}

export interface TopicRun {
  keyword: string;
  unitIds: string[];
}

export interface TrimCandidate {
  id: string;
  seconds: number;
  text: string;
  reasons: string[];
}

export interface SpeechIndex {
  units: IndexUnit[];
  topicRuns: TopicRun[];
  trimCandidates: TrimCandidate[];
  losslessFloorSeconds: number;
  sourceDurationSeconds: number;
}

export function parseSpeechIndex(raw: unknown): SpeechIndex {
  const root = raw as Record<string, unknown>;
  const rawUnits = root?.units;
  if (!Array.isArray(rawUnits) || rawUnits.length === 0) {
    throw new Error("speech_index.json sem `units` — rode `condense.py index` antes da triagem");
  }
  const units: IndexUnit[] = rawUnits
    .map((u: Record<string, unknown>) => ({
      id: String(u.id),
      index: Number(u.index),
      start: Number(u.start),
      end: Number(u.end),
      duration: Number(u.duration),
      text: String(u.text ?? ""),
      hasTerminalPunct: Boolean(u.has_terminal_punct),
      isQuestion: Boolean(u.is_question),
      nearDuplicateOf: u.near_duplicate_of == null || u.near_duplicate_of === ""
        ? null
        : String(u.near_duplicate_of),
      similarity: u.similarity == null || u.similarity === "" ? null : Number(u.similarity),
      wordCount: Number(u.word_count ?? 0),
      cps: Number(u.cps ?? 0),
      leadGap: Number(u.lead_gap ?? 0),
      disfluency: parseDisfluency(u.disfluency),
    }))
    .sort((a, b) => a.index - b.index);

  const rawRuns = Array.isArray(root.topic_runs) ? root.topic_runs : [];
  const topicRuns: TopicRun[] = rawRuns.map((r: Record<string, unknown>) => ({
    keyword: String(r.keyword),
    unitIds: (r.unit_ids as string[] | undefined ?? []).map(String),
  }));

  const rawTrim = Array.isArray(root.trim_candidates) ? root.trim_candidates : [];
  const trimCandidates: TrimCandidate[] = rawTrim.map((t: Record<string, unknown>) => ({
    id: String(t.id),
    seconds: Number(t.seconds ?? 0),
    text: String(t.text ?? ""),
    reasons: Array.isArray(t.reasons) ? t.reasons.map(String) : [],
  }));

  const budget = (root.budget ?? {}) as Record<string, unknown>;
  return {
    units,
    topicRuns,
    trimCandidates,
    losslessFloorSeconds: Number(budget.lossless_floor_seconds ?? 0),
    sourceDurationSeconds: Number(root.source_duration ?? 0),
  };
}

function parseDisfluency(raw: unknown): IndexUnit["disfluency"] {
  const d = (raw ?? {}) as Record<string, unknown>;
  return {
    hard: Array.isArray(d.hard) ? d.hard : [],
    soft: Array.isArray(d.soft) ? d.soft : [],
    stutter: Array.isArray(d.stutter) ? d.stutter : [],
  };
}

export function unitByIdOrThrow(index: SpeechIndex, id: string): IndexUnit {
  const found = index.units.find((u) => u.id === id);
  if (!found) throw new Error(`unidade ${id} não existe no índice`);
  return found;
}

/**
 * Menor e maior `index` citados por qualquer topic_run — a extensão do corpo
 * do vídeo segundo a agregação por keyword que o motor já faz. Fora dessa
 * faixa é onde pré-rolo e pós-rolo podem estar.
 */
export function topicSpan(index: SpeechIndex): { first: number; last: number } | null {
  const indices: number[] = [];
  for (const run of index.topicRuns) {
    for (const id of run.unitIds) {
      const unit = index.units.find((u) => u.id === id);
      if (unit) indices.push(unit.index);
    }
  }
  if (indices.length === 0) return null;
  return { first: Math.min(...indices), last: Math.max(...indices) };
}
