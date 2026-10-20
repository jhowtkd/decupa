import { randomUUID } from "node:crypto";
import { copyFile, link, lstat, mkdir, open, readFile, realpath, rm, stat } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { createSpaceManager } from "./space.ts";

type Source = { sha256: string; path?: string; size?: number; mtimeMs?: number };
/** Inspeciona apenas ancestrais do arquivo escolhido, sem descobrir irmãos. */
async function owningProject(path: string): Promise<string | null> {
  let dir = dirname(path);
  for (;;) {
    try {
      const manifest = join(dir, "project.json");
      const entry = await lstat(manifest);
      if (entry.isFile() && !entry.isSymbolicLink()) {
        const project = JSON.parse(await readFile(manifest, "utf8")) as { assembly?: { sources?: unknown } };
        if (Array.isArray(project?.assembly?.sources)) return dir;
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = dirname(dir); if (parent === dir) return null;
    dir = parent;
  }
}
async function committedPaths(dir: string): Promise<Set<string> | null> {
  try {
    const project = JSON.parse(await readFile(join(dir, "project.json"), "utf8")) as { assembly?: { sources?: Source[] } };
    if (!Array.isArray(project?.assembly?.sources)) return null;
    return new Set(project.assembly.sources.flatMap(source => source.path ? [source.path] : []));
  } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? new Set() : null; }
}
/** Entre ledgers a fonte passa a ter nome próprio, preservado mesmo quando a origem sai. */
export async function withProjectSourceImports<T>(
  dir: string, root: string, sources: Source[], sameScope: (ownerDir: string) => Promise<boolean>, publish: () => Promise<T>,
): Promise<T> {
  const created: { source: Source; original: Source; path: string }[] = [];
  const reservations: (() => Promise<void>)[] = [];
  try {
    const projectDir = await realpath(dir);
    for (const source of sources) {
      if (!source.path) continue;
      let original: string;
      try { original = await realpath(source.path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const owner = await owningProject(resolve(source.path));
        const canonicalOwner = owner ? await realpath(owner) : null;
        if (canonicalOwner && canonicalOwner !== projectDir && !await sameScope(canonicalOwner)) {
          throw new Error("fonte de outro Projeto indisponível; selecione novamente");
        }
        continue;
      }
      const owner = await owningProject(original);
      if (!owner || owner === projectDir || await sameScope(owner)) continue;
      const entry = await stat(original);
      if (!entry.isFile()) throw new Error("fonte de outro Projeto precisa ser um arquivo");
      const importsDir = join(projectDir, "imports");
      await mkdir(importsDir, { recursive: true });
      const imports = await lstat(importsDir);
      if (!imports.isDirectory() || imports.isSymbolicLink()) throw new Error("imports do Projeto não pode ser um link simbólico");
      const destination = join(importsDir, `${randomUUID()}${extname(original)}`);
      try {
        await link(original, destination);
        created.push({ source, original: { ...source }, path: destination });
      } catch (error) {
        if (!["EXDEV", "EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "EMLINK"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        const release = await createSpaceManager(resolve(root)).reserve("source-import", [{ path: importsDir, bytes: entry.size, materializedPath: destination }]);
        reservations.push(release);
        // O placeholder exclusivo permite limpar um parcial sem apagar arquivo alheio.
        const file = await open(destination, "wx"); await file.close();
        created.push({ source, original: { ...source }, path: destination });
        await copyFile(original, destination);
        const copied = await stat(destination);
        const current = await stat(original);
        if (copied.size !== entry.size || current.size !== entry.size || current.mtimeMs !== entry.mtimeMs) throw new Error("fonte mudou durante a cópia; selecione novamente");
        source.size = copied.size; source.mtimeMs = copied.mtimeMs;
      }
      source.path = destination;
    }
    return await publish();
  } catch (error) {
    const saved = await committedPaths(dir);
    for (const item of created) {
      // Uma falha depois do rename de project.json pode ter publicado a fonte.
      if (saved === null || saved.has(item.path)) continue;
      await rm(item.path, { force: true }).catch(() => {});
      item.source.path = item.original.path;
      item.source.size = item.original.size; item.source.mtimeMs = item.original.mtimeMs;
    }
    throw error;
  } finally {
    // Falha de manutenção posterior não invalida um commit editorial durável.
    for (const release of reservations) await release().catch(() => {});
  }
}
