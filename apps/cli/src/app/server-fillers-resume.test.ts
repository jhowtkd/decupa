import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
vi.mock("./pipeline.ts", async importOriginal => {
  const original = await importOriginal<typeof import("./pipeline.ts")>();
  return { ...original, preflight: async () => {}, ensureAudioProxy: async () => false, runIngest: async () => ({}) };
});
import { cleanupFixture } from "./cleanup-fillers.test-helper.ts";
import { startApp } from "./server.ts";
import type { Review } from "./review.ts";

it("ingest retoma o par recuperado antes de escolher keep-list", async () => {
  const f = await cleanupFixture(); await f.app.close();
  const index = JSON.parse(await readFile(join(f.dir, "out", "speech_index.json"), "utf8"));
  const previous = { transcriptSha256: index.transcript_sha256, cut: [], kept: [{ candidateId: "hesitation:u001:w1", wordIds: ["u001:w1"], texts: ["hã"] }] };
  await writeFile(join(f.dir, "keep.txt"), "u002\n");
  await writeFile(join(f.dir, "fillers.json"), JSON.stringify(previous));
  await writeFile(join(f.dir, ".fillers-session-pending.json"), JSON.stringify({ keep: "u001\n", fillers: JSON.stringify(previous) }));
  const app = await startApp({ ...f.options, autoStart: true });
  try {
    const base = `http://127.0.0.1:${app.port}/jobs/${app.jobId}`;
    await vi.waitFor(async () => {
      const job = await (await fetch(base)).json() as { review?: Review; stage: string };
      expect(job.stage).toBe("ready");
      expect(job.review!.units.filter(u => u.kept).map(u => u.id)).toEqual(["u001"]);
      expect(job.review!.fillers.groups[0]!.items[0]!.status).toBe("kept");
    });
    expect(f.spans.at(-1)).toEqual([]);
    expect(await readFile(join(f.dir, "keep.txt"), "utf8")).toBe("u001\n");
  } finally { await app.close(); }
});
