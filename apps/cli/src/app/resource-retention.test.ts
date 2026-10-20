import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "decupa-ledger-")); dirs.push(root);
  const projectsRoot = join(root, "projects"); await mkdir(projectsRoot);
  const sha = "a".repeat(64); const media = join(root, "pool", sha); await mkdir(join(root, "pool")); await writeFile(media, "original");
  for (const id of ["a", "b"]) {
    const dir = join(projectsRoot, id); await mkdir(dir);
    await writeFile(join(dir, "project.json"), JSON.stringify({ assembly: { sources: [{ sha256: sha, path: media, included: id === "a" }] } }));
  }
  return { root, projectsRoot, sha, media };
}
it("A1: dois projetos, inclusive fonte excluída, contam duas referências; liberar não apaga", async () => {
  const { initializeResourceLedger, mediaKey } = await import("./resource-ledger.ts");
  const { root, projectsRoot, sha, media } = await setup();
  const ledger = await initializeResourceLedger({ root, projectsRoot });
  const refs = await ledger.references(mediaKey(sha)); expect(refs).toHaveLength(2);
  await ledger.release(refs[0]!.id); expect(await ledger.references(mediaKey(sha))).toHaveLength(1);
  expect(await readFile(media, "utf8")).toBe("original");
});
it("A2: apagar o índice e reiniciar reconstrói as contagens dos manifestos reais", async () => {
  const { initializeResourceLedger, mediaKey } = await import("./resource-ledger.ts");
  const { root, projectsRoot, sha } = await setup();
  await initializeResourceLedger({ root, projectsRoot });
  await rm(join(root, ".decupa", "references.json"));
  const reboot = await initializeResourceLedger({ root, projectsRoot });
  expect(await reboot.references(mediaKey(sha))).toHaveLength(2);
});
it("A3: legado ativo/entregue e elegível exatamente sete dias depois", async () => {
  const { deriveLifecycle, PROJECT_RETENTION_MS } = await import("./project-lifecycle.ts");
  const { projectsRoot } = await setup(); const dir = join(projectsRoot, "a"); let now = Date.now();
  expect((await deriveLifecycle(dir, undefined, { now: () => now })).state).toBe("ativo");
  await mkdir(join(dir, "exports", "1"), { recursive: true });
  await writeFile(join(dir, "exports", "1", "verificacao.json"), JSON.stringify({ status: "confirmada", checkedAt: now }));
  const delivered = await deriveLifecycle(dir, undefined, { now: () => now }); expect(delivered.state).toBe("entregue");
  now = delivered.enteredAt.entregue! + PROJECT_RETENTION_MS;
  expect((await deriveLifecycle(dir, delivered, { now: () => now })).state).toBe("elegível");
});
it("A4: a mesma reserva considera upload e exportação no volume", async () => {
  const { createSpaceManager } = await import("./space.ts");
  const { root } = await setup(); const manager = createSpaceManager(root);
  await mkdir(join(root, ".tmp", "00000000-0000-0000-0000-000000000001"), { recursive: true });
  await writeFile(join(root, ".tmp", "00000000-0000-0000-0000-000000000001", "state.json"), JSON.stringify({ tamanhoTotal: 100, reserva: true }));
  const entries = await manager.obligations(); expect(entries.reduce((n, e) => n + e.bytes, 0)).toBe(200);
  const release = await manager.reserve("export-test", [{ path: root, bytes: 10 }]);
  expect((await manager.obligations()).reduce((n, e) => n + e.bytes, 0)).toBe(210); await release();
  expect((await manager.obligations()).reduce((n, e) => n + e.bytes, 0)).toBe(200);
});
it.each(["preparation", "render", "export"] as const)("A5: %s protege mídia e suspende elegibilidade até concluir", async kind => {
  const { initializeResourceLedger, withResourceWork, mediaKey } = await import("./resource-ledger.ts");
  const { deriveLifecycle, PROJECT_RETENTION_MS } = await import("./project-lifecycle.ts");
  const { root, projectsRoot, sha } = await setup(); const dir = join(projectsRoot, "a");
  const ledger = await initializeResourceLedger({ root, projectsRoot });
  const lifecycle = { state: "entregue" as const, enteredAt: { entregue: Date.now() - PROJECT_RETENTION_MS - 1 } };
  await withResourceWork(dir, kind, [{ sha256: sha }], async () => {
    expect((await ledger.references(mediaKey(sha))).filter(r => r.kind === "in-progress")).toHaveLength(1);
    expect((await deriveLifecycle(dir, lifecycle)).state).toBe("entregue");
  });
  expect((await deriveLifecycle(dir, lifecycle)).state).toBe("elegível");
});
