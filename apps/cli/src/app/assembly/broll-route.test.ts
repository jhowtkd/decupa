import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startApp } from "../server.ts";
import { blankProject } from "./routes.ts";
import { createProject } from "./store.ts";

it("GET /project com 3600 trechos de apoio responde em menos de 1 s", async () => {
  const dir = await mkdtemp(join(tmpdir(), "broll-route-"));
  const n = 3600;
  const fps = { num: 30000, den: 1001 };
  const project = blankProject("broll");
  project.assembly.fps = fps;
  project.assembly.sources = [{
    id: "b1",
    path: "/tmp/b.mp4",
    sha256: "b".repeat(64),
    durationSeconds: n,
    hasVideo: true,
    hasAudio: true,
    fps,
    width: 320,
    height: 240,
    role: "support",
    included: true,
    name: "b.mp4",
  }];
  project.analyses = [{
    sourceId: "b1",
    key: "k",
    speech: [],
    visual: Array.from({ length: n }, (_, i) => ({
      id: `b1:w${i}`,
      sourceId: "b1",
      start: i,
      end: i + 1,
      text: `cena ${i}`,
      confidence: "observed" as const,
      tags: [],
    })),
    status: "ready",
    words: [],
    wordsStatus: "ready",
    visualCoverage: { requested: [], returned: [], missing: [] },
  }];
  await createProject(dir, project);
  const app = await startApp({
    projectDir: dir,
    port: 0,
    executor: { async run() { return { code: 0, stdout: "", stderr: "" }; } },
  });
  try {
    const started = performance.now();
    const res = await fetch(`http://127.0.0.1:${app.port}/project`);
    const body = await res.json() as { brollCandidates: unknown[] };
    const elapsed = performance.now() - started;
    expect(res.status).toBe(200);
    expect(body.brollCandidates.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(1000);
  } finally {
    await app.close();
  }
}, 30_000);
