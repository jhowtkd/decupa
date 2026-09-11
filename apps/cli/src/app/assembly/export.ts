import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, copyFile, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { realpath } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { Executor } from "../pipeline.ts";
import { buildOtio } from "./otio.ts";
import { renderAssembly } from "./render.ts";
import { hashFile } from "@decupa/media";
import { missingMedia } from "./store.ts";
import type { Project } from "./types.ts";

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireExportLock(dir: string, revision: number): Promise<string> {
  const exportsDir = join(dir, "exports");
  await mkdir(exportsDir, { recursive: true });
  const path = join(exportsDir, `.rev-${revision}.lock`);
  try {
    const handle = await open(path, "wx");
    await handle.writeFile(`${process.pid}\n`);
    await handle.close();
    return path;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw err;
  }
  const raw = await readFile(path, "utf8").catch(() => "");
  const pid = Number(raw.trim());
  if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) {
    throw new Error(`export da revisão ${revision} já está em andamento`);
  }
  await unlink(path).catch(() => {});
  const handle = await open(path, "wx");
  await handle.writeFile(`${process.pid}\n`);
  await handle.close();
  return path;
}

export async function exportApproved(
  project: Project,
  dir: string,
  exec: Executor,
): Promise<string> {
  if (project.finalApprovedRevision !== project.revision) {
    throw new Error("aprovação final desatualizada");
  }
  for (const source of project.assembly.sources) {
    if (!isAbsolute(source.path)) {
      throw new Error(`fonte ${source.id} precisa de caminho absoluto`);
    }
  }
  const missing = await missingMedia(project);
  if (missing.length > 0) {
    throw new Error(`mídia ausente: ${missing.map((s) => `${s.id} (${s.path})`).join(", ")}`);
  }
  for (const source of project.assembly.sources) {
    const current = await hashFile(source.path);
    if (current !== source.sha256) {
      throw new Error(
        `fonte ${source.id} foi substituída; reanalise ou relink com o hash original`,
      );
    }
  }

  const dest = join(dir, "exports", String(project.revision));
  const manifestPath = join(dest, "manifest.json");
  const lock = await acquireExportLock(dir, project.revision);
  try {
    if (await access(manifestPath).then(() => true, () => false)) {
      return dest;
    }

    const snapshot = structuredClone(project.assembly);
    for (const source of snapshot.sources) {
      const resolved = await realpath(source.path);
      if (!isAbsolute(resolved)) {
        throw new Error(`fonte ${source.id} precisa de caminho absoluto`);
      }
      source.path = resolved;
    }
    const tmp = join(dir, "exports", `.tmp-${project.revision}-${process.pid}-${Date.now()}`);
    await mkdir(tmp, { recursive: true });
    const otioPath = join(tmp, "timeline.otio");
    await writeFile(otioPath, `${buildOtio(snapshot)}\n`, "utf8");
    const rendered = await renderAssembly(snapshot, tmp, exec);
    const reference = join(tmp, "reference.mp4");
    if (rendered !== reference) await copyFile(rendered, reference);
    const manifest = {
      revision: project.revision,
      timeline: await sha256(otioPath),
      reference: await sha256(reference),
      sources: Object.fromEntries(
        await Promise.all(snapshot.sources.map(async (s) => [s.id, await sha256(s.path)])),
      ),
    };
    await writeFile(join(tmp, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    try {
      await rename(tmp, dest);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ENOTEMPTY" || code === "EISDIR") {
        if (await access(manifestPath).then(() => true, () => false)) return dest;
        throw new Error(`export da revisão ${project.revision} já está em andamento`);
      }
      throw err;
    }
    return dest;
  } finally {
    await unlink(lock).catch(() => {});
  }
}
