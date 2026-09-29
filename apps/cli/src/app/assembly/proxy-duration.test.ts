import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { hashFile } from "@decupa/media";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import { stillDurationMp4 } from "../../../../../tests/fixtures/timeline-reference.ts";
import type { Executor } from "../pipeline.ts";
import { fixtureAssembly } from "./fixture.ts";
import { ensurePlayback, proxyPath } from "./media.ts";

it("proxy 30 s mais curto que uma fonte de 1 h é refeito", async () => {
  const dir = await mkdtemp(join(tmpdir(), "proxy-duration-"));
  const media = join(dir, "fonte.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), media);
  const sha = await hashFile(media);
  const planted = proxyPath(dir, sha);
  await mkdir(dirname(planted), { recursive: true });
  await copyFile(await stillDurationMp4(3570), planted);
  const source = {
    ...fixtureAssembly().sources[0]!,
    id: "s",
    path: media,
    sha256: sha,
    durationSeconds: 3600,
    name: "fonte.mp4",
  };
  let proxyEncodes = 0;
  const exec: Executor = {
    async run(call) {
      const out = call.args.at(-1) ?? "";
      if (call.command === "ffmpeg" && out.endsWith(".tmp.mp4")) {
        proxyEncodes += 1;
        await copyFile(join(FIXTURES, "clip.mp4"), out);
      }
      if (out.endsWith(".tmp.jpg")) await writeFile(out, "miniatura");
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  await expect(ensurePlayback(source, dir, exec)).rejects.toThrow(/proxy inválido/);
  expect(proxyEncodes).toBeGreaterThan(0);
});
