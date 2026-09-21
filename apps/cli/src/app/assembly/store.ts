import { validateAnimationNotes } from "./handoff.ts";
import { validateDecisionReport } from "./assembly-decisions.ts";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { access } from "node:fs/promises";
import { publishAtomic } from "@decupa/cache";
import { createLimitedQueue, type LimitedQueue } from "@decupa/queue";
import type {
  Analysis,
  Assembly,
  LegacyProject,
  Preparation,
  Project,
  Source,
  SpeechTake,
  TextCorrection,
  VisualCoverage,
  Word,
} from "./types.ts";
import { validateAssembly } from "./validate.ts";

const writers = new Map<string, LimitedQueue>();

function projectPath(dir: string): string {
  return join(dir, "project.json");
}

function lockPath(dir: string): string {
  return join(dir, "project.lock");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writerFor(dir: string): LimitedQueue {
  const existing = writers.get(dir);
  if (existing) return existing;
  const created = createLimitedQueue(1);
  writers.set(dir, created);
  return created;
}

function enqueue<T>(dir: string, work: () => Promise<T>): Promise<T> {
  return writerFor(dir).run(work);
}

async function acquireLock(dir: string): Promise<void> {
  const path = lockPath(dir);
  try {
    const handle = await open(path, "wx");
    await handle.writeFile(`${process.pid}\n`);
    await handle.close();
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw err;
  }
  const raw = await readFile(path, "utf8").catch(() => "");
  const pid = Number(raw.trim());
  if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) {
    throw new Error("outro processo já escreve neste projeto");
  }
  await unlink(path).catch(() => {});
  const handle = await open(path, "wx");
  await handle.writeFile(`${process.pid}\n`);
  await handle.close();
}

async function releaseLock(dir: string): Promise<void> {
  await unlink(lockPath(dir)).catch(() => {});
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SHA256 = /^[0-9a-f]{64}$/;
const STATUSES = new Set(["pending", "running", "ready", "error"]);
const CORRECTION_STATUSES = new Set(["pending", "aligned", "error"]);
const VISUAL_CONFIDENCES = new Set(["observed", "uncertain", "unavailable"]);

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} precisa ser um texto não vazio`);
  }
  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} precisa ser um número finito`);
  }
  return value;
}

function nonNegativeInt(value: unknown, label: string): number {
  const n = finiteNumber(value, label);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`${label} precisa ser um inteiro não negativo`);
  }
  return n;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return nonEmptyString(value, label);
}

/** Intervalo semiaberto validado contra a duração da fonte — sem estimar. */
function sourceRange(
  value: unknown,
  label: string,
  durationSeconds: number,
): { start: number; end: number } {
  if (!isRecord(value)) throw new Error(`${label} precisa ser um objeto`);
  const start = finiteNumber(value.start, `${label}.start`);
  const end = finiteNumber(value.end, `${label}.end`);
  if (start < 0 || end <= start || end > durationSeconds) {
    throw new Error(`${label} com intervalo inválido [${start}, ${end})`);
  }
  return { start, end };
}

function rangeList(value: unknown, label: string): { start: number; end: number }[] {
  if (!Array.isArray(value)) throw new Error(`${label} precisa ser um array`);
  return value.map((entry, i) => {
    if (!isRecord(entry)) throw new Error(`${label}[${i}] precisa ser um objeto`);
    const start = finiteNumber(entry.start, `${label}[${i}].start`);
    const end = finiteNumber(entry.end, `${label}[${i}].end`);
    if (!(start < end)) throw new Error(`${label}[${i}] com intervalo inválido`);
    return { start, end };
  });
}

export function validateWord(value: unknown, sources: Map<string, Source>): Word {
  if (!isRecord(value)) throw new Error("palavra precisa ser um objeto");
  const id = nonEmptyString(value.id, "palavra.id");
  const sourceId = nonEmptyString(value.sourceId, "palavra.sourceId");
  const source = sources.get(sourceId);
  if (!source) throw new Error(`palavra ${id} refere fonte ausente: ${sourceId}`);
  const text = nonEmptyString(value.text, `palavra ${id}.text`);
  const { start, end } = sourceRange(value, `palavra ${id}`, source.durationSeconds);
  const confidence = value.confidence ?? null;
  if (confidence !== null && (typeof confidence !== "number" || !Number.isFinite(confidence))) {
    throw new Error(`palavra ${id} com intervalo de confiança inválido`);
  }
  const word: Word = { id, sourceId, text, confidence, start, end };
  for (const key of ["cutStart", "cutEnd"] as const) {
    if (value[key] === undefined) continue;
    const cut = finiteNumber(value[key], `palavra ${id}.${key}`);
    if (cut < 0 || cut > source.durationSeconds) {
      throw new Error(`palavra ${id}.${key} fora da fonte`);
    }
    if (key === "cutStart" && cut > end) {
      throw new Error(`palavra ${id}.cutStart depois do fim da palavra`);
    }
    if (key === "cutEnd" && cut < start) {
      throw new Error(`palavra ${id}.cutEnd antes do início da palavra`);
    }
    word[key] = cut;
  }
  return word;
}

export function validateSpeechTake(value: unknown, sources: Map<string, Source>): SpeechTake {
  if (!isRecord(value)) throw new Error("take precisa ser um objeto");
  const id = nonEmptyString(value.id, "take.id");
  const sourceId = nonEmptyString(value.sourceId, "take.sourceId");
  const source = sources.get(sourceId);
  if (!source) throw new Error(`take ${id} refere fonte ausente: ${sourceId}`);
  const { start, end } = sourceRange(value, `take ${id}`, source.durationSeconds);
  const speechId = value.speechId ?? null;
  if (speechId !== null && typeof speechId !== "string") {
    throw new Error(`take ${id} com speechId inválido`);
  }
  for (const key of ["removed", "protected"] as const) {
    const list = value[key];
    if (!Array.isArray(list)) throw new Error(`take ${id}.${key} precisa ser um array`);
    for (const [i, entry] of list.entries()) {
      const range = sourceRange(entry, `take ${id}.${key}[${i}]`, source.durationSeconds);
      if (range.start < start || range.end > end) {
        throw new Error(`take ${id}.${key}[${i}] fora do intervalo do take`);
      }
    }
  }
  return {
    id,
    sourceId,
    speechId,
    start,
    end,
    removed: value.removed as SpeechTake["removed"],
    protected: value.protected as SpeechTake["protected"],
  };
}

export function validateTextCorrection(value: unknown, sources: Map<string, Source>): TextCorrection {
  if (!isRecord(value)) throw new Error("correção precisa ser um objeto");
  const id = nonEmptyString(value.id, "correção.id");
  const sourceId = nonEmptyString(value.sourceId, "correção.sourceId");
  const source = sources.get(sourceId);
  if (!source) throw new Error(`correção ${id} refere fonte ausente: ${sourceId}`);
  const { start, end } = sourceRange(value, `correção ${id}`, source.durationSeconds);
  const status = nonEmptyString(value.status, `correção ${id}.status`);
  if (!CORRECTION_STATUSES.has(status)) {
    throw new Error(`correção ${id} com status inválido: ${status}`);
  }
  if (!Array.isArray(value.words)) throw new Error(`correção ${id}.words precisa ser um array`);
  const words = (value.words as unknown[]).map((word) => validateWord(word, sources));
  for (const word of words) {
    if (word.sourceId !== sourceId) {
      throw new Error(`correção ${id} com palavra de outra fonte: ${word.id}`);
    }
  }
  return {
    id,
    sourceId,
    text: nonEmptyString(value.text, `correção ${id}.text`),
    status: status as TextCorrection["status"],
    words,
    error: optionalString(value.error, `correção ${id}.error`),
    start,
    end,
  };
}

function validateStageState(value: unknown, label: string): Preparation["sources"][string][
  "media"
] {
  if (typeof value !== "string" || !STATUSES.has(value)) {
    throw new Error(`${label} com estado inválido`);
  }
  return value as Preparation["sources"][string]["media"];
}

export function validatePreparation(value: unknown): Preparation {
  if (!isRecord(value)) throw new Error("preparação precisa ser um objeto");
  const id = nonEmptyString(value.id, "preparação.id");
  const mode = nonEmptyString(value.mode, "preparação.mode");
  if (mode !== "prepare" && mode !== "adjust" && mode !== "preview") {
    throw new Error("preparação.mode inválido");
  }
  const status = nonEmptyString(value.status, "preparação.status");
  if (status !== "running" && status !== "attention" && status !== "interrupted"
    && status !== "cancelled" && status !== "ready") {
    throw new Error("preparação.status inválido");
  }
  const stage = nonEmptyString(value.stage, "preparação.stage");
  if (stage !== "media" && stage !== "audio" && stage !== "visual"
    && stage !== "proposal" && stage !== "preview") {
    throw new Error("preparação.stage inválido");
  }
  if (!isRecord(value.sources)) throw new Error("preparação.sources precisa ser um objeto");
  const sources: Preparation["sources"] = {};
  for (const [sourceId, entry] of Object.entries(value.sources)) {
    if (!isRecord(entry)) throw new Error(`preparação da fonte ${sourceId} inválida`);
    sources[sourceId] = {
      media: validateStageState(entry.media, `preparação.${sourceId}.media`),
      audio: validateStageState(entry.audio, `preparação.${sourceId}.audio`),
      visual: validateStageState(entry.visual, `preparação.${sourceId}.visual`),
      error: optionalString(entry.error, `preparação.${sourceId}.error`),
    };
  }
  return {
    id,
    revision: nonNegativeInt(value.revision, "preparação.revision"),
    mode: mode as Preparation["mode"],
    request: typeof value.request === "string" ? value.request : "",
    status: status as Preparation["status"],
    stage: stage as Preparation["stage"],
    sources,
    error: optionalString(value.error, "preparação.error"),
    note: optionalString(value.note, "preparação.note"),
  };
}

function validateCoverage(value: unknown, label: string): VisualCoverage {
  if (!isRecord(value)) throw new Error(`${label} precisa ser um objeto`);
  return {
    requested: rangeList(value.requested, `${label}.requested`),
    returned: rangeList(value.returned, `${label}.returned`),
    missing: rangeList(value.missing, `${label}.missing`),
  };
}

function validateAnalysis(value: unknown, sources: Map<string, Source>, seen: Set<string>): Analysis {
  if (!isRecord(value)) throw new Error("análise precisa ser um objeto");
  const sourceId = nonEmptyString(value.sourceId, "análise.sourceId");
  if (!sources.has(sourceId)) {
    throw new Error(`análise refere fonte ausente: ${sourceId}`);
  }
  if (seen.has(sourceId)) throw new Error(`análise duplicada da fonte: ${sourceId}`);
  seen.add(sourceId);
  const status = nonEmptyString(value.status, `análise ${sourceId}.status`);
  if (status !== "ready" && status !== "partial" && status !== "error") {
    throw new Error(`análise ${sourceId} com status inválido`);
  }
  const speech = Array.isArray(value.speech) ? value.speech : [];
  for (const [i, span] of speech.entries()) {
    if (!isRecord(span)) throw new Error(`fala ${i} da fonte ${sourceId} inválida`);
    finiteNumber(span.start, `fala ${i}.start`);
    finiteNumber(span.end, `fala ${i}.end`);
    if (!((span.start as number) < (span.end as number))) {
      throw new Error(`fala ${i} da fonte ${sourceId} com intervalo inválido`);
    }
  }
  const visual = Array.isArray(value.visual) ? value.visual : [];
  for (const [i, span] of visual.entries()) {
    if (!isRecord(span)) throw new Error(`visual ${i} da fonte ${sourceId} inválido`);
    if (!VISUAL_CONFIDENCES.has(span.confidence as string)) {
      throw new Error(`visual ${i} da fonte ${sourceId} com confiança inválida`);
    }
  }
  if (!Array.isArray(value.words)) throw new Error(`análise ${sourceId}.words precisa ser um array`);
  const wordIds = new Set<string>();
  const words = (value.words as unknown[]).map((word) => {
    const valid = validateWord(word, sources);
    if (wordIds.has(valid.id)) throw new Error(`id de palavra duplicado: ${valid.id}`);
    wordIds.add(valid.id);
    return valid;
  });
  const wordsStatus = nonEmptyString(value.wordsStatus, `análise ${sourceId}.wordsStatus`);
  if (wordsStatus !== "ready" && wordsStatus !== "missing") {
    throw new Error(`análise ${sourceId} com wordsStatus inválido`);
  }
  return {
    sourceId,
    key: nonEmptyString(value.key, `análise ${sourceId}.key`),
    speech: speech as Analysis["speech"],
    visual: visual as Analysis["visual"],
    status: status as Analysis["status"],
    error: optionalString(value.error, `análise ${sourceId}.error`),
    words,
    wordsStatus: wordsStatus as Analysis["wordsStatus"],
    visualCoverage: validateCoverage(value.visualCoverage, `análise ${sourceId}.visualCoverage`),
  };
}

function validateSceneShape(
  value: unknown,
  index: number,
  sources: Map<string, Source>,
): Project["scenes"][number] {
  if (!isRecord(value)) throw new Error(`cena ${index} precisa ser um objeto`);
  const speechIds = Array.isArray(value.speechIds) ? value.speechIds.map(String) : [];
  // Propostas novas chegam sem takes; a tarefa 6 os constrói na validação.
  const takes = Array.isArray(value.takes)
    ? (value.takes as unknown[]).map((take) => validateSpeechTake(take, sources))
    : [];
  const visualEvidenceIds = Array.isArray(value.visualEvidenceIds)
    ? value.visualEvidenceIds.map((id, i) => {
      if (typeof id !== "string" || id.length === 0) {
        throw new Error(`cena ${index} com evidência visual inválida (${i})`);
      }
      return id;
    })
    : [];
  return {
    id: nonEmptyString(value.id, `cena ${index}.id`),
    objective: String(value.objective ?? ""),
    rationale: String(value.rationale ?? ""),
    speechIds,
    takes,
    visualEvidenceIds,
    support: Array.isArray(value.support) ? value.support as Project["scenes"][number]["support"] : [],
    gaps: Array.isArray(value.gaps) ? value.gaps.map(String) : [],
    ...(value.animationNotes !== undefined ? {animationNotes: validateAnimationNotes(value.animationNotes)} : {}),
  };
}

function approvalRevision(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  return nonNegativeInt(value, label);
}

function validateV2(value: Record<string, unknown>): Project {
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new Error("projeto.id inválido");
  }
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
    throw new Error("projeto.revision inválido");
  }
  if (!isRecord(value.input)) throw new Error("projeto.input precisa ser um objeto");
  const kind = value.input.kind;
  if (kind !== "script" && kind !== "brief") throw new Error("projeto.input.kind inválido");
  if (typeof value.input.text !== "string") throw new Error("projeto.input.text inválido");
  if (typeof value.input.targetSeconds !== "number" || !Number.isFinite(value.input.targetSeconds)) {
    throw new Error("projeto.input.targetSeconds inválido");
  }
  const assembly = validateAssembly(value.assembly);
  const sources = new Map(assembly.sources.map((source) => [source.id, source]));
  const scenes = Array.isArray(value.scenes)
    ? value.scenes.map((scene, i) => validateSceneShape(scene, i, sources))
    : [];
  if (!Array.isArray(value.analyses)) throw new Error("projeto.analyses precisa ser um array");
  const seenAnalyses = new Set<string>();
  const analyses = (value.analyses as unknown[]).map((analysis) =>
    validateAnalysis(analysis, sources, seenAnalyses)
  );
  if (!Array.isArray(value.corrections)) throw new Error("projeto.corrections precisa ser um array");
  const corrections = (value.corrections as unknown[]).map((correction) =>
    validateTextCorrection(correction, sources)
  );
  const preparation = value.preparation ?? null;
  if (preparation !== null) validatePreparation(preparation);
  if (!isRecord(value.permissions)) throw new Error("projeto.permissions precisa ser um objeto");
  if (typeof value.permissions.model !== "boolean" || typeof value.permissions.visual !== "boolean") {
    throw new Error("projeto.permissions precisa de model/visual booleanos");
  }
  const previewArtifact = value.previewArtifact ?? null;
  if (previewArtifact !== null) {
    if (!isRecord(previewArtifact)) throw new Error("projeto.previewArtifact precisa ser um objeto");
    nonNegativeInt(previewArtifact.revision, "previewArtifact.revision");
    nonEmptyString(previewArtifact.relativePath, "previewArtifact.relativePath");
    const sha = nonEmptyString(previewArtifact.sha256, "previewArtifact.sha256");
    if (!SHA256.test(sha)) throw new Error("previewArtifact.sha256 inválido");
    nonEmptyString(previewArtifact.assemblySha256, "previewArtifact.assemblySha256");
  }
  if (isRecord(value.proposal) && value.proposal.decisionReport !== undefined) {
    value.proposal.decisionReport = validateDecisionReport(value.proposal.decisionReport);
  }
  return {
    version: 2,
    id: value.id,
    revision: value.revision as number,
    input: {
      kind,
      text: value.input.text,
      targetSeconds: value.input.targetSeconds,
    },
    assembly,
    scenes,
    analyses,
    proposal: (value.proposal ?? null) as Project["proposal"],
    previewRevision: approvalRevision(value.previewRevision, "projeto.previewRevision"),
    finalApprovedRevision: approvalRevision(value.finalApprovedRevision, "projeto.finalApprovedRevision"),
    corrections,
    preparation: preparation as Project["preparation"],
    // Mesma referência de entrada quando válida: merge por revisão usa !==
    // para não deixar snapshot antigo reverter consentimentos atuais.
    permissions: value.permissions as Project["permissions"],
    previewArtifact: previewArtifact as Project["previewArtifact"],
  };
}

/**
 * Migração v1 → v2: fontes passam a `included: true`, análises antigas ficam
 * com palavras vazias e `wordsStatus: "missing"` (rederivadas do transcript
 * válido sem nova ASR), correções vazias, permissões negadas até autorização
 * explícita e preparação nula. Cenas e montagem antigas seguem intactas para
 * consulta; a conversão speechIds → takes acontece na tarefa 6, junto da
 * compilação/validação que consomem takes.
 */
function migrateV1(value: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(value.assembly)) throw new Error("projeto v1 sem assembly");
  const assembly = value.assembly as Record<string, unknown>;
  const sources = Array.isArray(assembly.sources) ? assembly.sources : [];
  const analyses = Array.isArray(value.analyses) ? value.analyses : [];
  const speechById = new Map<string, { sourceId: string; start: number; end: number }>();
  for (const analysis of analyses) {
    if (!isRecord(analysis) || !Array.isArray(analysis.speech)) continue;
    for (const span of analysis.speech) {
      if (!isRecord(span) || typeof span.id !== "string") continue;
      const start = span.start;
      const end = span.end;
      if (typeof start !== "number" || typeof end !== "number"
        || !Number.isFinite(start) || !Number.isFinite(end) || !(start < end)) continue;
      speechById.set(span.id, { sourceId: String(span.sourceId), start, end });
    }
  }
  const scenes = Array.isArray(value.scenes) ? value.scenes : [];
  const durations = new Map<string, number>();
  for (const source of sources) {
    if (!isRecord(source) || typeof source.id !== "string") continue;
    const duration = (source as Record<string, unknown>).durationSeconds;
    if (typeof duration === "number" && Number.isFinite(duration) && duration > 0) {
      durations.set(source.id, duration);
    }
  }
  return {
    ...value,
    version: 2,
    assembly: {
      ...assembly,
      sources: sources.map((source) => {
        const raw = source as Record<string, unknown>;
        const path = typeof raw.path === "string" ? raw.path : "";
        return { included: true, name: basename(path) || "mídia", ...raw };
      }),
    },
    analyses: (analyses as unknown[]).map((analysis) => {
      if (!isRecord(analysis)) throw new Error("projeto v1 com análise inválida");
      return {
        ...analysis,
        words: [],
        wordsStatus: "missing",
        visualCoverage: { requested: [], returned: [], missing: [] },
      };
    }),
    scenes: (scenes as unknown[]).map((scene) => {
      if (!isRecord(scene) || !Array.isArray(scene.speechIds) || typeof scene.id !== "string") {
        return scene;
      }
      const takes: Record<string, unknown>[] = [];
      for (const speechId of scene.speechIds.map(String)) {
        const span = speechById.get(speechId);
        const duration = durations.get(span?.sourceId ?? "");
        // Sem catálogo ou com span fora da fonte, preserva speechIds para
        // consulta e pede reanálise; nunca infere tempos por texto.
        if (!span || duration === undefined || span.start < 0 || span.end > duration) {
          return { ...scene, takes: [], visualEvidenceIds: [] };
        }
        takes.push({
          id: `${scene.id}:${speechId}`,
          sourceId: span.sourceId,
          speechId,
          start: span.start,
          end: span.end,
          removed: [],
          protected: [],
        });
      }
      return { ...scene, takes, visualEvidenceIds: [] };
    }),
    corrections: [],
    preparation: null,
    permissions: { model: false, visual: false },
    previewArtifact: null,
  };
}

export function validateProject(value: unknown): Project {
  if (!isRecord(value)) throw new Error("projeto precisa ser um objeto");
  if (value.version === 1) return validateV2(migrateV1(value));
  if (value.version === 2) return validateV2(value);
  throw new Error("projeto.version precisa ser 1 ou 2");
}

async function writeAtomic(dir: string, project: Project): Promise<void> {
  await publishAtomic(projectPath(dir), `${JSON.stringify(project, null, 2)}\n`);
}

export async function loadProject(dir: string): Promise<Project> {
  const raw = await readFile(projectPath(dir), "utf8");
  return validateProject(JSON.parse(raw));
}

export async function missingMedia(project: Project): Promise<Source[]> {
  const missing: Source[] = [];
  for (const source of project.assembly.sources) {
    const exists = await access(source.path).then(() => true, () => false);
    if (!exists) missing.push(source);
  }
  return missing;
}

export async function createProject(dir: string, initial: unknown): Promise<void> {
  // Aceita v1 e normaliza para v2; arquivo novo não tem o que preservar em backup.
  const project = validateProject(initial);
  await enqueue(dir, async () => {
    await acquireLock(dir);
    try {
      try {
        const handle = await open(projectPath(dir), "wx");
        await handle.writeFile(`${JSON.stringify(project, null, 2)}\n`);
        await handle.close();
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EEXIST") throw new Error("projeto já existe");
        throw err;
      }
    } finally {
      await releaseLock(dir);
    }
  });
}

export function mergeAnalyses(base: Analysis[], overlay: Analysis[]): Analysis[] {
  const map = new Map(base.map((item) => [item.sourceId, item]));
  for (const item of overlay) map.set(item.sourceId, item);
  return [...map.values()];
}

function relinkedSources(current: Assembly, base: Assembly, next: Assembly): Source[] {
  return current.sources.map((src) => {
    const fromBase = base.sources.find((item) => item.id === src.id);
    const fromNext = next.sources.find((item) => item.id === src.id);
    if (
      fromBase && fromNext
      && fromNext.path !== fromBase.path
      && fromNext.sha256 === src.sha256
    ) {
      return { ...src, path: fromNext.path };
    }
    return src;
  });
}

export function mergeCorrections(
  base: TextCorrection[],
  overlay: TextCorrection[],
): TextCorrection[] {
  const map = new Map(base.map((item) => [item.id, item]));
  for (const item of overlay) map.set(item.id, item);
  return [...map.values()];
}

/** Mesma revisão: não deixa snapshot antigo apagar aprovação/análise/relink. */
export function mergeProjectCommit(current: Project, next: Project, base?: Project): Project {
  if (next.revision < current.revision) {
    throw new Error(
      `revisão desatualizada: base ${next.revision}, atual ${current.revision}`,
    );
  }
  const analyses = mergeAnalyses(current.analyses, next.analyses);
  const corrections = mergeCorrections(current.corrections, next.corrections);
  if (next.revision > current.revision) {
    return { ...next, analyses, corrections };
  }
  if (!base) {
    return {
      ...current,
      analyses,
      corrections,
      proposal: next.proposal ?? current.proposal,
      previewRevision: next.previewRevision ?? current.previewRevision,
      finalApprovedRevision: next.finalApprovedRevision ?? current.finalApprovedRevision,
      preparation: next.preparation ?? current.preparation,
      permissions: next.permissions ?? current.permissions,
      previewArtifact: next.previewArtifact ?? current.previewArtifact,
    };
  }
  return {
    ...current,
    assembly: { ...current.assembly, sources: relinkedSources(current.assembly, base.assembly, next.assembly) },
    analyses,
    corrections,
    proposal: next.proposal !== base.proposal ? next.proposal : current.proposal,
    previewRevision: next.previewRevision !== base.previewRevision
      ? next.previewRevision
      : current.previewRevision,
    finalApprovedRevision: next.finalApprovedRevision !== base.finalApprovedRevision
      ? next.finalApprovedRevision
      : current.finalApprovedRevision,
    preparation: next.preparation !== base.preparation ? next.preparation : current.preparation,
    permissions: next.permissions !== base.permissions ? next.permissions : current.permissions,
    previewArtifact: next.previewArtifact !== base.previewArtifact
      ? next.previewArtifact
      : current.previewArtifact,
  };
}

export function backupPath(dir: string): string {
  return join(dir, "project.v1.backup.json");
}

/** Conteúdo editorial restaurável pelo undo — sem consentimentos nem aprovações. */
export type EditorialSnapshot = {
  revision: number;
  input: Project["input"];
  scenes: Project["scenes"];
  corrections: Project["corrections"];
  proposal: Project["proposal"];
};

function historyPath(dir: string, revision: number): string {
  return join(dir, "history", `rev-${revision}.json`);
}

/** Guarda o estado editorial antes da mutação; sobrescreve o mesmo rev. */
export async function writeHistorySnapshot(dir: string, project: Project): Promise<void> {
  const snapshot: EditorialSnapshot = {
    revision: project.revision,
    input: project.input,
    scenes: project.scenes,
    corrections: project.corrections,
    proposal: project.proposal,
  };
  await mkdir(join(dir, "history"), { recursive: true });
  await writeFile(historyPath(dir, project.revision), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

export async function readHistorySnapshot(dir: string, revision: number): Promise<EditorialSnapshot> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(historyPath(dir, revision), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`histórico inválido para a revisão ${revision}`);
    throw new Error(`sem histórico para a revisão ${revision}`);
  }
  if (!isRecord(raw) || raw.revision !== revision) {
    throw new Error(`histórico inválido para a revisão ${revision}`);
  }
  if (!isRecord(raw.input) || !Array.isArray(raw.scenes) || !Array.isArray(raw.corrections)) {
    throw new Error(`histórico inválido para a revisão ${revision}`);
  }
  for (const [i, scene] of raw.scenes.entries()) {
    if (!isRecord(scene) || typeof scene.id !== "string" || !Array.isArray(scene.takes)) {
      throw new Error(`histórico com cena inválida na revisão ${revision} (índice ${i})`);
    }
  }
  return raw as EditorialSnapshot;
}

export async function saveProject(
  dir: string,
  expectedRevision: number,
  nextOrFn: Project | LegacyProject | ((current: Project) => Project),
  base?: Project,
): Promise<void> {
  await enqueue(dir, async () => {
    await acquireLock(dir);
    try {
      // Lê os bytes crus para detectar v1 sem modificar nada na leitura.
      const rawText = await readFile(projectPath(dir), "utf8");
      const raw = JSON.parse(rawText) as { version?: unknown };
      const current = validateProject(raw);
      let next: Project;
      if (typeof nextOrFn === "function") {
        // Functional updates run inside the single writer: apply to the latest
        // bytes instead of 409'ing on a stale expectedRevision captured outside.
        next = validateProject(nextOrFn(current));
      } else {
        if (current.revision !== expectedRevision) {
          throw new Error(
            `revisão desatualizada: base ${expectedRevision}, atual ${current.revision}`,
          );
        }
        next = validateProject(mergeProjectCommit(current, validateProject(nextOrFn), base));
      }
      if (raw.version === 1) {
        // Primeira gravação v2: preserva o v1 exato uma única vez.
        try {
          const handle = await open(backupPath(dir), "wx");
          await handle.writeFile(rawText);
          await handle.close();
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        }
      }
      await writeAtomic(dir, next);
    } finally {
      await releaseLock(dir);
    }
  });
}
