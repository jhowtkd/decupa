import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { claimWorkDir } from "./session.ts";
import { listProjectRootEntries } from "./project-root.ts";

it("Limpeza só declara um plano salvo quando o artefato é legível", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-cleanup-plan-"));
  const dir = join(root, "limpeza");
  await mkdir(join(dir, "out"), { recursive: true });
  await writeFile(join(dir, "source.json"), JSON.stringify({ path: join(root, "aula.mp4"), displayName: "Edição da aula" }));
  try {
    const empty = await listProjectRootEntries(root);
    expect(empty[0]?.activity).toMatchObject({ busy: false, media: "aula.mp4", result: "Sem plano de limpeza salvo" });
    await writeFile(join(dir, "out", "condense_plan.json"), JSON.stringify({ clips: [{ start: 0, end: 1 }] }));
    expect((await listProjectRootEntries(root))[0]?.activity?.result).toBe("Plano de limpeza salvo");
    await writeFile(join(dir, "out", "condense_plan.json"), "{ parcial");
    const corrupted = (await listProjectRootEntries(root))[0]!;
    expect(corrupted.activity).toBeUndefined();
    expect(corrupted.problem).toContain("atividade");
  } finally { await rm(root, { recursive: true, force: true }); }
});


it("a consulta do Hub verifica mídia tocada sem regravar o manifesto editorial", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-cleanup-readonly-"));
  const dir = join(root, "limpeza");
  const input = join(root, "aula.mp4");
  await mkdir(dir);
  await writeFile(input, "mesmos bytes da mídia");
  await claimWorkDir(dir, input);
  await mkdir(join(dir, "out"));
  await writeFile(join(dir, "out", "condense_plan.json"), JSON.stringify({ clips: [{ start: 0, end: 1 }] }));
  const manifest = await readFile(join(dir, "source.json"), "utf8");
  const source = await stat(input);
  await utimes(input, new Date(source.atimeMs), new Date(source.mtimeMs + 10_000));
  try {
    const entries = await listProjectRootEntries(root);
    expect(entries[0]?.activity?.actions.export).toBe(true);
    expect(await readFile(join(dir, "source.json"), "utf8")).toBe(manifest);
  } finally { await rm(root, { recursive: true, force: true }); }
});
