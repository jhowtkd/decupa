import { link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { initializeResourceLedger, mediaKey, withResourceWork } from "./resource-ledger.ts";
import { planProjectCleanup, confirmProjectCleanup, reconcileProjectCleanups } from "./project-cleanup.ts";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "f4-t4-")); roots.push(root);
  const projectsRoot = join(root, "projects"); const dir = join(projectsRoot, "a");
  const now = 20 * 86_400_000; const sha = "a".repeat(64); const shared = "b".repeat(64);
  await mkdir(join(dir, "imports"), { recursive: true });
  const local = join(dir, "imports", sha); await writeFile(local, "original");
  await writeFile(join(dir, "imports", shared), "shared");
  await mkdir(join(dir, "media", sha), { recursive: true }); await writeFile(join(dir, "media", sha, "proxy.mp4"), "proxy");
  await mkdir(join(dir, ".decupa", "metrics"), { recursive: true }); await writeFile(join(dir, ".decupa", "metrics", "op.jsonl"), "journal");
  await mkdir(join(dir, "rev-1")); await writeFile(join(dir, "rev-1", "keep"), "rollback");
  const data = { revision: 1, finalApprovedRevision: 1, lifecycle: { state: "entregue", revision: 1, enteredAt: { entregue: now - 8 * 86_400_000 } }, assembly: { sources: [{ sha256: sha, path: local }, { sha256: shared, path: join(dir, "imports", shared) }] } };
  await writeFile(join(dir, "project.json"), JSON.stringify(data));
  await mkdir(join(projectsRoot, "b")); await writeFile(join(projectsRoot, "b", "project.json"), JSON.stringify({ assembly: { sources: [{ sha256: shared }] } }));
  await mkdir(join(dir, "exports", "1"), { recursive: true });
  await writeFile(join(dir, "exports", "1", "manifest.json"), JSON.stringify({ sources: { src: sha } }));
  const ledger = await initializeResourceLedger({ root, projectsRoot, now: () => now, env: {} });
  return { root, projectsRoot, dir, now, sha, shared, local, ledger, opts: { ledger, now: () => now, env: {} } };
}
it("A1/A2: prazo, plano sem remoção, confirmação, referências compartilhadas e rollbacks", async () => {
  const f = await fixture();
  const plan = await planProjectCleanup(f.dir, f.opts);
  expect(plan.eligible).toBe(true); expect(plan.expiresAt).toBe(f.now - 86_400_000);
  expect(plan.recoverableBytes).toBe(8 + 5 + 7); expect(plan.warning).toMatch(/offline/i);
  expect(await readFile(f.local, "utf8")).toBe("original");
  await expect(confirmProjectCleanup(f.dir, { planId: plan.planId, confirmed: false }, f.opts)).rejects.toThrow(/confirma/i);
  await confirmProjectCleanup(f.dir, { planId: plan.planId, confirmed: true, acknowledgeOffline: true }, f.opts);
  await expect(readFile(f.local)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(f.dir, "imports", f.shared), "utf8")).toBe("shared");
  expect(await f.ledger.references(mediaKey(f.shared))).toHaveLength(1);
  expect(await f.ledger.references(mediaKey(f.sha))).toHaveLength(0);
  expect(await readFile(join(f.dir, "rev-1", "keep"), "utf8")).toBe("rollback");
  await rm(join(f.root, ".decupa", "references.json"));
  const reboot = await initializeResourceLedger({ root: f.root, projectsRoot: f.projectsRoot });
  expect(await reboot.references(mediaKey(f.sha))).toHaveLength(0);
  expect(await reboot.references(mediaKey(f.shared))).toHaveLength(1);
});
it.each(["preparation", "render", "export"] as const)("A4: %s torna o plano inelegível", async kind => {
  const f = await fixture();
  await withResourceWork(f.dir, kind, [{ sha256: f.sha }], async () => expect((await planProjectCleanup(f.dir, f.opts)).eligible).toBe(false));
});
it("índice incompleto/pending falha fechado e não transforma token em erro comum", async () => {
  const f = await fixture();
  await writeFile(join(f.projectsRoot, "b", "project.json"), "{");
  await expect(planProjectCleanup(f.dir, f.opts)).rejects.toThrow(/incompleto/i);
  await writeFile(join(f.projectsRoot, "b", "project.json"), JSON.stringify({ assembly: { sources: [] } }));
  f.ledger.markPendingReconciliation();
  const original = f.ledger.reconcile; f.ledger.reconcile = async () => { throw new Error("reconciliação pendente"); };
  await expect(planProjectCleanup(f.dir, f.opts)).rejects.toThrow(/pendente/i);
  f.ledger.reconcile = original; f.ledger.cancelPendingReconciliation();
  await f.ledger.reconcile(); expect((await planProjectCleanup(f.dir, f.opts)).eligible).toBe(true);
});
it("acervo preservado e hardlinks só contam bytes quando o último link sai", async () => {
  const f = await fixture(); await mkdir(join(f.root, "pool")); await link(f.local, join(f.root, "pool", f.sha));
  const plan = await planProjectCleanup(f.dir, f.opts);
  expect(plan.recoverableBytes).toBe(12);
  expect(plan.preserved.some(item => /acervo/i.test(item.reason))).toBe(true);
  await confirmProjectCleanup(f.dir, { planId: plan.planId, confirmed: true, acknowledgeOffline: true }, f.opts);
  expect(await readFile(join(f.root, "pool", f.sha), "utf8")).toBe("original");
});
it("A3: falha de I/O durante remoção desfaz no boot e conserva referências", async () => {
  const f = await fixture(); const plan = await planProjectCleanup(f.dir, f.opts);
  const fs = await import("node:fs/promises"); const rename = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).rename;
  let calls = 0; vi.spyOn(fs, "rename").mockImplementation(async (...args) => { if (String(args[1]).includes("cleanup-trash") && ++calls === 2) throw new Error("I/O interrompido"); return rename(...args); });
  await expect(confirmProjectCleanup(f.dir, { planId: plan.planId, confirmed: true, acknowledgeOffline: true }, f.opts)).rejects.toThrow(/I\/O/);
  vi.mocked(fs.rename).mockImplementation(rename); await reconcileProjectCleanups(f.ledger);
  expect(await readFile(f.local, "utf8")).toBe("original");
  expect(await f.ledger.references(mediaKey(f.sha))).toHaveLength(2);
  expect(await readdir(join(f.dir, ".decupa", "metrics"))).toContain("op.jsonl");
});
it("um caminho de fonte que virou diretório não amplia a limpeza para outros arquivos", async () => {
  const f = await fixture();
  const raw = JSON.parse(await readFile(join(f.dir, "project.json"), "utf8"));
  raw.assembly.sources[0].path = join(f.dir, "imports", "pasta");
  await mkdir(join(f.dir, "imports", "pasta"));
  await writeFile(join(f.dir, "imports", "pasta", "outro-original.mp4"), "protegido");
  await writeFile(join(f.dir, "project.json"), JSON.stringify(raw));
  const plan = await planProjectCleanup(f.dir, f.opts);
  expect(plan.items.map(item => item.path)).not.toContain(join(f.dir, "imports", "pasta", "outro-original.mp4"));
});
it("não planeja nem confirma fora do escopo autorizado do ledger", async () => {
  const f = await fixture(); const other = await fixture();
  await expect(planProjectCleanup(other.dir, f.opts)).rejects.toThrow(/escopo/i);
  expect(await readFile(other.local, "utf8")).toBe("original");
});
it.each(["staging", "committed"] as const)("recovery %s descarta transação de Projeto apagado sem travar a raiz", async state => {
  const f = await fixture(); const { createHash } = await import("node:crypto");
  const dir = join(f.root, ".decupa", "cleanup-transactions"); await mkdir(dir, { recursive: true });
  const path = join(dir, `${createHash("sha256").update(f.dir).digest("hex")}.json`);
  await writeFile(path, JSON.stringify({ version: 1, id: "00000000-0000-4000-8000-000000000001", projectDir: f.dir, state, resources: [mediaKey(f.sha)], items: [] }));
  await rm(f.dir, { recursive: true });
  await reconcileProjectCleanups(f.ledger); await f.ledger.reconcile();
  expect(await readdir(dir)).toEqual([]);
  expect(await f.ledger.references(mediaKey(f.sha))).toEqual([]);
  expect(await f.ledger.references(mediaKey(f.shared))).toHaveLength(1);
});
