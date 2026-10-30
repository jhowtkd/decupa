import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { blankProject } from "./assembly/routes.ts";
import { fixtureAssembly } from "./assembly/fixture.ts";
import { createProject, loadProject, saveProject } from "./assembly/store.ts";
import { initializeResourceLedger, mediaKey, ResourceLedger, withResourceWork } from "./resource-ledger.ts";
import { confirmProjectCleanup, planProjectCleanup } from "./project-cleanup.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "f4-t4-source-boundary-"))); roots.push(root);
  const a = join(root, "a"); const b = join(root, "b"); const now = 100 * 86_400_000;
  for (const dir of [a, b]) await mkdir(join(dir, "imports"), { recursive: true });
  const path = join(a, "imports", "original.mp4"); await writeFile(path, "original source");
  const source = { ...fixtureAssembly().sources[0]!, path };
  const project = blankProject("a"); project.revision = 1; project.finalApprovedRevision = 1;
  project.assembly = { ...project.assembly, revision: 1, sources: [source] };
  project.lifecycle = { state: "entregue", revision: 1, enteredAt: { entregue: now - 8 * 86_400_000 } };
  const ledgerA = await initializeResourceLedger({ root: a, projectDir: a, now: () => now, env: {} });
  await createProject(a, project);
  const ledgerB = await initializeResourceLedger({ root: b, projectDir: b, now: () => now, env: {} });
  await createProject(b, blankProject("b"));
  return { root, a, b, path, source, ledgerA, ledgerB, opts: { ledger: ledgerA, now: () => now, env: {} } };
}
it("A8: nova fonte de outro ledger vira hardlink local e sobrevive à limpeza do Projeto de origem", async () => {
  const f = await setup();
  await saveProject(f.b, 0, project => ({ ...project, revision: 1, assembly: { ...project.assembly, revision: 1, sources: [f.source] } }));
  const published = await loadProject(f.b); const local = published.assembly.sources[0]!.path;
  expect(local).toMatch(new RegExp(`^${f.b}/imports/`));
  expect((await stat(local)).ino).toBe((await stat(f.path)).ino);
  expect(await f.ledgerA.references(mediaKey(f.source.sha256))).toHaveLength(1);
  expect(await f.ledgerB.references(mediaKey(f.source.sha256))).toHaveLength(1);
  const plan = await planProjectCleanup(f.a, f.opts);
  await confirmProjectCleanup(f.a, { planId: plan.planId, confirmed: true, acknowledgeOffline: true }, f.opts);
  await expect(readFile(f.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(local, "utf8")).toBe("original source");
  await expect(withResourceWork(f.b, "render", [f.source], async () => readFile(local, "utf8"))).resolves.toBe("original source");
});
it("A7: original solto na raiz pertence à pessoa e permanece depois da confirmação", async () => {
  const f = await setup(); const loose = join(f.a, "bruto.mp4"); await writeFile(loose, "arquivo da pessoa");
  const data = JSON.parse(await readFile(join(f.a, "project.json"), "utf8")); data.assembly.sources[0].path = loose;
  await writeFile(join(f.a, "project.json"), JSON.stringify(data));
  const plan = await planProjectCleanup(f.a, f.opts);
  expect(plan.items.map(item => item.path)).not.toContain(loose);
  expect(plan.preserved).toContainEqual(expect.objectContaining({ path: loose }));
  await confirmProjectCleanup(f.a, { planId: plan.planId, confirmed: true, acknowledgeOffline: true }, f.opts);
  expect(await readFile(loose, "utf8")).toBe("arquivo da pessoa");
});
it("A8: render em ledger local protege o mesmo Projeto servido por ledger do Hub", async () => {
  const f = await setup(); const hubLedger = await initializeResourceLedger({ root: f.root, projectsRoot: f.root, now: f.opts.now, env: {} });
  const local = new ResourceLedger(f.a);
  const id = "in-progress:render:other-process";
  await local.register({ id, kind: "in-progress", projectDir: f.a, pid: process.pid }, [mediaKey(f.source.sha256)]);
  try {
    expect((await planProjectCleanup(f.a, { ...f.opts, ledger: hubLedger })).eligible).toBe(false);
  } finally { await local.release(id); }
  expect((await planProjectCleanup(f.a, { ...f.opts, ledger: hubLedger })).eligible).toBe(true);
});
it("A8: fonte já removida em outro Projeto não publica um caminho pendurado", async () => {
  const f = await setup(); await rm(f.path);
  await expect(saveProject(f.b, 0, project => ({ ...project, revision: 1, assembly: { ...project.assembly, revision: 1, sources: [f.source] } }))).rejects.toThrow(/fonte.*indisponível/i);
  expect((await loadProject(f.b)).assembly.sources).toHaveLength(0);
});
