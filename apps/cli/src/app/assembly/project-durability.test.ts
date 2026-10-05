import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { applyEdit } from "./revisions.ts";
import { blankProject } from "./routes.ts";
import { createProject, loadProject, mergeProjectCommit, saveProject } from "./store.ts";
import type { Project } from "./types.ts";

function projectAt(revision: number, text: string): Project {
  const project = blankProject("p");
  project.revision = revision;
  project.input = { kind: "brief", text, targetSeconds: 60 };
  return project;
}

function withCorrection(project: Project): Project {
  project.assembly.sources = [{
    id: "s1",
    path: "/tmp/x.mp4",
    sha256: "a".repeat(64),
    durationSeconds: 10,
    hasVideo: true,
    hasAudio: true,
    fps: { num: 30, den: 1 },
    width: 320,
    height: 240,
    role: "speech",
    included: true,
    name: "x.mp4",
  }];
  project.corrections = [{
    id: "c1", sourceId: "s1", start: 1, end: 2, text: "velho", status: "aligned", words: [],
  }];
  return project;
}

it("saveProject deixa project.prev.json com a versão anterior", async () => {
  const dir = await mkdtemp(join(tmpdir(), "project-prev-"));
  const before = projectAt(1, "antes");
  await createProject(dir, before);
  await saveProject(dir, 1, projectAt(2, "depois"));
  const prev = JSON.parse(await readFile(join(dir, "project.prev.json"), "utf8")) as { revision: number; input: { text: string } };
  expect(prev.revision).toBe(1);
  expect(prev.input.text).toBe("antes");
  expect((await loadProject(dir)).input.text).toBe("depois");
});

it("project.json truncado cai na cópia e avisa uma vez", async () => {
  const dir = await mkdtemp(join(tmpdir(), "project-trunc-"));
  await createProject(dir, projectAt(1, "antes"));
  await saveProject(dir, 1, projectAt(2, "depois"));
  await writeFile(join(dir, "project.json"), "");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    expect((await loadProject(dir)).input.text).toBe("antes");
    expect((await loadProject(dir)).revision).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/project\.prev\.json/);
  } finally {
    warn.mockRestore();
  }
});

it("project.json ausente continua ENOENT", async () => {
  const dir = await mkdtemp(join(tmpdir(), "project-missing-"));
  try {
    await loadProject(dir);
    expect.fail("loadProject deveria falhar");
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
  }
});

it("JSON válido que não passa na validação continua erro", async () => {
  const dir = await mkdtemp(join(tmpdir(), "project-invalid-"));
  await createProject(dir, projectAt(1, "antes"));
  await saveProject(dir, 1, projectAt(2, "depois"));
  await writeFile(join(dir, "project.json"), `${JSON.stringify({ version: 2, id: "p", revision: "não" })}\n`);
  await expect(loadProject(dir)).rejects.toThrow(/revision/);
});

it("saveProject com principal ilegível repara o principal e mantém a cópia boa", async () => {
  const dir = await mkdtemp(join(tmpdir(), "project-repair-"));
  await createProject(dir, projectAt(1, "antes"));
  await saveProject(dir, 1, projectAt(2, "depois"));
  await writeFile(join(dir, "project.json"), "\0\0");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    await saveProject(dir, 0, (current) => ({
      ...current,
      revision: current.revision + 1,
      input: { ...current.input, text: "reparado" },
    }));
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
  }
  const prev = JSON.parse(await readFile(join(dir, "project.prev.json"), "utf8")) as { revision: number; input: { text: string } };
  expect(prev.revision).toBe(1);
  expect(prev.input.text).toBe("antes");
  const repaired = await loadProject(dir);
  expect(repaired.revision).toBe(2);
  expect(repaired.input.text).toBe("reparado");
});

it("correção substituída não volta no merge nem no saveProject", async () => {
  const base = withCorrection(projectAt(1, ""));
  const next = applyEdit(base, { type: "correct", sourceId: "s1", start: 1.5, end: 3, text: "novo" });
  const merged = mergeProjectCommit(base, next, base);
  expect(merged.corrections.map((item) => item.id)).toEqual(["c2"]);
  expect(merged.corrections[0]).toMatchObject({ start: 1, end: 3, text: "novo" });

  const dir = await mkdtemp(join(tmpdir(), "project-correct-"));
  await createProject(dir, base);
  await saveProject(dir, base.revision, next, base);
  const saved = await loadProject(dir);
  expect(saved.corrections.map((item) => `${item.id}[${item.start},${item.end}]`)).toEqual(["c2[1,3]"]);
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("project.json ilegível por permissão não é queda: load e save rejeitam e o arquivo fica intacto", async (ctx) => {
  const dir = await mkdtemp(join(tmpdir(), "project-eacces-"));
  await createProject(dir, projectAt(1, "antes"));
  await saveProject(dir, 1, projectAt(2, "depois"));
  const file = join(dir, "project.json");
  const bytes = await readFile(file);
  await chmod(file, 0o000);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    let blocked = false;
    try { await readFile(file); } catch { blocked = true; }
    if (!blocked) ctx.skip();
    await expect(loadProject(dir)).rejects.toMatchObject({ code: "EACCES" });
    await expect(saveProject(dir, 2, projectAt(3, "outra"))).rejects.toMatchObject({ code: "EACCES" });
  } finally {
    await chmod(file, 0o644);
    warn.mockRestore();
  }
  expect((await readFile(file)).equals(bytes)).toBe(true);
  const after = await loadProject(dir);
  expect(after.revision).toBe(2);
  expect(after.input.text).toBe("depois");
});
