import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import { hashFile } from "@decupa/media";
import { exportApproved } from "./export.ts";
import { fixtureAssembly } from "./fixture.ts";
import { createProject } from "./store.ts";
import type { Project } from "./types.ts";

let failNextCopy = false;
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    copyFile: (async (...args: Parameters<typeof actual.copyFile>) => {
      if (failNextCopy) {
        failNextCopy = false;
        throw new Error("EACCES simulado na substituta");
      }
      return actual.copyFile(...args);
    }) as typeof actual.copyFile,
  };
});

async function projectWithMedia(dir: string, revision = 1): Promise<Project> {
  const speech = join(dir, "fala.mp4");
  const support = join(dir, "apoio.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), speech);
  await copyFile(join(FIXTURES, "clip.mp4"), support);
  const assembly = fixtureAssembly();
  assembly.revision = revision;
  assembly.sources[0]!.path = speech;
  assembly.sources[1]!.path = support;
  assembly.sources[0]!.sha256 = await hashFile(speech);
  assembly.sources[1]!.sha256 = await hashFile(support);
  const project: Project = {
    version: 2,
    id: "p1",
    revision,
    input: { kind: "brief", text: "tema", targetSeconds: 2 },
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
  await copyFile(join(FIXTURES, "clip.mp4"), reference);
  const { createHash } = await import("node:crypto");
  const { relative } = await import("node:path");
  project.previewArtifact = {
    revision,
    assemblySha256: createHash("sha256").update(JSON.stringify(project.assembly)).digest("hex"),
    relativePath: relative(dir, reference),
    sha256: await hashFile(reference),
  };
  return project;
}

it("recusa export com aprovação final desatualizada", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-export-"));
  const project = await projectWithMedia(dir);
  project.finalApprovedRevision = 0;
  await expect(exportApproved(project, dir))
    .rejects.toThrow(/aprovação final desatualizada/);
});

it("nomeia fonte ausente e não anuncia saída parcial", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-export-"));
  const project = await projectWithMedia(dir);
  const { unlink } = await import("node:fs/promises");
  await unlink(project.assembly.sources[0]!.path);
  await expect(exportApproved(project, dir))
    .rejects.toThrow(/mídia ausente.*a /);
  await expect(exportApproved(project, dir))
    .rejects.toThrow(/fala\.mp4/);
});

it("recusa path relativo na exportação final", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-export-"));
  const project = await projectWithMedia(dir);
  project.assembly.sources[0]!.path = "fala.mp4";
  const { createHash } = await import("node:crypto");
  project.previewArtifact = {
    ...project.previewArtifact!,
    assemblySha256: createHash("sha256").update(JSON.stringify(project.assembly)).digest("hex"),
  };
  await expect(exportApproved(project, dir))
    .rejects.toThrow(/absoluto/);
});

it("recusa export concorrente da mesma revisão", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-export-"));
  const project = await projectWithMedia(dir, 3);
  await createProject(dir, project);
  await mkdir(join(dir, "exports"), { recursive: true });
  await writeFile(join(dir, "exports", ".rev-3.lock"), `${process.pid}\n`, "utf8");
  await expect(exportApproved(project, dir))
    .rejects.toThrow(/andamento/);
});

it("grava timeline, referência e manifest na pasta da revisão", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-export-"));
  const project = await projectWithMedia(dir, 4);
  await createProject(dir, project);
  const dest = await exportApproved(project, dir);
  expect(dest).toBe(join(dir, "exports", "4"));
  const { readFile } = await import("node:fs/promises");
  const manifest = JSON.parse(await readFile(join(dest, "manifest.json"), "utf8")) as {
    reference: string;
  };
  expect(manifest.reference).toBe(project.previewArtifact!.sha256);
  const again = await exportApproved(project, dir);
  expect(again).toBe(dest);
});

it("copia exatamente o mp4 assistido sem renderizar", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-export-"));
  const project = await projectWithMedia(dir, 6);
  await createProject(dir, project);
  const dest = await exportApproved(project, dir);
  const { readFile } = await import("node:fs/promises");
  const exported = await readFile(join(dest, "reference.mp4"));
  const watched = await readFile(join(dir, "rev-6", "reference.mp4"));
  expect(exported.equals(watched)).toBe(true);
});

it("recusa prévia de outra montagem ou revisão", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-export-"));
  const project = await projectWithMedia(dir, 7);
  project.previewArtifact = { ...project.previewArtifact!, assemblySha256: "0".repeat(64) };
  await expect(exportApproved(project, dir)).rejects.toThrow(/outra montagem/);
  const fresh = await projectWithMedia(dir, 7);
  fresh.previewArtifact = { ...fresh.previewArtifact!, revision: 6 };
  await expect(exportApproved(fresh, dir)).rejects.toThrow(/desatualizada/);
});

it("recusa prévia truncada ou ausente", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-export-"));
  const project = await projectWithMedia(dir, 8);
  await createProject(dir, project);
  await writeFile(join(dir, "rev-8", "reference.mp4"), "curta");
  await expect(exportApproved(project, dir)).rejects.toThrow(/alterada ou truncada/);
  const { unlink } = await import("node:fs/promises");
  await unlink(join(dir, "rev-8", "reference.mp4"));
  await expect(exportApproved(project, dir)).rejects.toThrow(/ausente ou ilegível/);
});

it("recusa fonte cujo hash atual diverge do sha256 aprovado", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-export-"));
  const project = await projectWithMedia(dir, 5);
  await writeFile(project.assembly.sources[0]!.path, "conteudo-diferente");
  await expect(exportApproved(project, dir))
    .rejects.toThrow(/substitu|reanalise|relink/);
});

it("export corrompido não é reutilizado como sucesso: republica íntegro (V2)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-export-"));
  const project = await projectWithMedia(dir, 9);
  await createProject(dir, project);
  const dest = await exportApproved(project, dir);
  expect(dest).toBe(join(dir, "exports", "9"));
  await writeFile(join(dest, "reference.mp4"), "conteúdo-inválido");
  const again = await exportApproved(project, dir);
  expect(again).toBe(dest);
  const { readFile } = await import("node:fs/promises");
  const delivered = await readFile(join(dest, "reference.mp4"));
  const watched = await readFile(join(dir, "rev-9", "reference.mp4"));
  expect(delivered.equals(watched)).toBe(true);
});

it("falha na substituta preserva a entrega anterior (R4)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-export-"));
  const { readdir, readFile, stat } = await import("node:fs/promises");
  const project = await projectWithMedia(dir, 11);
  await createProject(dir, project);
  const dest = await exportApproved(project, dir);
  await writeFile(join(dest, "reference.mp4"), "conteúdo-inválido");
  failNextCopy = true;
  await expect(exportApproved(project, dir)).rejects.toThrow(/EACCES simulado/);
  // A entrega anterior segue intacta e sem restos temporários.
  expect((await stat(join(dest, "timeline.otio"))).size).toBeGreaterThan(0);
  expect(JSON.parse(await readFile(join(dest, "manifest.json"), "utf8")).revision).toBe(11);
  expect(await readFile(join(dest, "reference.mp4"), "utf8")).toBe("conteúdo-inválido");
  expect((await readdir(join(dir, "exports"))).filter((f) => f.startsWith(".tmp-"))).toEqual([]);
  // A tentativa seguinte recupera a entrega íntegra.
  await expect(exportApproved(project, dir)).resolves.toBe(dest);
  const delivered = await readFile(join(dest, "reference.mp4"));
  const watched = await readFile(join(dir, "rev-11", "reference.mp4"));
  expect(delivered.equals(watched)).toBe(true);
});

it("otio ausente ou corrompido republica em vez de reutilizar (V2)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-export-"));
  const { unlink } = await import("node:fs/promises");
  const project = await projectWithMedia(dir, 10);
  await createProject(dir, project);
  const dest = await exportApproved(project, dir);
  await unlink(join(dest, "timeline.otio"));
  await expect(exportApproved(project, dir)).resolves.toBe(dest);
  const { readFile, stat } = await import("node:fs/promises");
  expect((await stat(join(dest, "timeline.otio"))).size).toBeGreaterThan(0);
  await writeFile(join(dest, "timeline.otio"), "lixo");
  await expect(exportApproved(project, dir)).resolves.toBe(dest);
  const otio = await readFile(join(dest, "timeline.otio"), "utf8");
  expect(otio).toContain("Timeline");
});

it("recusa export se o projeto em disco estiver ausente ou ilegível", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-export-"));
  const project = await projectWithMedia(dir, 10);
  await expect(exportApproved(project, dir)).rejects.toThrow();
});

it("exporta quando o project.json da mesma revisão está íntegro", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-export-"));
  const project = await projectWithMedia(dir, 10);
  await createProject(dir, project);
  const dest = await exportApproved(project, dir);
  expect(dest).toContain("exports");
});

it("restaura handoff Markdown ausente, alterado ou sem hash no manifest", async () => {
  const { readFile, unlink } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "assembly-export-"));
  const project = await projectWithMedia(dir);
  await createProject(dir, project);
  const dest = await exportApproved(project, dir);
  const path = join(dest, "handoff.md");
  const expected = await readFile(path, "utf8");
  for (const damage of ["missing", "changed", "legacy"]) {
    if (damage === "missing") await unlink(path);
    if (damage === "changed") await writeFile(path, "corrompido");
    if (damage === "legacy") {
      const manifest = JSON.parse(await readFile(join(dest, "manifest.json"), "utf8"));
      delete manifest.handoffMarkdown;
      await writeFile(join(dest, "manifest.json"), JSON.stringify(manifest));
    }
    expect(await exportApproved(project, dir)).toBe(dest);
    expect(await readFile(path, "utf8")).toBe(expected);
    expect(JSON.parse(await readFile(join(dest, "manifest.json"), "utf8")).handoffMarkdown).toMatch(/^[a-f0-9]{64}$/);
  }
});
