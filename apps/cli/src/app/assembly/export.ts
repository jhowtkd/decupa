import { buildHandoff } from "./handoff.ts";
import { assertTimecodesReadable, davinciImportSettings, orientationOf, sourceChecklist } from "./otio.ts";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, link, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
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
  verificacao?: unknown;
};

/** Registro de conferência da importação (verificacao.json da entrega). */
export type VerificationRecord = {
  status: "pendente" | "confirmada";
  revision: number;
  artefato?: { timeline?: string; reference?: string };
  origem?: string | null;
  confirmadaEm?: string;
};

/**
 * Estado de conferência da revisão exportada. Diretórios de entrega são
 * por revisão: conteúdo novo nunca herda a confirmação da anterior.
 */
export async function readVerification(dir: string, revision: number): Promise<VerificationRecord | null> {
  try {
    const parsed = JSON.parse(
      await readFile(join(dir, "exports", String(revision), "verificacao.json"), "utf8"),
    ) as VerificationRecord;
    if (!parsed || parsed.revision !== revision) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Confirmação manual da conferência de importação: exige entrega íntegra
 * da revisão atual e grava revisão, artefato e origem (sempre "manual").
 */
export async function confirmImportVerification(project: Project, dir: string): Promise<VerificationRecord> {
  const dest = join(dir, "exports", String(project.revision));
  let manifest: ExportManifest | null;
  try {
    manifest = JSON.parse(await readFile(join(dest, "manifest.json"), "utf8")) as ExportManifest;
  } catch {
    manifest = null;
  }
  if (!manifest || manifest.revision !== project.revision || !(await exportedDirValid(dest))) {
    throw new Error(`sem entrega íntegra da revisão ${project.revision}: exporte antes de confirmar`);
  }
  const record: VerificationRecord = {
    status: "confirmada",
    revision: project.revision,
    artefato: {
      timeline: typeof manifest.timeline === "string" ? manifest.timeline : undefined,
      reference: typeof manifest.reference === "string" ? manifest.reference : undefined,
    },
    origem: "manual",
    confirmadaEm: new Date().toISOString(),
  };
  await writeFile(join(dest, "verificacao.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  manifest.verificacao = "confirmada";
  await writeFile(join(dest, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return record;
}

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
async function exportedDirValid(
  dest: string,
  aliases: { relativePath: string; sourcePath: string; sha256: string }[] = [],
): Promise<boolean> {
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
    // verificacao.json não pode usar hash fixo (a confirmação manual muda o
    // conteúdo depois): valida forma e identidade — objeto com a revisão do
    // manifest e status reconhecido.
    try {
      const verificacao = JSON.parse(
        await readFile(join(dest, "verificacao.json"), "utf8"),
      ) as { revision?: unknown; status?: unknown };
      if (verificacao.revision !== manifest.revision
        || typeof verificacao.status !== "string" || verificacao.status === "") {
        return false;
      }
    } catch {
      return false;
    }
    const refSha = await exportedFileSha(join(dest, "reference.mp4"));
    if (refSha !== manifest.reference) return false;
    for (const alias of aliases) {
      const [linked, original] = await Promise.all([
        stat(join(dest, alias.relativePath)), stat(alias.sourcePath),
      ]);
      if (linked.size !== original.size) return false;
      if ((linked.dev !== original.dev || linked.ino !== original.ino)
        && await exportedFileSha(join(dest, alias.relativePath)) !== alias.sha256) return false;
    }
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
    "o botão \"Confirmar conferência\" na Entrega para registrar a",
    "conferência manual desta revisão.",
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
    const aliases: { relativePath: string; sourcePath: string; sha256: string }[] = [];
    for (const [index, source] of snapshot.sources.entries()) {
      const resolved = await realpath(source.path);
      if (!isAbsolute(resolved)) {
        throw new Error(`fonte ${source.id} precisa de caminho absoluto`);
      }
      source.path = resolved;
      if (basename(resolved) !== source.name) {
        // O Resolve procura o basename do target_url; uploads usam UUID no disco.
        if (source.name.length > 255 || /[/\\\0]/.test(source.name)
          || source.name === "." || source.name === "..") {
          throw new Error(`nome original inválido na fonte ${source.id}`);
        }
        const relativePath = join("media", String(index), source.name);
        aliases.push({ relativePath, sourcePath: resolved, sha256: source.sha256 });
        source.path = join(dest, relativePath);
      }
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
      if (matchesExpected && (await exportedDirValid(dest, aliases))) {
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
      await writeFile(join(tmp, "verificacao.json"), `${JSON.stringify({
        status: "pendente",
        revision: project.revision,
        artefato: { timeline: otioSha, reference: refSha },
        origem: null,
      } satisfies VerificationRecord)}\n`, "utf8");
      await writeFile(join(tmp,"handoff.json"),handoffText);
      await writeFile(join(tmp,"handoff.md"),`# Handoff — revisão ${project.revision}\n\n`+buildHandoff(project).map(n=>`- ${n.sceneId} · frame ${n.startFrame}, ${n.durationFrames} frames · ${n.destination}: ${n.description}`).join("\n"));
      for (const alias of aliases) {
        const target = join(tmp, alias.relativePath);
        await mkdir(dirname(target), { recursive: true });
        try {
          await link(alias.sourcePath, target);
        } catch {
          await copyFile(alias.sourcePath, target);
        }
      }
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
      if (!(await exportedDirValid(tmp, aliases))) {
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
          if (same && (await exportedDirValid(dest, aliases))) return dest;
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
