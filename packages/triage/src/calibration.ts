import { authorizesCut } from "@decupa/typesafe";
import { buildEditCatalog, type EditCatalog } from "./catalog.ts";
import { parseSpeechIndex, type SpeechIndex } from "./speech-index.ts";

export const DECISION_CATEGORIES = [
  "condition_removed",
  "negation",
  "pode_vs_e",
  "number",
  "retake",
  "intentional_repetition",
  "unanswered_question",
] as const;

export type DecisionCategory = (typeof DECISION_CATEGORIES)[number];

export type Split = "dev" | "eval";

export type HumanLabel = {
  by: "human";
  apply: boolean;
};

export type MachineProposal = {
  source: "typesafe" | "other-model";
  apply: boolean;
  latencyMs: number;
  abstained?: boolean;
  fallback?: boolean;
};

export type CalibrationConfig = {
  enabledCategories: readonly DecisionCategory[];
};

export type CalibrationCase = {
  caseId: string;
  split: Split;
  videoId: string;
  projectId: string;
  category: DecisionCategory;
  index: SpeechIndex;
  candidateId: string;
  targetUnitIds: string[];
  human: HumanLabel;
};

export type OutcomeKind =
  | "incorrect_removal"
  | "omission"
  | "abstention"
  | "fallback"
  | "human_work"
  | "correct";

export type CaseEvaluation = {
  caseId: string;
  category: DecisionCategory;
  split: Split;
  latencyMs: number;
  outcome: OutcomeKind;
};

export type CalibrationReport = {
  sampleSize: number;
  latency: { p50Ms: number; p95Ms: number };
  counts: Record<OutcomeKind, number>;
  unlockedCategories: DecisionCategory[];
};

export function defaultCalibrationConfig(): CalibrationConfig {
  return { enabledCategories: [] };
}

export function humanLabelFromModels(
  _a: MachineProposal,
  _b: MachineProposal,
): HumanLabel | null {
  return null;
}

export function proposalFromNoul(noul: number, latencyMs: number): MachineProposal {
  return { source: "typesafe", apply: authorizesCut(noul), latencyMs };
}

export function evaluateCase(
  cse: CalibrationCase,
  proposal: MachineProposal,
  config: CalibrationConfig,
): CaseEvaluation {
  const base = {
    caseId: cse.caseId,
    category: cse.category,
    split: cse.split,
    latencyMs: proposal.latencyMs,
  };
  if (!config.enabledCategories.includes(cse.category)) {
    return { ...base, outcome: "human_work" };
  }
  if (proposal.fallback) return { ...base, outcome: "fallback" };
  if (proposal.abstained) return { ...base, outcome: "abstention" };
  if (proposal.apply && !cse.human.apply) return { ...base, outcome: "incorrect_removal" };
  if (!proposal.apply && cse.human.apply) return { ...base, outcome: "omission" };
  return { ...base, outcome: "correct" };
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  );
  return sorted[index]!;
}

export async function routeCorpusCase(
  cse: CalibrationCase,
  config: CalibrationConfig,
  decide?: (cse: CalibrationCase, catalog: EditCatalog) => MachineProposal | Promise<MachineProposal>,
): Promise<CaseEvaluation> {
  const started = Date.now();
  const catalog = await buildEditCatalog(cse.index);
  const hit = catalog.candidates.find((candidate) => candidate.id === cse.candidateId);
  if (!hit) {
    throw new Error(`caso ${cse.caseId} sem candidato ${cse.candidateId} no catálogo`);
  }
  const latencyMs = Math.max(0, Date.now() - started);
  const proposal = decide
    ? await decide(cse, catalog)
    : { source: "typesafe" as const, apply: false, latencyMs };
  return evaluateCase(cse, { ...proposal, latencyMs: proposal.latencyMs ?? latencyMs }, config);
}

export async function runOfflineCalibration(
  config: CalibrationConfig = defaultCalibrationConfig(),
): Promise<CalibrationReport> {
  const evals: CaseEvaluation[] = [];
  for (const cse of CRITICAL_CORPUS) {
    evals.push(await routeCorpusCase(cse, config));
  }
  return reportCalibration(evals);
}

export function reportCalibration(evals: CaseEvaluation[]): CalibrationReport {
  const sample = evals.filter((item) => item.split === "eval");
  const rows = sample.length > 0 ? sample : evals;
  const counts: Record<OutcomeKind, number> = {
    incorrect_removal: 0,
    omission: 0,
    abstention: 0,
    fallback: 0,
    human_work: 0,
    correct: 0,
  };
  for (const item of rows) counts[item.outcome] += 1;
  const latencies = rows.map((item) => item.latencyMs);
  const unlocked = new Set<DecisionCategory>();
  for (const category of DECISION_CATEGORIES) {
    const of = rows.filter((item) => item.category === category);
    if (of.length === 0) continue;
    if (of.some((item) => item.outcome !== "correct")) continue;
    unlocked.add(category);
  }
  return {
    sampleSize: rows.length,
    latency: {
      p50Ms: percentile(latencies, 0.5),
      p95Ms: percentile(latencies, 0.95),
    },
    counts,
    unlockedCategories: [...unlocked],
  };
}

function index(opts: {
  units: Array<{
    id: string;
    text: string;
    is_question?: boolean;
    near_duplicate_of?: string;
    similarity?: number;
  }>;
  topic?: string[];
}): SpeechIndex {
  return parseSpeechIndex({
    source_duration: opts.units.length * 3,
    budget: { lossless_floor_seconds: 4 },
    topic_runs: [{ keyword: "tema", unit_ids: opts.topic ?? opts.units.map((u) => u.id) }],
    trim_candidates: [],
    units: opts.units.map((u, i) => ({
      id: u.id,
      index: i,
      start: i * 3,
      end: i * 3 + 2,
      duration: 2,
      text: u.text,
      has_terminal_punct: true,
      word_count: u.text.split(/\s+/).length,
      lead_gap: 0.2,
      is_question: u.is_question ?? false,
      near_duplicate_of: u.near_duplicate_of,
      similarity: u.similarity,
    })),
  });
}

const human = (apply: boolean): HumanLabel => ({ by: "human", apply });

export const CRITICAL_CORPUS: CalibrationCase[] = [
  {
    caseId: "dev-condition-removed",
    split: "dev",
    videoId: "video-dev-1",
    projectId: "project-dev-1",
    category: "condition_removed",
    index: index({
      units: [
        { id: "u001", text: "O plano é simples." },
        { id: "u002", text: "O desconto vale, mas só se você já pagou." },
        { id: "u003", text: "O preço final aparece na tela." },
      ],
    }),
    candidateId: "caveat:u002",
    targetUnitIds: ["u002"],
    human: human(false),
  },
  {
    caseId: "dev-pode-vs-e",
    split: "dev",
    videoId: "video-dev-2",
    projectId: "project-dev-2",
    category: "pode_vs_e",
    index: index({
      units: [
        { id: "u001", text: "Isso pode ser o suficiente para começar." },
        { id: "u002", text: "Isso é o suficiente para começar.", near_duplicate_of: "u001", similarity: 0.99 },
        { id: "u003", text: "O próximo passo é publicar." },
      ],
      topic: ["u003"],
    }),
    candidateId: "retake:u001->u002",
    targetUnitIds: ["u001"],
    human: human(false),
  },
  {
    caseId: "dev-number",
    split: "dev",
    videoId: "video-dev-2",
    projectId: "project-dev-2",
    category: "number",
    index: index({
      units: [
        { id: "u001", text: "Vou explicar a espera." },
        { id: "u002", text: "Foram 15 minutos de espera." },
        { id: "u003", text: "Aí o atendimento começou." },
      ],
    }),
    candidateId: "number:u002",
    targetUnitIds: ["u002"],
    human: human(false),
  },
  {
    caseId: "dev-negation",
    split: "dev",
    videoId: "video-dev-3",
    projectId: "project-dev-3",
    category: "negation",
    index: index({
      units: [
        { id: "u001", text: "Vou explicar a política." },
        { id: "u002", text: "Isso não vale para quem já renovou." },
        { id: "u003", text: "Siga o regulamento." },
      ],
    }),
    candidateId: "negation:u002",
    targetUnitIds: ["u002"],
    human: human(false),
  },
  {
    caseId: "dev-retake",
    split: "dev",
    videoId: "video-dev-4",
    projectId: "project-dev-4",
    category: "retake",
    index: index({
      units: [
        { id: "u001", text: "Agora sim." },
        { id: "u002", text: "Agora sim.", near_duplicate_of: "u001", similarity: 0.99 },
        { id: "u003", text: "Dicas pra você gravar sem travar no começo." },
      ],
      topic: ["u003"],
    }),
    candidateId: "retake:u001->u002",
    targetUnitIds: ["u001"],
    human: human(true),
  },
  {
    caseId: "dev-intentional-repetition",
    split: "dev",
    videoId: "video-dev-5",
    projectId: "project-dev-5",
    category: "intentional_repetition",
    index: index({
      units: [
        { id: "u001", text: "Fica comigo até o fim." },
        { id: "u002", text: "Fica comigo até o fim.", near_duplicate_of: "u001", similarity: 0.99 },
        { id: "u003", text: "Escuta o recado até o último segundo." },
      ],
      topic: ["u003"],
    }),
    candidateId: "retake:u001->u002",
    targetUnitIds: ["u001"],
    human: human(false),
  },
  {
    caseId: "dev-unanswered-question",
    split: "dev",
    videoId: "video-dev-6",
    projectId: "project-dev-6",
    category: "unanswered_question",
    index: index({
      units: [
        { id: "u001", text: "Hoje eu mostro o corte." },
        { id: "u002", text: "Por que isso muda o resultado?", is_question: true },
        { id: "u003", text: "É isso, até a próxima aula." },
      ],
    }),
    candidateId: "protection:u002",
    targetUnitIds: ["u002"],
    human: human(false),
  },
  {
    caseId: "eval-negation",
    split: "eval",
    videoId: "video-eval-1",
    projectId: "project-eval-1",
    category: "negation",
    index: index({
      units: [
        { id: "u001", text: "Vou explicar a regra." },
        { id: "u002", text: "Isso não vale para quem já pagou." },
        { id: "u003", text: "Siga o contrato." },
      ],
    }),
    candidateId: "negation:u002",
    targetUnitIds: ["u002"],
    human: human(false),
  },
  {
    caseId: "eval-retake",
    split: "eval",
    videoId: "video-eval-1",
    projectId: "project-eval-1",
    category: "retake",
    index: index({
      units: [
        { id: "u001", text: "Agora vai." },
        { id: "u002", text: "Agora vai.", near_duplicate_of: "u001", similarity: 0.99 },
        { id: "u003", text: "Dicas pra você parar de ser chatão nas redes sociais." },
      ],
      topic: ["u003"],
    }),
    candidateId: "retake:u001->u002",
    targetUnitIds: ["u001"],
    human: human(true),
  },
  {
    caseId: "eval-intentional-repetition",
    split: "eval",
    videoId: "video-eval-2",
    projectId: "project-eval-2",
    category: "intentional_repetition",
    index: index({
      units: [
        { id: "u001", text: "Não desiste agora." },
        { id: "u002", text: "Não desiste agora.", near_duplicate_of: "u001", similarity: 0.99 },
        { id: "u003", text: "Escuta o que eu tô falando." },
      ],
      topic: ["u003"],
    }),
    candidateId: "retake:u001->u002",
    targetUnitIds: ["u001"],
    human: human(false),
  },
  {
    caseId: "eval-unanswered-question",
    split: "eval",
    videoId: "video-eval-2",
    projectId: "project-eval-2",
    category: "unanswered_question",
    index: index({
      units: [
        { id: "u001", text: "Hoje eu explico o recorte." },
        { id: "u002", text: "Por que isso importa?", is_question: true },
        { id: "u003", text: "É isso, até a próxima." },
      ],
    }),
    candidateId: "protection:u002",
    targetUnitIds: ["u002"],
    human: human(false),
  },
  {
    caseId: "eval-condition-removed",
    split: "eval",
    videoId: "video-eval-3",
    projectId: "project-eval-3",
    category: "condition_removed",
    index: index({
      units: [
        { id: "u001", text: "A promoção está no site." },
        { id: "u002", text: "O bônus vale, mas só se a inscrição for hoje." },
        { id: "u003", text: "O comprovante chega por e-mail." },
      ],
    }),
    candidateId: "caveat:u002",
    targetUnitIds: ["u002"],
    human: human(false),
  },
  {
    caseId: "eval-pode-vs-e",
    split: "eval",
    videoId: "video-eval-3",
    projectId: "project-eval-3",
    category: "pode_vs_e",
    index: index({
      units: [
        { id: "u001", text: "Isso pode ser o recorte final da aula." },
        { id: "u002", text: "Isso é o recorte final da aula.", near_duplicate_of: "u001", similarity: 0.99 },
        { id: "u003", text: "A gente publica amanhã." },
      ],
      topic: ["u003"],
    }),
    candidateId: "retake:u001->u002",
    targetUnitIds: ["u001"],
    human: human(false),
  },
  {
    caseId: "eval-number",
    split: "eval",
    videoId: "video-eval-3",
    projectId: "project-eval-3",
    category: "number",
    index: index({
      units: [
        { id: "u001", text: "Vou falar do prazo." },
        { id: "u002", text: "Foram 40 minutos de espera." },
        { id: "u003", text: "Aí a reunião começou." },
      ],
    }),
    candidateId: "number:u002",
    targetUnitIds: ["u002"],
    human: human(false),
  },
];
