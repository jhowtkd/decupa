import { access, copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect, it } from "vitest";
import { hashFile } from "@decupa/media";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import { exactReferenceMp4, writeTimelineReference } from "../../../../../tests/fixtures/timeline-reference.ts";
import { startApp } from "../server.ts";
import type { Executor } from "../pipeline.ts";
import { exportApproved } from "./export.ts";
import { fixtureAssembly } from "./fixture.ts";
import { previewIdentity, renderAssembly } from "./render.ts";
import { blankProject } from "./routes.ts";
import { createProject, loadProject } from "./store.ts";
import type { Assembly, Project } from "./types.ts";

async function withMedia(dir: string): Promise<Assembly> {
  const media = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), media);
  const assembly = fixtureAssembly();
  const sha = await hashFile(media);
  for (const source of assembly.sources) {
    source.path = media;
    source.sha256 = sha;
  }
  return assembly;
}

function executorWriting(frames: number): Executor {
  return {
    async run(call) {
      if (call.command !== "python3") return { code: 0, stdout: "", stderr: "" };
      const out = call.args[call.args.indexOf("--out") + 1]!;
      await copyFile(await exactReferenceMp4(frames, 25), out);
      return { code: 0, stdout: "ok", stderr: "" };
    },
  };
}

async function projectWithPreview(dir: string, previewFrames: number): Promise<Project> {
  const assembly = await withMedia(dir);
  assembly.revision = 1;
  const project = blankProject("p");
  project.revision = 1;
  project.assembly = assembly;
  project.input.targetSeconds = 2;
  project.previewRevision = 1;
  project.finalApprovedRevision = 1;
  await mkdir(join(dir, "rev-1"), { recursive: true });
  const reference = join(dir, "rev-1", "reference.mp4");
  await copyFile(await exactReferenceMp4(previewFrames, 25), reference);
  project.previewArtifact = {
    revision: 1,
    relativePath: relative(dir, reference),
    sha256: await hashFile(reference),
    assemblySha256: createHash("sha256").update(JSON.stringify(project.assembly)).digest("hex"),
  };
  return project;
}

it("render mais curto que a timeline por mais de um quadro não publica nem entra no cache", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duration-short-"));
  const assembly = await withMedia(dir);
  const key = previewIdentity(assembly);
  await expect(renderAssembly(assembly, dir, executorWriting(25))).rejects.toThrow(/duração errada/);
  await expect(access(join(dir, "rev-1", "reference.mp4"))).rejects.toThrow();
  await expect(access(join(dir, "preview-cache", key, "reference.mp4"))).rejects.toThrow();
});

it("render mais longo que a timeline por mais de um quadro não publica nem entra no cache", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duration-long-"));
  const assembly = await withMedia(dir);
  const key = previewIdentity(assembly);
  await expect(renderAssembly(assembly, dir, executorWriting(75))).rejects.toThrow(/duração errada/);
  await expect(access(join(dir, "rev-1", "reference.mp4"))).rejects.toThrow();
  await expect(access(join(dir, "preview-cache", key, "reference.mp4"))).rejects.toThrow();
});

it("diferença de até um quadro passa na conferência", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duration-frame-"));
  const assembly = await withMedia(dir);
  await expect(renderAssembly(assembly, dir, executorWriting(51))).resolves.toBe(
    join(dir, "rev-1", "reference.mp4"),
  );
});

it("cache antigo com duração errada é renderizado de novo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duration-stale-"));
  const assembly = await withMedia(dir);
  const key = previewIdentity(assembly);
  const cacheDir = join(dir, "preview-cache", key);
  await mkdir(cacheDir, { recursive: true });
  await copyFile(await exactReferenceMp4(10, 25), join(cacheDir, "reference.mp4"));
  await writeFile(join(cacheDir, "preview.json"), `${JSON.stringify({ sha256: "x", profile: "software" })}\n`);
  let python = 0;
  const exec: Executor = {
    async run(call) {
      if (call.command === "python3") python += 1;
      await writeTimelineReference(call);
      return { code: 0, stdout: "ok", stderr: "" };
    },
  };
  await renderAssembly(assembly, dir, exec);
  expect(python).toBe(1);
});

it("exportApproved recusa prévia truncada com o sha certo e não cria a pasta", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duration-export-"));
  const project = await projectWithPreview(dir, 10);
  await createProject(dir, project);
  await expect(exportApproved(project, dir)).rejects.toThrow(/duração errada/);
  await expect(access(join(dir, "exports"))).rejects.toThrow();
});

it("POST /preview com MP4 de outra duração não grava previewArtifact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duration-route-"));
  const assembly = await withMedia(dir);
  assembly.revision = 0;
  const project = blankProject("p");
  project.assembly = assembly;
  await createProject(dir, project);
  const app = await startApp({
    projectDir: dir,
    port: 0,
    executor: {
      async run(call) {
        if (call.command === "python3") {
          const out = call.args[call.args.indexOf("--out") + 1]!;
          await copyFile(join(FIXTURES, "clip.mp4"), out);
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  });
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/project/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: 0 }),
    });
    expect(res.status).not.toBe(200);
    expect((await loadProject(dir)).previewArtifact).toBeNull();
  } finally {
    await app.close();
  }
});
