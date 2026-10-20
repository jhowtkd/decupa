import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { hashFile } from "@decupa/media";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import { referenceForAssembly } from "../../../../../tests/fixtures/timeline-reference.ts";
import { startApp } from "../server.ts";
import { resourceLedgerForProject, mediaKey } from "../resource-ledger.ts";
import { confirmImportVerification, exportApproved, readVerification } from "./export.ts";
import { buildOtio } from "./otio.ts";
import { blankProject, createAssemblyRuntime } from "./routes.ts";
import { fixtureAssembly } from "./fixture.ts";
import { createProject, loadProject, saveProject } from "./store.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup(options: { resolve?: "0" | "1"; exec?: import("../pipeline.ts").Executor } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "portable-package-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  let p = blankProject("p");
  p.assembly = fixtureAssembly(); p.revision = 1;
  for (const source of p.assembly.sources) {
    source.path = join(dir, source.name);
    await copyFile(join(FIXTURES, "clip.mp4"), source.path);
    source.sha256 = await hashFile(source.path);
  }
  await mkdir(join(dir, "rev-1"));
  const reference = join(dir, "rev-1", "reference.mp4");
  await copyFile(await referenceForAssembly(p.assembly), reference);
  p.previewRevision = 1; p.finalApprovedRevision = 1;
  p.previewArtifact = { revision: 1, relativePath: "rev-1/reference.mp4", sha256: await hashFile(reference), assemblySha256: createHash("sha256").update(JSON.stringify(p.assembly)).digest("hex") };
  await createProject(dir, p);
  const app = await startApp({ projectDir: dir, port: 0, env: { DECUPA_RESOLVE: options.resolve ?? "0" }, executor: options.exec });
  cleanups.push(app.close);
  p = await loadProject(dir);
  p.previewArtifact!.assemblySha256 = createHash("sha256").update(JSON.stringify(p.assembly)).digest("hex");
  await saveProject(dir, p.revision, p);
  return { dir, p, base: `http://127.0.0.1:${app.port}` };
}
function targets(doc: { tracks: { children: { children: { media_reference?: { target_url: string } }[] }[] } }) {
  return doc.tracks.children.flatMap(t => t.children.flatMap(c => c.media_reference ? [c.media_reference.target_url] : []));
}

it("package OTIO uses relative paths while local bridge keeps absolute media paths", () => {
  const assembly = fixtureAssembly();
  const portable = JSON.parse(buildOtio(assembly, { sourcePaths: { a: "sources/fala.mp4", b: "sources/apoio.mp4" } }));
  expect(targets(portable)).toEqual(["sources/fala.mp4", "sources/apoio.mp4", "sources/fala.mp4"]);
  expect(targets(JSON.parse(buildOtio(assembly))).every(isAbsolute)).toBe(true);
});

it("does not serve an unexported preview as an output download", async () => {
  const { base } = await setup();
  const response = await fetch(`${base}/project/output/1/mp4`);
  expect(response.status).toBe(404);
});

it("streams an extractable portable package including original-named sources and relative OTIO", async () => {
  const { base, dir, p } = await setup();
  const dest = await exportApproved(p, dir);
  const response = await fetch(`${base}/project/output/1/package`);
  expect(response.status).toBe(200);
  expect(response.headers.get("accept-ranges")).toBe("bytes");
  const archive = Buffer.from(await response.arrayBuffer());
  const archivePath = join(dir, "download.tar");
  await writeFile(archivePath, archive);
  const extracted = join(dir, "second-machine"); await mkdir(extracted);
  await promisify(execFile)("tar", ["-xf", archivePath, "-C", extracted]);
  const doc = JSON.parse(await readFile(join(extracted, "timeline.otio"), "utf8"));
  const urls = targets(doc);
  expect(urls.length).toBeGreaterThan(0);
  for (const url of urls) {
    expect(isAbsolute(url)).toBe(false);
    expect(url).toBe(basename(url));
    expect(resolve(extracted, url).startsWith(extracted + sep)).toBe(true);
    expect(await hashFile(resolve(extracted, url))).toBe(p.assembly.sources[0]!.sha256);
  }
  const files = await readdir(extracted);
  expect(files).toEqual(expect.arrayContaining(["1-fala.mp4", "2-apoio.mp4", "manifest.json", "reference.mp4", "importar-no-resolve.txt", "handoff.json"]));
  expect(await hashFile(join(extracted, "reference.mp4"))).toBe(p.previewArtifact!.sha256);
  expect((await readFile(join(extracted, "importar-no-resolve.txt"), "utf8"))).toMatch(/segunda máquina/);
  expect((await readdir(dest)).some(f => f.endsWith(".tar"))).toBe(false);
  const slice = await fetch(`${base}/project/output/1/package`, { headers: { range: "bytes=500-1600" } });
  expect(slice.status).toBe(206);
  expect(Buffer.from(await slice.arrayBuffer())).toEqual(archive.subarray(500, 1601));
  expect((await resourceLedgerForProject(dir).references(mediaKey(p.assembly.sources[0]!.sha256))).some(o => o.kind === "package")).toBe(true);
});

it("an installation without Resolve advertises portable delivery and refuses the bridge", async () => {
  const { base } = await setup();
  const status = await (await fetch(`${base}/project/resolve-status`)).json() as { capabilities: unknown };
  expect(status.capabilities).toEqual({ resolve: false, primary: "package" });
  const response = await fetch(`${base}/project/deliver-resolve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRevision: 1 }) });
  expect(response.status).toBe(409);
  expect((await response.json() as { error: string }).error).toMatch(/instalado/);
});


it("releases the HTTP bridge gate when this installation explicitly enables Resolve", async () => {
  const exec = { run: async (call: import("../pipeline.ts").ExecCall) => {
    const request = JSON.parse(await readFile(call.args.at(-1)!, "utf8"));
    return { code: 0, stdout: JSON.stringify({ ok: true, projectName: request.projectName, verified: true }), stderr: "" };
  } };
  const { base } = await setup({ resolve: "1", exec });
  const status = await (await fetch(`${base}/project/resolve-status`)).json() as { capabilities: unknown };
  expect(status.capabilities).toEqual({ resolve: true, primary: "resolve" });
  const response = await fetch(`${base}/project/deliver-resolve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRevision: 1 }) });
  expect(response.status, await response.clone().text()).toBe(200);
  expect((await response.json() as { delivery: { status: string } }).delivery.status).toBe("ready");
});

it("ignores malformed Range headers while rejecting an unsatisfiable byte range", async () => {
  const { dir, p, base } = await setup(); await exportApproved(p, dir);
  for (const range of ["nonsense", "bytes=a-b", "bytes=0-1,5-8"]) {
    const response = await fetch(`${base}/project/output/1/package`, { headers: { range } });
    expect(response.status).toBe(200); await response.arrayBuffer();
  }
  expect((await fetch(`${base}/project/output/1/package`, { headers: { range: "bytes=999999999999-" } })).status).toBe(416);
});

it("reports a registered package with a missing or changed source as needing reexport", async () => {
  const { dir, p, base } = await setup(); await exportApproved(p, dir);
  const path = p.assembly.sources[0]!.path;
  await writeFile(path, "changed");
  const changed = await fetch(`${base}/project/output/1/package`);
  expect(changed.status).toBe(409); expect((await changed.json() as { error: string }).error).toMatch(/exporte novamente/);
  await rm(path);
  const missing = await fetch(`${base}/project/output/1/package`);
  expect(missing.status).toBe(409); expect((await missing.json() as { error: string }).error).toMatch(/exporte novamente/);
});

it("reports a missing registered preview as 404", async () => {
  const { dir, base } = await setup(); await rm(join(dir, "rev-1", "reference.mp4"));
  expect((await fetch(`${base}/project/preview/1`)).status).toBe(404);
});


it("adding a package to an intact legacy export preserves its manual confirmation and lifecycle", async () => {
  const { dir, p } = await setup();
  const dest = await exportApproved(p, dir);
  await confirmImportVerification(p, dir);
  const previousVerification = await readFile(join(dest, "verificacao.json"), "utf8");
  const before = await loadProject(dir);
  await rm(join(dest, "package-manifest.json"));
  await rm(join(dest, "portable"), { recursive: true });
  await exportApproved(before, dir);
  expect(await readFile(join(dest, "verificacao.json"), "utf8")).toBe(previousVerification);
  expect((await loadProject(dir)).lifecycle).toEqual(before.lifecycle);
  expect(JSON.parse(await readFile(join(dest, "manifest.json"), "utf8")).verificacao).toBe("confirmada");
  const portable = JSON.parse(await readFile(join(dest, "portable", "manifest.json"), "utf8"));
  expect(portable.package.compatibility).toBe("pending-second-machine");
  expect(portable.verificacao).toBeUndefined();
});

it("team installations prioritize the package while keeping the installed bridge available", async () => {
  const { dir } = await setup();
  const runtime = createAssemblyRuntime(dir, { exec: { run: async () => ({ code: 0, stdout: "", stderr: "" }) }, port: () => 0,
    teamMode: true, deliveryCapabilities: async () => ({ resolve: true, primary: "resolve" }) });
  let json = "";
  try {
    await runtime.handle({ method: "GET", url: "/project/resolve-status", headers: {} } as never, { writeHead() {}, end(text: string) { json = text; } } as never);
    expect(JSON.parse(json).capabilities).toEqual({ resolve: true, primary: "package" });
  } finally { await runtime.close(); }
});


it("offers package regeneration when a registered package loses a required artifact", async () => {
  const { dir, p } = await setup();
  const dest = await exportApproved(p, dir);
  await rm(join(dest, "portable", "timeline.otio"));
  const verification = await readVerification(dir, p.revision);
  expect(verification?.package).toBe(false);
  expect(verification?.revision).toBe(1);
});
