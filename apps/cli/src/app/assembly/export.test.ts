import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import { hashFile } from "@decupa/media";
import type { Executor } from "../pipeline.ts";
import { exportApproved } from "./export.ts";
import { fixtureAssembly } from "./fixture.ts";
import type { Project } from "./types.ts";

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
  return {
    version: 2,
    id: "p1",
    revision,
    input: { kind: "brief", text: "tema", targetSeconds: 2 },
    assembly,
    scenes: [],
    analyses: [],
    proposal: null,
    structureApprovedRevision: revision,
    previewRevision: revision,
    finalApprovedRevision: revision,
    corrections: [],
    preparation: null,
    permissions: { model: false, visual: false },
    previewArtifact: null,
  };
}

it("recusa export com aprovação final desatualizada", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-export-"));
  const project = await projectWithMedia(dir);
  project.finalApprovedRevision = 0;
  await expect(exportApproved(project, dir, { async run() { return { code: 0, stdout: "", stderr: "" }; } }))
    .rejects.toThrow(/aprovação final desatualizada/);
});

it("nomeia fonte ausente e não anuncia saída parcial", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-export-"));
  const project = await projectWithMedia(dir);
  project.assembly.sources[0]!.path = join(dir, "desapareceu.mp4");
  await expect(exportApproved(project, dir, { async run() { return { code: 0, stdout: "", stderr: "" }; } }))
    .rejects.toThrow(/mídia ausente.*a /);
  await expect(exportApproved(project, dir, { async run() { return { code: 0, stdout: "", stderr: "" }; } }))
    .rejects.toThrow(/desapareceu/);
});

it("recusa path relativo na exportação final", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-export-"));
  const project = await projectWithMedia(dir);
  project.assembly.sources[0]!.path = "fala.mp4";
  await expect(exportApproved(project, dir, { async run() { return { code: 0, stdout: "", stderr: "" }; } }))
    .rejects.toThrow(/absoluto/);
});

it("recusa export concorrente da mesma revisão", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-export-"));
  const project = await projectWithMedia(dir, 3);
  await mkdir(join(dir, "exports"), { recursive: true });
  await writeFile(join(dir, "exports", ".rev-3.lock"), `${process.pid}\n`, "utf8");
  await expect(exportApproved(project, dir, { async run() { return { code: 0, stdout: "", stderr: "" }; } }))
    .rejects.toThrow(/andamento/);
});

it("grava timeline, referência e manifest na pasta da revisão", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-export-"));
  const project = await projectWithMedia(dir, 4);
  const wrapping: Executor = {
    async run(call) {
      const work = call.env?.CLAUDE_PROJECT_DIR ?? call.cwd ?? "";
      await writeFile(join(work, "reference.mp4"), "mp4");
      return { code: 0, stdout: "ok", stderr: "" };
    },
  };
  const dest = await exportApproved(project, dir, wrapping);
  expect(dest).toBe(join(dir, "exports", "4"));
  const again = await exportApproved(project, dir, {
    async run() { throw new Error("não deveria renderizar de novo"); },
  });
  expect(again).toBe(dest);
});

it("recusa fonte cujo hash atual diverge do sha256 aprovado", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-export-"));
  const project = await projectWithMedia(dir, 5);
  await writeFile(project.assembly.sources[0]!.path, "conteudo-diferente");
  await expect(exportApproved(project, dir, { async run() { return { code: 0, stdout: "", stderr: "" }; } }))
    .rejects.toThrow(/substitu|reanalise|relink/);
});
