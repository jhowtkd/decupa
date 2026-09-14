import { access, lstat, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { pruneProject } from "./retention.ts";

async function existe(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

async function fixture(opcoes: {
  revisoes: number[];
  atual: number;
  exportadas?: number[];
  historico?: number[];
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "assembly-retention-"));
  for (const n of opcoes.revisoes) {
    await mkdir(join(dir, `rev-${n}`), { recursive: true });
    await writeFile(join(dir, `rev-${n}`, "reference.mp4"), `previa-${n}`);
  }
  for (const n of opcoes.exportadas ?? []) {
    await mkdir(join(dir, "exports", String(n)), { recursive: true });
    await writeFile(join(dir, "exports", String(n), "manifest.json"), "{}");
  }
  for (const n of opcoes.historico ?? opcoes.revisoes) {
    await mkdir(join(dir, "history"), { recursive: true });
    await writeFile(join(dir, "history", `rev-${n}.json`), `{"revision":${n}}`);
  }
  await writeFile(
    join(dir, "project.json"),
    JSON.stringify({
      revision: opcoes.atual,
      previewRevision: null,
      finalApprovedRevision: null,
      previewArtifact: null,
    }),
  );
  return dir;
}

it("poda rev-N antigos mantendo K+exportadas", async () => {
  const dir = await fixture({ revisoes: [1, 2, 3, 4, 5], atual: 5, exportadas: [2] });
  const resultado = await pruneProject(dir, { revisions: 2 });
  expect(await existe(join(dir, "rev-5"))).toBe(true);
  expect(await existe(join(dir, "rev-4"))).toBe(true);
  expect(await existe(join(dir, "rev-2"))).toBe(true);
  expect(await existe(join(dir, "rev-1"))).toBe(false);
  expect(await existe(join(dir, "rev-3"))).toBe(false);
  expect(resultado.deleted).toContain("rev-1");
  expect(resultado.deleted).toContain("rev-3");
});

it("nunca deleta revisão atual nem entrega", async () => {
  const dir = await fixture({ revisoes: [1, 2, 5], atual: 5, exportadas: [2] });
  await pruneProject(dir, { revisions: 0 });
  expect(await existe(join(dir, "rev-5"))).toBe(true);
  expect(await existe(join(dir, "rev-2"))).toBe(true);
  expect(await existe(join(dir, "rev-1"))).toBe(false);
});

it("ignora nomes fora do padrão", async () => {
  const dir = await fixture({ revisoes: [1], atual: 5, historico: [] });
  await mkdir(join(dir, "rev-abc"), { recursive: true });
  await writeFile(join(dir, "rev-abc", "reference.mp4"), "estranha");
  await writeFile(join(dir, "reference.mp4"), "solta");
  await symlink(join(dir, "rev-abc"), join(dir, "rev-9"));
  const resultado = await pruneProject(dir, { revisions: 0 });
  expect(await existe(join(dir, "rev-1"))).toBe(false);
  expect(await existe(join(dir, "rev-abc", "reference.mp4"))).toBe(true);
  expect(await existe(join(dir, "reference.mp4"))).toBe(true);
  expect((await lstat(join(dir, "rev-9"))).isSymbolicLink()).toBe(true);
  expect(resultado.deleted).not.toContain("rev-abc");
  expect(resultado.deleted).not.toContain("reference.mp4");
  expect(resultado.deleted).not.toContain("rev-9");
});

it("history acompanha", async () => {
  const dir = await fixture({ revisoes: [1, 5], atual: 5, historico: [1, 5] });
  const resultado = await pruneProject(dir, { revisions: 1 });
  expect(await existe(join(dir, "history", "rev-1.json"))).toBe(false);
  expect(await existe(join(dir, "history", "rev-5.json"))).toBe(true);
  expect(await existe(join(dir, "rev-5"))).toBe(true);
  expect(resultado.deleted).toContain("history/rev-1.json");
});

it("recusa history simbólico sem remover arquivos externos", async () => {
  const dir = await fixture({ revisoes: [1], atual: 5, historico: [] });
  const outside = await mkdtemp(join(tmpdir(), "retention-outside-"));
  await writeFile(join(outside, "rev-1.json"), "{}");
  await symlink(outside, join(dir, "history"));
  await expect(pruneProject(dir, { revisions: 0 })).rejects.toThrow(/simbólico/);
  expect(await existe(join(outside, "rev-1.json"))).toBe(true);
  expect(await existe(join(dir, "rev-1"))).toBe(true);
});

it("recusa retenção inválida antes de podar", async () => {
  const dir = await fixture({ revisoes: [1], atual: 5 });
  await expect(pruneProject(dir, { revisions: NaN })).rejects.toThrow(/inteiro/);
  expect(await existe(join(dir, "rev-1"))).toBe(true);
});
