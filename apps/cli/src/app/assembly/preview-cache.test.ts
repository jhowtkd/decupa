import { copyFile, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { hashFile } from "@decupa/media";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import { writeTimelineReference } from "../../../../../tests/fixtures/timeline-reference.ts";
import type { Executor } from "../pipeline.ts";
import { fixtureAssembly } from "./fixture.ts";
import { previewIdentity, renderAssembly } from "./render.ts";
import { pruneProject } from "./retention.ts";
import type { Assembly } from "./types.ts";

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

function renderExec(): Executor & { python: number } {
  const exec: Executor & { python: number } = {
    python: 0,
    async run(call) {
      if (call.command === "python3") exec.python += 1;
      await writeTimelineReference(call);
      return { code: 0, stdout: "ok", stderr: "" };
    },
  };
  return exec;
}

it("rev-N e preview-cache apontam para o mesmo arquivo e a rev grava a chave", async () => {
  const dir = await mkdtemp(join(tmpdir(), "preview-cache-link-"));
  const assembly = await withMedia(dir);
  const dest = await renderAssembly(assembly, dir, renderExec());
  const key = previewIdentity(assembly);
  const cached = join(dir, "preview-cache", key, "reference.mp4");
  expect((await stat(dest)).ino).toBe((await stat(cached)).ino);
  const marker = JSON.parse(await readFile(join(dir, "rev-1", "preview-cache.json"), "utf8")) as { key: string };
  expect(marker.key).toBe(key);
});

it("acerto de cache reaproveita por hardlink e grava a marca na revisão nova", async () => {
  const dir = await mkdtemp(join(tmpdir(), "preview-cache-hit-"));
  const assembly = await withMedia(dir);
  const exec = renderExec();
  const first = await renderAssembly(assembly, dir, exec);
  const again = structuredClone(assembly);
  again.revision = 8;
  again.name = "outro nome";
  const second = await renderAssembly(again, dir, exec);
  const key = previewIdentity(assembly);
  expect(exec.python).toBe(1);
  expect((await stat(second)).ino).toBe((await stat(first)).ino);
  expect((await stat(second)).ino).toBe((await stat(join(dir, "preview-cache", key, "reference.mp4"))).ino);
  const marker = JSON.parse(await readFile(join(dir, "rev-8", "preview-cache.json"), "utf8")) as { key: string };
  expect(marker.key).toBe(key);
});

it("pruneProject só mantém o cache das revisões protegidas, inclusive a aprovada antiga", async () => {
  const dir = await mkdtemp(join(tmpdir(), "preview-cache-prune-"));
  const exec = renderExec();
  const keys: string[] = [];
  for (const [index, frames] of [20, 24, 28, 32, 36, 40].entries()) {
    const assembly = await withMedia(dir);
    assembly.revision = index + 1;
    assembly.tracks[0]!.clips[0]!.durationFrames = frames;
    await renderAssembly(assembly, dir, exec);
    keys.push(previewIdentity(assembly));
  }
  await writeFile(join(dir, "project.json"), `${JSON.stringify({
    revision: 6,
    previewRevision: 1,
    finalApprovedRevision: 1,
    previewArtifact: { revision: 1 },
  })}\n`);
  await mkdir(join(dir, "exports", "1"), { recursive: true });
  const orphan = "ab".repeat(32);
  await mkdir(join(dir, "preview-cache", orphan), { recursive: true });
  await writeFile(join(dir, "preview-cache", orphan, "reference.mp4"), "órfão");
  await pruneProject(dir);
  const left = (await readdir(join(dir, "preview-cache"))).sort();
  expect(left).toEqual([keys[0], keys[3], keys[4], keys[5]].sort());
});
