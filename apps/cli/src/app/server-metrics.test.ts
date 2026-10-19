import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startApp } from "./server.ts";

describe("cleanup ingest metrics", () => {
  it("persists failed preflight trace and terminal ingest result with autoStart defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "decupa-server-metrics-"));
    const input = join(root, "missing-video.mp4");
    const workDir = join(root, "project");
    let app: Awaited<ReturnType<typeof startApp>> | undefined;
    try {
      app = await startApp({
        input,
        workDir,
        port: 0,
        // autoStart intentionally omitted; this should begin ingest on startup.
        executor: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
      });
      const base = `http://127.0.0.1:${app.port}`;
      let stage = "";
      for (let attempt = 0; attempt < 100 && stage !== "error"; attempt += 1) {
        const response = await fetch(`${base}/jobs/${app.jobId}`);
        expect(response.status).toBe(200);
        stage = (await response.json() as { stage?: string }).stage ?? "";
        if (stage !== "error") await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(stage).toBe("error");

      const metricsDir = join(workDir, ".decupa", "metrics");
      let journals: string[] = [];
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const names = await readdir(metricsDir);
        journals = await Promise.all(names.map((name) => readFile(join(metricsDir, name), "utf8")));
        if (journals.some((journal) => journal.includes('"kind":"ingest-result"'))) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const events = journals.flatMap((journal) => journal.trim().split("\n")
        .filter(Boolean).map((line) => JSON.parse(line) as { kind: string; data?: Record<string, unknown> }));
      expect(events).toContainEqual(expect.objectContaining({
        kind: "trace",
        data: expect.objectContaining({ stage: "preflight", phase: "finished", category: "error" }),
      }));
      expect(events).toContainEqual(expect.objectContaining({
        kind: "ingest-result",
        data: expect.objectContaining({ stage: "error", category: "error" }),
      }));
    } finally {
      await app?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
