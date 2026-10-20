import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { hashFile } from "@decupa/media";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import { writeTimelineReference } from "../../../../../tests/fixtures/timeline-reference.ts";
import type { Executor } from "../pipeline.ts";
import { fixtureAssembly } from "./fixture.ts";
import { renderAssembly } from "./render.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, statfs: vi.fn(async () => ({ bavail: 20_000_000, bsize: 4096 })) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("registra o trabalho de rhythm-samples no projeto e no ledger global", async () => {
  const { initializeResourceLedger, mediaKey, resourceLedgerForProject } = await import("../resource-ledger.ts");
  const fs = await import("node:fs/promises");

  const root = await mkdtemp(join(tmpdir(), "render-rhythm-samples-ledger-"));
  roots.push(root);
  const projectsRoot = join(root, "projects");
  const projectDir = join(projectsRoot, "montagem");
  const outDir = join(projectDir, "rhythm-samples");
  await mkdir(outDir, { recursive: true });
  const media = join(root, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), media);
  const assembly = fixtureAssembly();
  for (const source of assembly.sources) {
    source.path = media;
    source.sha256 = await hashFile(media);
  }
  await writeFile(join(projectDir, "project.json"), JSON.stringify({ assembly: { sources: assembly.sources } }));
  const ledger = await initializeResourceLedger({ root: join(root, "media-root"), projectsRoot });
  const projectLedger = resourceLedgerForProject(projectDir);

  const executor: Executor = {
    async run(call) {
      expect(await projectLedger.hasWork(projectDir)).toBe(true);
      expect(await ledger.references(mediaKey(assembly.sources[0]!.sha256)))
        .toContainEqual(expect.objectContaining({ kind: "in-progress", projectDir }));
      await writeTimelineReference(call);
      return { code: 0, stdout: "ok", stderr: "" };
    },
  };

  await renderAssembly(assembly, outDir, executor);
  await expect(fs.stat(join(outDir, ".decupa"))).rejects.toMatchObject({ code: "ENOENT" });
  const index = JSON.parse(await readFile(join(root, "media-root", ".decupa", "references.json"), "utf8"));
  expect(index.entries.some((entry: { owner: { kind: string } }) => entry.owner.kind === "in-progress")).toBe(false);
});
