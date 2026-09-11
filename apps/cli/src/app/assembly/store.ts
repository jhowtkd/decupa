import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { access } from "node:fs/promises";
import type { Analysis, Assembly, Project, Source } from "./types.ts";
import { validateAssembly } from "./validate.ts";

const queues = new Map<string, Promise<unknown>>();

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

function enqueue<T>(dir: string, work: () => Promise<T>): Promise<T> {
  const prev = queues.get(dir) ?? Promise.resolve();
  const next = prev.then(work, work);
  queues.set(dir, next.then(() => undefined, () => undefined));
  return next;
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

export function validateProject(value: unknown): Project {
  if (!isRecord(value)) throw new Error("projeto precisa ser um objeto");
  if (value.version !== 1) throw new Error("projeto.version precisa ser 1");
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
  return {
    version: 1,
    id: value.id,
    revision: value.revision as number,
    input: {
      kind,
      text: value.input.text,
      targetSeconds: value.input.targetSeconds,
    },
    assembly,
    scenes: Array.isArray(value.scenes) ? value.scenes as Project["scenes"] : [],
    analyses: Array.isArray(value.analyses) ? value.analyses as Project["analyses"] : [],
    proposal: (value.proposal ?? null) as Project["proposal"],
    structureApprovedRevision: (value.structureApprovedRevision ?? null) as number | null,
    previewRevision: (value.previewRevision ?? null) as number | null,
    finalApprovedRevision: (value.finalApprovedRevision ?? null) as number | null,
  };
}

async function writeAtomic(dir: string, project: Project): Promise<void> {
  const target = projectPath(dir);
  const tmp = join(dir, `project.json.${process.pid}.tmp`);
  await writeFile(tmp, `${JSON.stringify(project, null, 2)}\n`, "utf8");
  await rename(tmp, target);
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

export async function createProject(dir: string, initial: Project): Promise<void> {
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

/** Mesma revisão: não deixa snapshot antigo apagar aprovação/análise/relink. */
export function mergeProjectCommit(current: Project, next: Project, base?: Project): Project {
  if (next.revision < current.revision) {
    throw new Error(
      `revisão desatualizada: base ${next.revision}, atual ${current.revision}`,
    );
  }
  const analyses = mergeAnalyses(current.analyses, next.analyses);
  if (next.revision > current.revision) {
    return { ...next, analyses };
  }
  if (!base) {
    return {
      ...current,
      analyses,
      proposal: next.proposal ?? current.proposal,
      structureApprovedRevision: next.structureApprovedRevision ?? current.structureApprovedRevision,
      previewRevision: next.previewRevision ?? current.previewRevision,
      finalApprovedRevision: next.finalApprovedRevision ?? current.finalApprovedRevision,
    };
  }
  return {
    ...current,
    assembly: { ...current.assembly, sources: relinkedSources(current.assembly, base.assembly, next.assembly) },
    analyses,
    proposal: next.proposal !== base.proposal ? next.proposal : current.proposal,
    structureApprovedRevision: next.structureApprovedRevision !== base.structureApprovedRevision
      ? next.structureApprovedRevision
      : current.structureApprovedRevision,
    previewRevision: next.previewRevision !== base.previewRevision
      ? next.previewRevision
      : current.previewRevision,
    finalApprovedRevision: next.finalApprovedRevision !== base.finalApprovedRevision
      ? next.finalApprovedRevision
      : current.finalApprovedRevision,
  };
}

export async function saveProject(
  dir: string,
  expectedRevision: number,
  nextOrFn: Project | ((current: Project) => Project),
  base?: Project,
): Promise<void> {
  await enqueue(dir, async () => {
    await acquireLock(dir);
    try {
      const current = await loadProject(dir);
      if (current.revision !== expectedRevision) {
        throw new Error(
          `revisão desatualizada: base ${expectedRevision}, atual ${current.revision}`,
        );
      }
      const next = typeof nextOrFn === "function"
        ? validateProject(nextOrFn(current))
        : validateProject(mergeProjectCommit(current, nextOrFn, base));
      await writeAtomic(dir, next);
    } finally {
      await releaseLock(dir);
    }
  });
}
