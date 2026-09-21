import { buildHandoff } from "./handoff.ts";
import { assertTimecodesReadable, davinciImportSettings, orientationOf, sourceChecklist } from "./otio.ts";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { buildOtio } from "./otio.ts";
import { hashFile, probe } from "@decupa/media";
import { verifySourceIdentity } from "./media.ts";
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

type ExportManifest = {
  revision?: unknown;
  timeline?: unknown;
  reference?: unknown;
  sources?: unknown;
  handoff?: unknown;
  instrucoes?: unknown;
};

async function exportedFileSha(path: string): Promise<string | null> {
  try {
    return await sha256(path);
  } catch {
    return null;
  }
}

/**
 * Confere se o diretório de exportação está íntegro: manifest presente,
 * hashes dos arquivos reais conferem com o manifest e o MP4 tem
 * integridade (probe). Não basta a existência do manifest.
 */
async function exportedDirValid(dest: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(
      await readFile(join(dest, "manifest.json"), "utf8"),
    ) as ExportManifest;
    if (typeof manifest.timeline !== "string" || typeof manifest.reference !== "string") {
      return false;
    }
    const otioSha = await exportedFileSha(join(dest, "timeline.otio"));
    if (otioSha !== manifest.timeline) return false;
    if (manifest.handoff !== undefined && await exportedFileSha(join(dest, "handoff.json")) !== manifest.handoff) return false;
    if (manifest.instrucoes !== undefined && await exportedFileSha(join(dest, "importar-no-resolve.txt")) !== manifest.instrucoes) return false;
    const refSha = await exportedFileSha(join(dest, "reference.mp4"));
    if (refSha !== manifest.reference) return false;
    const info = await probe(join(dest, "reference.mp4")).catch(() => null);
    if (!info || (!info.hasVideo && !info.hasAudio) || info.durationMs <= 0) {
      return false;
    }
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
/**
 * Texto que acompanha a entrega: formato exato, passo a passo do Resolve
 * gratuito e o que conferir por fonte (timecode, taxa, rotação).
 */
export function importInstructions(project: Project): string {
  const assembly = project.assembly;
  const settings = davinciImportSettings(assembly);
  const fps = `${assembly.fps.num}/${assembly.fps.den}`;
  return [
    "Decupa — conferir a entrega no DaVinci Resolve (versão gratuita)",
    "",
    `Revisão ${project.revision} · montagem "${assembly.name}"`,
    `Formato da timeline: ${assembly.width}×${assembly.height} (${orientationOf(assembly)}) @ ${fps} fps (${settings.timelineFrameRate})`,
    "",
    "Passo a passo:",
    ...settings.procedure.map((step, index) => `${index + 1}. ${step}`),
    "",
    "Mídia esperada por fonte:",
    ...sourceChecklist(assembly),
    "",
    "Verificação de importação: pendente — após importar e conferir, use",
    "a seção Entrega para registrar a conferência desta revisão.",
    "",
  ].join("\n");
}

export async function exportApproved(project: Project, dir: string): Promise<string> {
  if (project.finalApprovedRevision !== project.revision) {
    throw new Error("aprovação final desatualizada");
  }
  assertTimecodesReadable(project.assembly);
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
    await verifySourceIdentity(source);
  }

  // Edição ou troca de mídia durante a exportação não vira entrega atual.
  const fresh = await loadProject(dir);
  if (fresh.revision !== project.revision) {
    throw new Error(`revisão mudou durante a exportação: base ${project.revision}, atual ${fresh.revision}`);
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
    const handoffText = JSON.stringify({projectId:project.id,revision:project.revision,items:buildHandoff(project)},null,2)+"\n";
    const handoffSha = createHash("sha256").update(handoffText).digest("hex");
    const instructionsText = importInstructions(project);
    const instructionsSha = createHash("sha256").update(instructionsText, "utf8").digest("hex");
    const sourceShas = Object.fromEntries(
      snapshot.sources.map((s) => [s.id, s.sha256]),
    );
    let matchesExpected = false;
    try {
      const existing = JSON.parse(await readFile(manifestPath, "utf8")) as ExportManifest;
      matchesExpected =
        existing.revision === project.revision
        && existing.timeline === otioSha
        && existing.reference === refSha
        && existing.handoff === handoffSha
        && existing.instrucoes === instructionsSha
        && JSON.stringify(existing.sources) === JSON.stringify(sourceShas);
      if (matchesExpected && (await exportedDirValid(dest))) {
        return dest;
      }
    } catch {
      // Sem manifest válido: publica abaixo.
    }
    // Prepara e valida toda a substituta ANTES de retirar a entrega
    // existente: falha de gravação nunca apaga o destino anterior (R4).
    const tmp = join(dir, "exports", `.tmp-${project.revision}-${process.pid}-${Date.now()}`);
    try {
      await mkdir(tmp, { recursive: true });
      const otioPath = join(tmp, "timeline.otio");
      await writeFile(otioPath, otioText, "utf8");
      await copyFile(reference, join(tmp, "reference.mp4"));
      await writeFile(join(tmp, "importar-no-resolve.txt"), instructionsText, "utf8");
      await writeFile(join(tmp, "verificacao.json"), JSON.stringify({status:"pendente",revision:project.revision})+"\n", "utf8");
      await writeFile(join(tmp,"handoff.json"),handoffText);
      await writeFile(join(tmp,"handoff.md"),`# Handoff — revisão ${project.revision}\n\n`+buildHandoff(project).map(n=>`- ${n.sceneId} · frame ${n.startFrame}, ${n.durationFrames} frames · ${n.destination}: ${n.description}`).join("\n"));
      const manifest = {
        handoff: handoffSha,
        instrucoes: instructionsSha,
        revision: project.revision,
        timeline: otioSha,
        reference: refSha,
        sources: sourceShas,
        formato: {
          width: snapshot.width,
          height: snapshot.height,
          orientation: orientationOf(snapshot),
          fps: snapshot.fps,
        },
        midia: snapshot.sources.map((source) => ({
          id: source.id,
          name: source.name,
          fps: source.fps,
          width: source.width,
          height: source.height,
          rotation: source.rotation ?? 0,
          timecode: source.timecode ?? null,
        })),
        verificacao: "pendente",
      };
      await writeFile(join(tmp, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      if (!(await exportedDirValid(tmp))) {
        throw new Error("substituta inválida ao gravar a exportação");
      }
    } catch (err) {
      const { rm } = await import("node:fs/promises");
      await rm(tmp, { recursive: true, force: true });
      throw err;
    }
    // Substituta pronta e validada: só agora retira a entrega anterior.
    {
      const { rm } = await import("node:fs/promises");
      await rm(dest, { recursive: true, force: true });
    }
    try {
      await rename(tmp, dest);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ENOTEMPTY" || code === "EISDIR") {
        // Colisão de rename só reutiliza destino verificado e esperado.
        try {
          const existing = JSON.parse(await readFile(manifestPath, "utf8")) as ExportManifest;
          const same =
            existing.revision === project.revision
            && existing.timeline === otioSha
            && existing.reference === refSha
            && existing.handoff === handoffSha
            && existing.instrucoes === instructionsSha
            && JSON.stringify(existing.sources) === JSON.stringify(sourceShas);
          if (same && (await exportedDirValid(dest))) return dest;
        } catch {
          // Manifest ilegível: destino inconsistente abaixo.
        }
        throw new Error(`export da revisão ${project.revision} está inconsistente: reexporte`);
      }
      throw err;
    }
    return dest;
  } finally {
    await unlink(lock).catch(() => {});
  }
}
