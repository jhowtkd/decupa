import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileCoordinator } from "@decupa/coordinator";
import { runSpeechJob } from "./resident.ts";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("runSpeechJob", () => {
  it("dois arquivos disputam o coordenador e não misturam respostas", async () => {
    const dir = await mkdtemp(join(tmpdir(), "speech-coord-"));
    const coordinator = createFileCoordinator(dir, { limit: 1, pollMs: 5 });
    let concurrent = 0;
    let max = 0;
    const job = (id: string) => runSpeechJob(coordinator, {
      id,
      build: async () => {
        concurrent += 1;
        max = Math.max(max, concurrent);
        await delay(25);
        concurrent -= 1;
        return { taskId: id };
      },
    });
    const [a, b] = await Promise.all([job("wav-a"), job("wav-b")]);
    expect(max).toBe(1);
    expect(new Set([a.taskId, b.taskId])).toEqual(new Set(["wav-a", "wav-b"]));
  });
});
