import { copyFile, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { hashFile } from "@decupa/media";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import { writeTimelineReference } from "../../../../../tests/fixtures/timeline-reference.ts";
import { fixtureAssembly } from "./fixture.ts";
import { previewIdentity, renderAssembly } from "./render.ts";

const { linkCalls } = vi.hoisted(() => ({ linkCalls: [] as string[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: (async (...args: Parameters<typeof actual.link>) => {
      linkCalls.push(String(args[0]));
      const error = new Error("EXDEV simulado") as NodeJS.ErrnoException;
      error.code = "EXDEV";
      throw error;
    }) as typeof actual.link,
  };
});

it("sem hardlink (EXDEV) a prévia é copiada, mas o link foi tentado", async () => {
  const dir = await mkdtemp(join(tmpdir(), "preview-cache-exdev-"));
  const media = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), media);
  const assembly = fixtureAssembly();
  const sha = await hashFile(media);
  for (const source of assembly.sources) {
    source.path = media;
    source.sha256 = sha;
  }
  const dest = await renderAssembly(assembly, dir, {
    async run(call) {
      await writeTimelineReference(call);
      return { code: 0, stdout: "ok", stderr: "" };
    },
  });
  const cached = join(dir, "preview-cache", previewIdentity(assembly), "reference.mp4");
  expect(linkCalls.length).toBeGreaterThan(0);
  expect((await stat(dest)).ino).not.toBe((await stat(cached)).ino);
});
