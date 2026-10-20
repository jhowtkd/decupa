import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, truncate, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import { referenceForAssembly } from "../../../../../tests/fixtures/timeline-reference.ts";
import { hashFile } from "@decupa/media";
import { startApp } from "../server.ts";
import { mediaKey, initializeResourceLedger } from "../resource-ledger.ts";
import { exportApproved, readVerification } from "./export.ts";
import { packageValid } from "./package.ts";
import { fixtureAssembly } from "./fixture.ts";
import { createProject } from "./store.ts";
import type { Project } from "./types.ts";

const roots: string[] = [];
const apps: { close(): Promise<void> }[] = [];
const fsState = vi.hoisted(() => ({ zeroCapacity: false }));
const mediaState = vi.hoisted(() => ({ rejectHashes: false, rejectedCalls: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    statfs: async (...args: Parameters<typeof actual.statfs>) => {
      const stats = await actual.statfs(...args);
      return fsState.zeroCapacity ? { ...stats, bavail: 0 } : stats;
    },
  };
});

vi.mock("@decupa/media", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@decupa/media")>();
  return {
    ...actual,
    hashFile: async (...args: Parameters<typeof actual.hashFile>) => {
      if (mediaState.rejectHashes) {
        mediaState.rejectedCalls += 1;
        throw new Error("hashFile inesperado durante download");
      }
      return actual.hashFile(...args);
    },
  };
});

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  }
});

type TarEntry = { name: string; bytes: Buffer; offset: number; dataOffset: number; end: number };

function expectSafeSourceBasename(name: string) {
  expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
  expect(name).not.toBe(".");
  expect(name).not.toBe("..");
}

function parseTar(tar: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const field = (start: number, end: number) => header.subarray(start, end).toString("utf8").replace(/\0.*$/s, "");
    const name = field(0, 100);
    const prefix = field(345, 500);
    const sizeText = field(124, 136).trim();
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    const dataOffset = offset + 512;
    const end = dataOffset + Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(size) || size < 0 || end > tar.length) throw new Error(`TAR inválido em ${name}`);
    entries.push({
      name: prefix ? `${prefix}/${name}` : name,
      bytes: tar.subarray(dataOffset, dataOffset + size),
      offset,
      dataOffset,
      end,
    });
    offset = end;
  }
  return entries;
}

async function approvedProject(options: {
  revision?: number;
  names?: [string, string];
  unsafeName?: string;
  largeSourceBytes?: number;
  opaqueSourcePaths?: boolean;
  projectDir?: string;
  startServer?: boolean;
} = {}) {
  const dir = options.projectDir ?? await mkdtemp(join(tmpdir(), "assembly-package-additional-"));
  if (options.projectDir) await mkdir(dir, { recursive: true });
  else roots.push(dir);
  const revision = options.revision ?? 42;
  const suffix = options.opaqueSourcePaths ? "-opaque-pool-key" : ".mp4";
  const paths = [
    join(dir, options.unsafeName ?? `disk-a${suffix}`),
    join(dir, `disk-b${suffix}`),
    join(dir, `unused${suffix}`),
  ];
  for (const path of paths) await copyFile(join(FIXTURES, "clip.mp4"), path);
  if (options.largeSourceBytes) {
    await truncate(paths[0]!, (await stat(paths[0]!)).size + options.largeSourceBytes);
  }

  const assembly = fixtureAssembly();
  assembly.revision = revision;
  for (let index = 0; index < assembly.sources.length; index += 1) {
    const source = assembly.sources[index]!;
    source.path = paths[index]!;
    source.name = options.names?.[index] ?? source.name;
    if (index === 0 && options.unsafeName) source.name = options.unsafeName;
    source.sha256 = await hashFile(source.path);
  }
  const unused = {
    ...assembly.sources[1]!,
    id: "unused-source",
    path: paths[2]!,
    name: "unused.mp4",
    sha256: await hashFile(paths[2]!),
  };
  assembly.sources.push(unused);

  const project: Project = {
    version: 2,
    id: "portable-package-fixture",
    revision,
    input: { kind: "brief", text: "fixture pacote portátil", targetSeconds: 2 },
    assembly,
    scenes: [],
    analyses: [],
    proposal: null,
    previewRevision: revision,
    finalApprovedRevision: revision,
    corrections: [],
    preparation: null,
    permissions: { model: false, visual: false },
    previewArtifact: null,
  };

  await mkdir(join(dir, `rev-${revision}`), { recursive: true });
  const reference = join(dir, `rev-${revision}`, "reference.mp4");
  await copyFile(await referenceForAssembly(assembly), reference);
  project.previewArtifact = {
    revision,
    assemblySha256: createHash("sha256").update(JSON.stringify(assembly)).digest("hex"),
    relativePath: relative(dir, reference),
    sha256: await hashFile(reference),
  };
  await createProject(dir, project);
  if (options.startServer === false) return { dir, project, base: "" };
  const app = await startApp({ projectDir: dir, port: 0 });
  apps.push(app);
  return { dir, project, base: `http://127.0.0.1:${app.port}` };
}

async function generatedPackage(options?: Parameters<typeof approvedProject>[0]) {
  const fixture = await approvedProject(options);
  const exportDir = await exportApproved(fixture.project, fixture.dir);
  const response = await fetch(`${fixture.base}/project/output/${fixture.project.revision}/package`);
  return { ...fixture, exportDir, response };
}

it("retoma o download do TAR por Range e recompõe bytes idênticos, inclusive em limites de entrada", async () => {
  const { base, project, response } = await generatedPackage();
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/x-tar");
  const full = Buffer.from(await response.arrayBuffer());
  const entries = parseTar(full);
  expect(entries.map(entry => entry.name)).toEqual(expect.arrayContaining([
    "timeline.otio", "manifest.json", "importar-no-resolve.txt",
  ]));
  expect(entries.some(entry => entry.name === "1-fala.mp4")).toBe(true);

  // A primeira fatia termina no meio de um cabeçalho. A segunda cruza a
  // fronteira entre cabeçalho e conteúdo do primeiro arquivo.
  const cut = 173;
  const first = await fetch(`${base}/project/output/${project.revision}/package`, {
    headers: { range: `bytes=0-${cut - 1}` },
  });
  expect(first.status).toBe(206);
  const resumed = await fetch(`${base}/project/output/${project.revision}/package`, {
    headers: { range: `bytes=${cut}-${full.length - 1}` },
  });
  expect(resumed.status).toBe(206);
  expect(resumed.headers.get("content-range")).toBe(`bytes ${cut}-${full.length - 1}/${full.length}`);
  expect(resumed.headers.get("etag")).toBe(response.headers.get("etag"));
  const stitched = Buffer.concat([Buffer.from(await first.arrayBuffer()), Buffer.from(await resumed.arrayBuffer())]);
  expect(stitched.equals(full)).toBe(true);

  const file = entries.find(entry => entry.bytes.length > 0)!;
  const crossing = await fetch(`${base}/project/output/${project.revision}/package`, {
    headers: { range: `bytes=${file.offset + 480}-${file.dataOffset + 63}` },
  });
  expect(crossing.status).toBe(206);
  expect(Buffer.from(await crossing.arrayBuffer())).toEqual(full.subarray(file.offset + 480, file.dataOffset + 64));
  const nextBoundary = await fetch(`${base}/project/output/${project.revision}/package`, {
    headers: { range: `bytes=${file.end - 64}-${file.end + 63}` },
  });
  expect(nextBoundary.status).toBe(206);
  expect(Buffer.from(await nextBoundary.arrayBuffer())).toEqual(full.subarray(file.end - 64, file.end + 64));
  const invalid = await fetch(`${base}/project/output/${project.revision}/package`, {
    headers: { range: `bytes=${full.length}-` },
  });
  expect(invalid.status).toBe(416);
});

it("usa caminhos relativos no TAR, mantém o OTIO local absoluto e omite fontes sem clipe", async () => {
  const { project, exportDir, response } = await generatedPackage();
  const localTimeline = JSON.parse(await readFile(join(exportDir, "timeline.otio"), "utf8"));
  const localUrl = localTimeline.tracks.children[0].children[0].media_reference.target_url as string;
  expect(localUrl.startsWith("/")).toBe(true);

  const tar = Buffer.from(await response.arrayBuffer());
  const entries = parseTar(tar);
  const names = entries.map(entry => entry.name);
  const manifest = JSON.parse(entries.find(entry => entry.name === "manifest.json")!.bytes.toString("utf8"));
  expect(manifest.sources).not.toHaveProperty("unused-source");
  expect(names).toContain("manifest.json");
  const portableTimeline = JSON.parse(entries.find(entry => entry.name === "timeline.otio")!.bytes.toString("utf8"));
  const sourcePaths: string[] = [];
  for (const track of portableTimeline.tracks.children) {
    for (const child of track.children) {
      const target = child.media_reference?.target_url;
      if (target) {
        expect(target.startsWith("/")).toBe(false);
        expect(target.split("/")).toHaveLength(1);
        expectSafeSourceBasename(target);
        sourcePaths.push(target);
      }
    }
  }
  expect(new Set(sourcePaths).size).toBe(2);
  for (const target of sourcePaths) expect(names).toContain(target);
  expect(project.assembly.sources.find(source => source.id === "unused-source")?.sha256).toBeTruthy();
});

it("desambigua colisões case insensitive e mantém nomes de fonte seguros", async () => {
  const { project, response } = await generatedPackage({
    revision: 43,
    names: ["Take.mp4", "take.MP4"],
  });
  const entries = parseTar(Buffer.from(await response.arrayBuffer()));
  const timeline = JSON.parse(entries.find(entry => entry.name === "timeline.otio")!.bytes.toString("utf8"));
  const sourceNames: string[] = [...new Set<string>(timeline.tracks.children.flatMap((track: { children: { media_reference?: { target_url?: string } }[] }) =>
    track.children.flatMap(child => child.media_reference?.target_url ? [child.media_reference.target_url] : [])))];
  expect(sourceNames).toHaveLength(2);
  expect(new Set(sourceNames.map(name => name.toLocaleLowerCase("en-US"))).size).toBe(2);
  for (const name of sourceNames) {
    expect(name.split("/")).toHaveLength(1);
    expectSafeSourceBasename(name);
    expect(entries.map(entry => entry.name)).toContain(name);
  }
  expect(project.assembly.sources.filter(source => source.id === "a" || source.id === "b")).toHaveLength(2);
});

it("sanitiza separadores hostis no nome da fonte antes de gravar o caminho TAR", async () => {
  const { response } = await generatedPackage({
    revision: 45,
    unsafeName: "..\\..\\outside.mp4",
  });
  const entries = parseTar(Buffer.from(await response.arrayBuffer()));
  const timeline = JSON.parse(entries.find(entry => entry.name === "timeline.otio")!.bytes.toString("utf8"));
  const sourceNames: string[] = [...new Set<string>(timeline.tracks.children.flatMap((track: { children: { media_reference?: { target_url?: string } }[] }) =>
    track.children.flatMap(child => child.media_reference?.target_url ? [child.media_reference.target_url] : [])))];
  expect(sourceNames).toHaveLength(2);
  expect(sourceNames.some(name => name.includes("outside"))).toBe(true);
  for (const name of sourceNames) {
    expect(name.split("/")).toHaveLength(1);
    expectSafeSourceBasename(name);
  }
});

it("preserva extensão e remove diacríticos de nomes longos sem criar underscores espúrios", async () => {
  const names: [string, string] = [
    "Gravação de tela 2026-10-20 às 14.32.11 – Reunião com cliente final v3.mp4",
    "Outra gravação longa da reunião de planejamento estratégico 2026-10-20 às 14.32.11 final.MOV",
  ];
  const { response } = await generatedPackage({ revision: 49, names });
  const entries = parseTar(Buffer.from(await response.arrayBuffer()));
  const timeline = JSON.parse(entries.find(entry => entry.name === "timeline.otio")!.bytes.toString("utf8"));
  const pathsBySourceId = new Map<string, string>();
  for (const track of timeline.tracks.children) {
    for (const child of track.children) {
      const reference = child.media_reference;
      const sourceId = reference?.metadata?.decupa?.sourceId;
      if (sourceId) pathsBySourceId.set(sourceId, reference.target_url as string);
    }
  }
  const firstPath = pathsBySourceId.get("a")!;
  const secondPath = pathsBySourceId.get("b")!;
  expect(firstPath.split("/")).toHaveLength(1);
  expect(secondPath.split("/")).toHaveLength(1);
  const firstName = firstPath.split("/").at(-1)!;
  const secondName = secondPath.split("/").at(-1)!;
  expect(firstName.endsWith(".mp4")).toBe(true);
  expect(firstName).toContain("Gravacao");
  expect(firstName).not.toContain("Gravac_o");
  expect(firstName).toContain("Reuniao");
  expect(firstName).not.toContain("Reunia_o");
  expect(secondName.endsWith(".MOV")).toBe(true);
  expect(secondName).toContain("reuniao");
  expect(secondName).not.toContain("reunia_o");
  expect(entries.map(entry => entry.name)).toContain(firstPath);
  expect(entries.map(entry => entry.name)).toContain(secondPath);
});

it("infere .mp4 do contêiner para nomes Drive sem extensão e conserva timestamps pontuados", async () => {
  const cases = [
    {
      sourceName: "Reunião 14.32.11 - parte 2 de 3 (cópia final aprovada pelo cliente)",
      fragments: ["Reuniao", "14.32.11", "parte_2_de_3"],
    },
    {
      sourceName: "Gravação 20.10.2026 entrevista com a diretora comercial",
      fragments: ["Gravacao", "20.10.2026", "diretora_comercial"],
    },
    {
      sourceName: "WhatsApp 20.10.2026 14.32.11",
      fragments: ["WhatsApp", "14.32.11"],
    },
    {
      sourceName: "Entrevista Dr.Silva",
      fragments: ["Entrevista", "Dr.Silva"],
    },
    {
      sourceName: "Aula 1.parte2",
      fragments: ["Aula_1", "1.parte2"],
    },
    {
      sourceName: "Cena 3.final",
      fragments: ["Cena_3", "3.final"],
    },
  ];

  for (const [index, testCase] of cases.entries()) {
    const { response } = await generatedPackage({
      revision: 51 + index,
      names: [testCase.sourceName, "second opaque source"],
      opaqueSourcePaths: true,
    });
    const entries = parseTar(Buffer.from(await response.arrayBuffer()));
    const timeline = JSON.parse(entries.find(entry => entry.name === "timeline.otio")!.bytes.toString("utf8"));
    let target = "";
    for (const track of timeline.tracks.children) {
      for (const child of track.children) {
        if (child.media_reference?.metadata?.decupa?.sourceId === "a") {
          target = child.media_reference.target_url as string;
        }
      }
    }
    expect(target.split("/")).toHaveLength(1);
    expect(target.endsWith(".mp4")).toBe(true);
    for (const fragment of testCase.fragments) expect(target).toContain(fragment);
    expect(entries.map(entry => entry.name)).toContain(target);
  }
});

it("adiia hash na leitura após troca de inode idêntica e repara package na preparação", async () => {
  const { dir, project, base } = await approvedProject({ revision: 54 });
  const exportDir = await exportApproved(project, dir);
  const timelinePath = join(exportDir, "portable", "timeline.otio");
  const originalBytes = await readFile(timelinePath);
  const before = await stat(timelinePath);
  const replacement = join(exportDir, "portable", "timeline-copy.tmp");
  await writeFile(replacement, originalBytes);
  await rename(replacement, timelinePath);
  const after = await stat(timelinePath);
  expect(after.dev !== before.dev || after.ino !== before.ino).toBe(true);

  mediaState.rejectHashes = true;
  mediaState.rejectedCalls = 0;
  try {
    expect((await readVerification(dir, project.revision))?.package).toBe(false);
    expect(mediaState.rejectedCalls).toBe(0);
  } finally {
    mediaState.rejectHashes = false;
  }

  await exportApproved(project, dir);
  expect(await packageValid(exportDir)).toBe(true);
  expect((await readVerification(dir, project.revision))?.package).toBe(true);
  const url = `${base}/project/output/${project.revision}/package`;
  const complete = await fetch(url);
  expect(complete.status).toBe(200);
  const full = Buffer.from(await complete.arrayBuffer());
  const range = await fetch(url, { headers: { range: "bytes=128-639" } });
  expect(range.status).toBe(206);
  expect(Buffer.from(await range.arrayBuffer())).toEqual(full.subarray(128, 640));

  await unlink(timelinePath);
  expect((await readVerification(dir, project.revision))?.package).toBe(false);
  await writeFile(timelinePath, Buffer.concat([originalBytes, Buffer.from("bytes alterados")]));
  expect(await packageValid(exportDir)).toBe(false);
  expect((await readVerification(dir, project.revision))?.package).toBe(false);
});

it("reporta package=false se um arquivo portable estiver ausente embora o sidecar exista", async () => {
  const { dir, project } = await approvedProject({ revision: 55 });
  const exportDir = await exportApproved(project, dir);
  await unlink(join(exportDir, "portable", "timeline.otio"));
  expect((await stat(join(exportDir, "package-manifest.json"))).isFile()).toBe(true);
  expect((await readVerification(dir, project.revision))?.package).toBe(false);
});

it("reporta package=false se os bytes portable mudarem embora o sidecar exista", async () => {
  const { dir, project } = await approvedProject({ revision: 56 });
  const exportDir = await exportApproved(project, dir);
  const timelinePath = join(exportDir, "portable", "timeline.otio");
  await writeFile(timelinePath, Buffer.concat([await readFile(timelinePath), Buffer.from("bytes alterados")]));
  expect((await stat(join(exportDir, "package-manifest.json"))).isFile()).toBe(true);
  expect((await readVerification(dir, project.revision))?.package).toBe(false);
});

it("retoma após cancelamento real do socket e recompõe exatamente o TAR íntegro", async () => {
  const { base, project } = await generatedPackage({ revision: 46, largeSourceBytes: 8 * 1024 * 1024 });
  const url = `${base}/project/output/${project.revision}/package`;
  const complete = await fetch(url);
  expect(complete.status).toBe(200);
  const full = Buffer.from(await complete.arrayBuffer());

  const controller = new AbortController();
  const interrupted = await fetch(url, { signal: controller.signal });
  expect(interrupted.status).toBe(200);
  const reader = interrupted.body!.getReader();
  const first = await reader.read();
  expect(first.done).toBe(false);
  expect(first.value!.byteLength).toBeGreaterThan(0);
  const received = Buffer.from(first.value!);
  controller.abort();
  await reader.cancel().catch(() => undefined);
  expect(received.length).toBeLessThan(full.length);

  const resumed = await fetch(url, { headers: { range: `bytes=${received.length}-` } });
  expect(resumed.status).toBe(206);
  const reconstructed = Buffer.concat([received, Buffer.from(await resumed.arrayBuffer())]);
  expect(reconstructed.equals(full)).toBe(true);
});

it("serve Range sem chamar hashFile completo durante o download", async () => {
  const { base, project } = await generatedPackage({ revision: 48 });
  const url = `${base}/project/output/${project.revision}/package`;
  const complete = await fetch(url);
  expect(complete.status).toBe(200);
  const full = Buffer.from(await complete.arrayBuffer());
  const start = 173;
  const end = Math.min(full.length - 1, 1537);
  mediaState.rejectHashes = true;
  mediaState.rejectedCalls = 0;
  try {
    const range = await fetch(url, { headers: { range: `bytes=${start}-${end}` } });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe(`bytes ${start}-${end}/${full.length}`);
    expect(Buffer.from(await range.arrayBuffer())).toEqual(full.subarray(start, end + 1));
    expect(mediaState.rejectedCalls).toBe(0);
  } finally {
    mediaState.rejectHashes = false;
  }
});

it("serve pacote com capacidade livre zero sem reservar espaço nem materializar TAR", async () => {
  const { base, dir, project } = await approvedProject({ revision: 47 });
  await exportApproved(project, dir);
  const reservationDir = join(dir, ".reservations");
  const reservationsBefore = await readdir(reservationDir).catch(() => [] as string[]);
  const tarFilesBefore = (await readdir(join(dir, "exports", String(project.revision))))
    .filter(name => name.endsWith(".tar"));
  expect(tarFilesBefore).toEqual([]);

  fsState.zeroCapacity = true;
  let response: Response;
  try {
    response = await fetch(`${base}/project/output/${project.revision}/package`);
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
  } finally {
    fsState.zeroCapacity = false;
  }

  const reservationsAfter = await readdir(reservationDir).catch(() => [] as string[]);
  expect(reservationsAfter).toEqual(reservationsBefore);
  expect((await readdir(join(dir, "exports", String(project.revision))))
    .filter(name => name.endsWith(".tar"))).toEqual([]);
});

it("registra fontes do pacote no ledger e reconstrói as referências após reconcile e perda do índice", async () => {
  const { dir, project } = await generatedPackage({ revision: 44 });
  const sha = project.assembly.sources.find(source => source.id === "a")!.sha256;
  const first = await initializeResourceLedger({ root: dir, projectDir: dir });
  expect(await first.references(mediaKey(sha))).toContainEqual(expect.objectContaining({
    id: `package:${dir}:44`, kind: "package", projectDir: dir,
  }));
  await first.reconcile();
  await rm(join(dir, ".decupa", "references.json"), { force: true });
  const recovered = await initializeResourceLedger({ root: dir, projectDir: dir });
  expect(await recovered.references(mediaKey(sha))).toContainEqual(expect.objectContaining({
    id: `package:${dir}:44`, kind: "package", projectDir: dir,
  }));
});

it("remove owner package ao excluir projeto sob projectsRoot e reconciliar ledger compartilhado", async () => {
  const root = await mkdtemp(join(tmpdir(), "package-shared-ledger-"));
  roots.push(root);
  const projectsRoot = join(root, "projects");
  const projectDir = join(projectsRoot, "project-1");
  const durableRoot = join(root, "durable-media-ledger");
  await mkdir(projectsRoot, { recursive: true });
  await mkdir(durableRoot, { recursive: true });
  const { project } = await approvedProject({ revision: 50, projectDir, startServer: false });
  const ledger = await initializeResourceLedger({ root: durableRoot, projectsRoot });

  await exportApproved(project, projectDir);
  const sha = project.assembly.sources.find(source => source.id === "a")!.sha256;
  expect(await ledger.references(mediaKey(sha))).toContainEqual(expect.objectContaining({
    id: `package:${projectDir}:50`, kind: "package", projectDir,
  }));

  await rm(projectDir, { recursive: true, force: true });
  await ledger.reconcile();
  expect(await ledger.references(mediaKey(sha))).toEqual([]);
});
