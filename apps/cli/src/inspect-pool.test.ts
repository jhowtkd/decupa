import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeTriageModel } from "@decupa/triage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVisualPools } from "./app/assembly/visual-pool.ts";
import { extractUnitFrames, runTriage } from "./triage.ts";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("inspect vs visual encode budget", () => {
  beforeEach(() => {
    vi.stubEnv("ZAI_API_KEY", "test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("inspect de frames espera a vaga de encode das janelas visuais", async () => {
    const dest = await mkdtemp(join(tmpdir(), "inspect-pool-"));
    await mkdir(join(dest, "frames"), { recursive: true });
    const pool = createVisualPools({ ffmpegLimit: 1, networkLimit: 2 });
    let encodeHeld = true;
    const holding = pool.encode(async () => {
      await delay(80);
      encodeHeld = false;
      return "window";
    });
    const startedWhileHeld: boolean[] = [];
    const frames = extractUnitFrames(
      join(dest, "v.mp4"),
      { id: "u004", start: 0, end: 1 },
      join(dest, "frames"),
      {
        pool,
        spawn: () => {
          startedWhileHeld.push(encodeHeld);
          const child = new EventEmitter();
          queueMicrotask(() => child.emit("close", 0));
          return child as ReturnType<typeof import("node:child_process").spawn>;
        },
      },
    );
    await Promise.all([holding, frames]);
    expect(startedWhileHeld.length).toBeGreaterThan(0);
    expect(startedWhileHeld.some(Boolean)).toBe(false);
  });

  it("inspect da API espera a vaga de rede compartilhada", async () => {
    const dir = await mkdtemp(join(tmpdir(), "inspect-net-"));
    const indexPath = join(dir, "speech_index.json");
    await writeFile(indexPath, JSON.stringify({
      source_duration: 40,
      budget: { lossless_floor_seconds: 20 },
      topic_runs: [{ keyword: "escala", unit_ids: ["u003", "u005"] }],
      units: [
        { id: "u001", index: 0, start: 0, end: 2, duration: 2, text: "Vamos começar pelo argumento principal." },
        { id: "u002", index: 1, start: 3, end: 5, duration: 2, text: "O ponto é este." },
        { id: "u003", index: 2, start: 6, end: 9, duration: 3, text: "Isso não escala de jeito nenhum." },
        { id: "u004", index: 3, start: 10, end: 12, duration: 2, text: "Nossa, que calor." },
        { id: "u005", index: 4, start: 13, end: 16, duration: 3, text: "Dessa forma não escala a comunicação." },
      ],
    }), "utf8");
    const videoPath = join(dir, "v.mp4");
    await writeFile(videoPath, "fake", "utf8");
    const pool = createVisualPools({ ffmpegLimit: 1, networkLimit: 1 });
    let occupied = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holding = pool.request(async () => {
      occupied = true;
      await gate;
      return "window-api";
    });
    await expect.poll(() => occupied).toBe(true);
    let inspectCalls = 0;
    const model = new FakeTriageModel([], [], [
      { unitId: "u004", decision: "drop", note: "olhando para o operador" },
    ]);
    const orig = model.inspect.bind(model);
    model.inspect = async (req) => {
      inspectCalls += 1;
      return orig(req);
    };
    const pending = runTriage({
      indexPath,
      videoPath,
      outDir: dir,
      model,
      visualPools: pool,
      visual: [{
        id: "u004", looksAway: true, handOnFace: false, noFace: false,
        ambiguous: true, samples: [],
      }],
      extractFrames: async (unit) => {
        const path = join(dir, `${unit.id}.jpg`);
        await writeFile(path, "jpeg-fake", "utf8");
        return [path];
      },
    });
    await expect.poll(() => model.calls.some((c) => c.kind === "structure")).toBe(true);
    await delay(40);
    expect(inspectCalls).toBe(0);
    release();
    const out = await pending;
    await holding;
    expect(inspectCalls).toBe(1);
    expect(out.reviewFlags.some((f) => f.unitId === "u004" && f.code === "looks_away")).toBe(true);
  });
});
