import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, copyFile, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { buildOtio } from "./otio.ts";
import { hashFile, probe } from "@decupa/media";
import { loadProject, missingMedia } from "./store.ts";
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

/**
 * Exporta exatamente o MP4 assistido e aprovado: copia a referência do
 * `previewArtifact` em vez de renderizar outro vídeo. Sem Executor de
 * propósito — exportação nunca renderiza.
 */
export async function exportApproved(project: Project, dir: string): Promise<string> {
  if (project.finalApprovedRevision !== project.revision) {
    throw new Error("aprovação final desatualizada");
  }
  const artifact = project.previewArtifact;
  if (!artifact || artifact.revision !== project.revision) {
    throw new Error("prévia desatualizada: gere a prévia da revisão atual");
  }
  const assemblySha256 = createHash("sha256").update(JSON.stringify(project.assembly)).digest("hex");
  if (artifact.assemblySha256 !== assemblySha256) {
    throw new Error("prévia de outra montagem: gere a prévia da revisão atual");
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

  // Edição ou troca de mídia durante a exportação não vira entrega atual.
  try {
    const fresh = await loadProject(dir);
    if (fresh.revision !== project.revision) {
      throw new Error(`revisão mudou durante a exportação: base ${project.revision}, atual ${fresh.revision}`);
    }
  } catch (err) {
    if (err instanceof Error && /mudou durante/.test(err.message)) throw err;
  }
  const reference = resolve(dir, artifact.relativePath);
  if (reference !== dir && !reference.startsWith(dir + sep)) {
    throw new Error("artefato de prévia fora do projeto");
  }
  let refSha: string;
  try {
    refSha = await hashFile(reference);
  } catch {
    throw new Error("prévia ausente ou ilegível: gere a prévia da revisão atual");
  }
  if (refSha !== artifact.sha256) {
    throw new Error("prévia alterada ou truncada: gere a prévia da revisão atual");
  }
  const info = await probe(reference).catch((err: unknown) => {
    throw new Error(`prévia sem integridade: ${err instanceof Error ? err.message : String(err)}`);
  });
  if (!info.hasVideo && !info.hasAudio) {
    throw new Error("prévia sem streams de vídeo nem áudio");
  }
  if (info.durationMs <= 0) {
    throw new Error("prévia com duração zerada");
  }

  const dest = join(dir, "exports", String(project.revision));
  const manifestPath = join(dest, "manifest.json");
  const lock = await acquireExportLock(dir, project.revision);
  try {
    const snapshot = structuredClone(project.assembly);
    for (const source of snapshot.sources) {
      const resolved = await realpath(source.path);
      if (!isAbsolute(resolved)) {
        throw new Error(`fonte ${source.id} precisa de caminho absoluto`);
      }
      source.path = resolved;
    }
    const otioText = `${buildOtio(snapshot)}\n`;
    const otioSha = createHash("sha256").update(otioText, "utf8").digest("hex");
    const sourceShas = Object.fromEntries(
      await Promise.all(snapshot.sources.map(async (s) => [s.id, await sha256(s.path)])),
    );
    try {
      const existing = JSON.parse(await readFile(manifestPath, "utf8")) as {
        revision?: unknown; timeline?: unknown; reference?: unknown; sources?: unknown;
      };
      if (
        existing.revision === project.revision
        && existing.timeline === otioSha
        && existing.reference === refSha
        && JSON.stringify(existing.sources) === JSON.stringify(sourceShas)
      ) {
        return dest;
      }
    } catch {
      // Sem manifest válido: publica abaixo.
    }
    const tmp = join(dir, "exports", `.tmp-${project.revision}-${process.pid}-${Date.now()}`);
    await mkdir(tmp, { recursive: true });
    const otioPath = join(tmp, "timeline.otio");
    await writeFile(otioPath, otioText, "utf8");
    await copyFile(reference, join(tmp, "reference.mp4"));
    const manifest = {
      revision: project.revision,
      timeline: otioSha,
      reference: refSha,
      sources: sourceShas,
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
