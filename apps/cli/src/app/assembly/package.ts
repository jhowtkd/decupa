import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, isAbsolute, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { hashFile } from "@decupa/media";
import { MIDIA_EXTENSOES } from "../drive-import.ts";
import { parseRange } from "../../http/media.ts";
import { mediaKey, resourceLedgerForProject, withResourceWork } from "../resource-ledger.ts";
import { buildOtio } from "./otio.ts";
import type { Project } from "./types.ts";

export type PackageEntry = { name: string; path: string; size: number; sha256: string; mtimeMs: number; ino: number; dev: number };
export type PackageManifest = { version: 1; revision: number; sources: Record<string, string>; entries: PackageEntry[] };
const run = promisify(execFile);
const mediaExtension = (value: string) => MIDIA_EXTENSOES.has(value.slice(1).toLowerCase());
async function extensionFromFile(path: string): Promise<string> {
  const extension = extname(path);
  if (mediaExtension(extension)) return extension;
  try {
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=format_name:format_tags=major_brand", "-of", "json", path], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    const format = (JSON.parse(stdout) as { format?: { format_name?: string; tags?: { major_brand?: string } } }).format;
    const names = format?.format_name?.split(",") ?? [];
    if (names.includes("mov")) return format?.tags?.major_brand?.trim() === "qt" ? ".mov" : ".mp4";
    if (names.includes("matroska") || names.includes("webm")) return ".mkv";
    if (names.includes("mpegts")) return ".ts";
    if (names.includes("mpeg")) return ".mpg";
    const name = names[0];
    return name && /^[a-z][a-z0-9]{0,7}$/i.test(name) ? `.${name}` : "";
  } catch {
    // Missing/unknown container metadata must not block the existing local delivery.
    return "";
  }
}
type FileIdentity = Pick<PackageEntry, "size" | "mtimeMs" | "ino" | "dev">;
const validatedFiles = new Map<string, FileIdentity & { sha256: string }>();
const sameFile = (left: FileIdentity, right: FileIdentity) => left.size === right.size && left.mtimeMs === right.mtimeMs && left.ino === right.ino && left.dev === right.dev;
function rememberFile(path: string, identity: FileIdentity, sha256: string) {
  if (validatedFiles.size >= 2048) validatedFiles.delete(validatedFiles.keys().next().value!);
  validatedFiles.set(path, { size: identity.size, mtimeMs: identity.mtimeMs, ino: identity.ino, dev: identity.dev, sha256 });
}
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export const packageOwnerId = (dir: string, revision: number | string) => `package:${resolve(dir)}:${revision}`;

/** Only metadata is materialized; originals are read directly while downloading. */
export async function writePackage(project: Project, tmp: string, instructions: string, artifactDir = tmp): Promise<void> {
  const used = new Set(project.assembly.tracks.flatMap(t => t.clips.map(c => c.sourceId)));
  const sources = project.assembly.sources.filter(source => used.has(source.id));
  const paths: [string, string][] = [];
  for (const [index, source] of sources.entries()) {
    const sanitize = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^a-zA-Z0-9._-]/g, "_");
    const displayed = extname(source.name);
    const namedExtension = mediaExtension(displayed);
    const suffix = namedExtension ? displayed : await extensionFromFile(source.path);
    const originalStem = namedExtension ? source.name.slice(0, -displayed.length) : source.name;
    const stem = sanitize(originalStem).slice(0, 72 - suffix.length) || "media";
    paths.push([source.id, `${index + 1}-${stem}${suffix}`]);
  }
  const sourcePaths = Object.fromEntries(paths);
  const portable = join(tmp, "portable"); await mkdir(portable);
  const timeline = buildOtio(project.assembly, { sourcePaths }) + "\n";
  const relink = [
    "Decupa — pacote portátil: pronto para validação, compatibilidade ainda não comprovada.",
    "Extraia o TAR inteiro numa segunda máquina; mantenha as fontes ao lado de timeline.otio.",
    `Se o sistema não abrir TAR, use no terminal: tar -xf decupa-r${project.revision}.tar`,
    "Abra um projeto novo no DaVinci Resolve real e importe timeline.otio (File → Import → Timeline).",
    "Se a mídia ficar offline, selecione os clipes no Media Pool e use Relink Selected Clips apontando para a pasta extraída.",
    "Confira todas as fontes, pistas, in-points, duração, fps, canvas, rotação e áudio contra reference.mp4.",
    "Importe legendas.srt se disponível e confira a sincronização. Só depois confirme a conferência no Decupa.",
    "O download, sozinho, não comprova que a entrega foi preservada ou importada.",
    "A conferência local anterior não comprova a compatibilidade deste pacote na segunda máquina.",
    "", "Nomes originais → arquivos no pacote:",
    ...sources.map(source => `${source.name} → ${sourcePaths[source.id]}`), "", instructions,
  ].join("\n");
  const exported = JSON.parse(await readFile(join(artifactDir, "manifest.json"), "utf8"));
  const publicManifest = { ...exported, timeline: digest(timeline), instrucoes: digest(relink),
    sources: Object.fromEntries(sources.map(s => [s.id, s.sha256])),
    package: { format: "tar", sourcePaths, compatibility: "pending-second-machine" } };
  delete publicManifest.verificacao;
  await writeFile(join(portable, "timeline.otio"), timeline);
  await writeFile(join(portable, "importar-no-resolve.txt"), relink);
  await writeFile(join(portable, "manifest.json"), JSON.stringify(publicManifest, null, 2) + "\n");
  const entries: PackageEntry[] = [];
  async function entry(name: string, path: string, sha256?: string) {
    const physical = isAbsolute(path) ? path : join(path.startsWith("portable/") ? tmp : artifactDir, path);
    const info = await stat(physical);
    if (!info.isFile() || !Number.isSafeInteger(info.size)) throw new Error(`arquivo inválido no pacote: ${name}`);
    entries.push({ name, path, size: info.size, mtimeMs: info.mtimeMs, ino: info.ino, dev: info.dev, sha256: sha256 ?? await hashFile(physical) });
  }
  for (const name of ["timeline.otio", "manifest.json", "importar-no-resolve.txt"]) await entry(name, `portable/${name}`);
  for (const name of ["reference.mp4", "handoff.json", "handoff.md"]) await entry(name, name);
  if (exported.legendas?.status === "pronto") {
    for (const name of ["legendas.vtt", "legendas.srt"]) await entry(name, name);
  }
  for (const source of sources) await entry(sourcePaths[source.id]!, resolve(source.path), source.sha256);
  const manifest: PackageManifest = { version: 1, revision: project.revision, sources: publicManifest.sources, entries };
  await writeFile(join(tmp, "package-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

type PackageCheck = { verifyHashes?: boolean; artifactDir?: string; statOnly?: boolean };
export async function packageValid(dest: string, options: PackageCheck = {}): Promise<boolean> {
  try { await loadPackage(dest, options); return true; } catch { return false; }
}
async function loadPackage(dest: string, { verifyHashes = false, artifactDir = dest, statOnly = false }: PackageCheck = {}): Promise<{ manifest: PackageManifest; text: string }> {
  const text = await readFile(join(dest, "package-manifest.json"), "utf8");
  const manifest = JSON.parse(text) as PackageManifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.entries) || !manifest.entries.length) throw new Error("manifesto do pacote inválido");
  const names = new Set<string>();
  for (const entry of manifest.entries) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(entry.name) || entry.name.length > 100
      || entry.name.startsWith("/") || entry.name.split("/").some(p => !p || p === "." || p === "..")
      || names.has(entry.name.toLowerCase()) || !Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error("entrada do pacote inválida");
    names.add(entry.name.toLowerCase());
    const physical = isAbsolute(entry.path) ? entry.path : join(entry.path.startsWith("portable/") ? dest : artifactDir, entry.path);
    const info = await stat(physical).catch(() => null);
    const invalid = () => Object.assign(new Error(`pacote alterado ou fonte ausente: ${entry.name}; exporte novamente`), { status: 409 });
    if (!info?.isFile() || info.size !== entry.size) throw invalid();
    const cached = validatedFiles.get(physical);
    const unchanged = sameFile(info, entry) || (cached?.sha256 === entry.sha256 && sameFile(info, cached));
    if (statOnly && !unchanged) throw invalid();
    if (verifyHashes || !unchanged) {
      if (await hashFile(physical) !== entry.sha256) throw invalid();
      if (!verifyHashes) rememberFile(physical, info, entry.sha256);
    }
  }
  return { manifest, text };
}

function tarHeader(name: string, size: number, type = "0"): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "ascii");
  const octal = (value: number, offset: number, width: number) => header.write(value.toString(8).padStart(width - 1, "0") + "\0", offset, width, "ascii");
  octal(0o644, 100, 8); octal(0, 108, 8); octal(0, 116, 8); octal(size, 124, 12); octal(0, 136, 12);
  header.fill(32, 148, 156); header.write(type, 156, 1); header.write("ustar\0", 257); header.write("00", 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return header;
}
type Segment = { start: number; size: number; data?: Buffer; path?: string };
function tarSegments(dest: string, entries: PackageEntry[]) {
  const segments: Segment[] = []; let size = 0;
  const append = (part: Omit<Segment, "start">) => { segments.push({ ...part, start: size }); size += part.size; };
  const bytes = (data: Buffer) => append({ data, size: data.length });
  for (const entry of entries) {
    // PAX carries files >= 8 GiB without truncating the ustar octal field.
    const large = entry.size > 0o77777777777;
    if (large) {
      const value = ` size=${entry.size}\n`; let length = value.length + 1;
      while (String(length).length + value.length !== length) length = String(length).length + value.length;
      const record = Buffer.from(String(length) + value);
      bytes(tarHeader("PaxHeader", record.length, "x")); bytes(record);
      bytes(Buffer.alloc((512 - record.length % 512) % 512));
    }
    bytes(tarHeader(entry.name, large ? 0 : entry.size));
    append({ path: isAbsolute(entry.path) ? entry.path : join(dest, entry.path), size: entry.size });
    bytes(Buffer.alloc((512 - entry.size % 512) % 512));
  }
  bytes(Buffer.alloc(1024));
  if (!Number.isSafeInteger(size)) throw new Error("pacote excede o limite de tamanho suportado");
  return { segments, size };
}
async function* tarSlice(segments: Segment[], start: number, end: number) {
  for (const part of segments) {
    if (!part.size || part.start > end || part.start + part.size <= start) continue;
    const from = Math.max(0, start - part.start), to = Math.min(part.size - 1, end - part.start);
    if (part.data) yield part.data.subarray(from, to + 1);
    else yield* createReadStream(part.path!, { start: from, end: to });
  }
}

export async function servePackage(req: IncomingMessage, res: ServerResponse, dir: string, revision: string): Promise<void> {
  const dest = join(dir, "exports", revision);
  const { manifest, text } = await loadPackage(dest, { statOnly: true });
  await withResourceWork(dir, "package", Object.values(manifest.sources).map(sha256 => ({ sha256 })), async () => {
    // Download completion never releases this durable reference: it proves no preserved copy.
    await resourceLedgerForProject(dir).register({ id: packageOwnerId(dir, revision), kind: "package", projectDir: resolve(dir) }, Object.values(manifest.sources).map(mediaKey));
    const { segments, size } = tarSegments(dest, manifest.entries);
    const etag = `"${digest(text)}"`;
    const requested = req.headers.range && (!req.headers["if-range"] || req.headers["if-range"] === etag);
    const range = requested ? parseRange(req.headers.range, size) : null;
    const syntax = requested ? /^bytes=(\d*)-(\d*)$/.exec(req.headers.range!.trim()) : null;
    if (syntax && !range && ((syntax[1] && Number(syntax[1]) >= size) || (!syntax[1] && syntax[2] === "0"))) {
      res.writeHead(416, { "content-range": `bytes */${size}` }); res.end(); return;
    }
    const start = range?.start ?? 0, end = range?.end ?? size - 1;
    res.writeHead(range ? 206 : 200, {
      "content-type": "application/x-tar", "content-disposition": `attachment; filename="decupa-r${revision}.tar"`,
      "accept-ranges": "bytes", "content-length": end - start + 1, etag,
      ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
    });
    try { await pipeline(Readable.from(tarSlice(segments, start, end)), res); }
    catch (error) { if (!res.destroyed) throw error; }
  });
}
