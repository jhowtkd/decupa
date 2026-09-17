import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AbandonedError, createFileCoordinator } from "./index.ts";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dir(): string {
  return join(tmpdir(), `coord-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

async function waitUntil(label: string, probe: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await probe()) return;
    await delay(10);
  }
  throw new Error(`timeout waiting for ${label}`);
}

describe("createFileCoordinator", () => {
  it("dois clientes isolados disputam o mesmo limite", async () => {
    const root = dir();
    await mkdir(root, { recursive: true });
    const a = createFileCoordinator(root, { limit: 1, pollMs: 5 });
    const b = createFileCoordinator(root, { limit: 1, pollMs: 5 });
    let concurrent = 0;
    let max = 0;
    const work = (id: string) => async () => {
      concurrent += 1;
      max = Math.max(max, concurrent);
      await delay(40);
      concurrent -= 1;
      return id;
    };
    const [ra, rb] = await Promise.all([
      a.run({ id: "t1", stage: "ingest", build: work("t1") }),
      b.run({ id: "t2", stage: "ingest", build: work("t2") }),
    ]);
    expect(new Set([ra, rb])).toEqual(new Set(["t1", "t2"]));
    expect(max).toBe(1);
  });

  it("morte/reinício retoma só o incompleto", async () => {
    const root = dir();
    await mkdir(root, { recursive: true });
    const clock = { t: 1_000 };
    const first = createFileCoordinator(root, { limit: 1, leaseMs: 50, pollMs: 5, now: () => clock.t });
    let builds = 0;
    const stale = first.run({
      id: "asr",
      stage: "transcribe",
      build: async () => {
        builds += 1;
        await delay(80);
        return { from: "stale", n: builds };
      },
    });
    await waitUntil("stale build started", async () => builds === 1);
    clock.t += 200;
    const second = createFileCoordinator(root, { limit: 1, leaseMs: 50, pollMs: 5, now: () => clock.t });
    const resumed = await second.run({
      id: "asr",
      stage: "transcribe",
      build: async () => {
        builds += 1;
        return { from: "resume", n: builds };
      },
    });
    expect(resumed).toEqual({ from: "resume", n: 2 });
    await expect(stale).rejects.toBeInstanceOf(AbandonedError);
    const replay = await second.run({
      id: "asr",
      stage: "transcribe",
      build: async () => {
        builds += 1;
        return { from: "replay", n: builds };
      },
    });
    expect(replay).toEqual({ from: "resume", n: 2 });
    expect(builds).toBe(2);
  });

  it("execução velha abandonada não publica resultado", async () => {
    const root = dir();
    await mkdir(root, { recursive: true });
    const clock = { t: 1 };
    const stale = createFileCoordinator(root, { limit: 1, leaseMs: 20, pollMs: 5, now: () => clock.t });
    let published = "";
    const abandoned = stale.run({
      id: "clip",
      stage: "encode",
      build: async () => {
        clock.t += 100;
        await delay(80);
        published = "stale-result";
        return { leaked: true };
      },
    });
    await waitUntil("stale advanced the lease clock", async () => clock.t >= 100);
    const fresh = createFileCoordinator(root, { limit: 1, leaseMs: 20, pollMs: 5, now: () => clock.t });
    const result = await fresh.run({
      id: "clip",
      stage: "encode",
      build: async () => ({ leaked: false }),
    });
    expect(result).toEqual({ leaked: false });
    await expect(abandoned).rejects.toBeInstanceOf(AbandonedError);
    expect(published).toBe("stale-result");
    const replay = await createFileCoordinator(root).run({
      id: "clip",
      stage: "encode",
      build: async () => ({ leaked: "nope" }),
    });
    expect(replay).toEqual({ leaked: false });
  });

  it("edição interativa passa na frente do lote quando a vaga libera", async () => {
    const root = dir();
    await mkdir(root, { recursive: true });
    const coord = createFileCoordinator(root, { limit: 1, pollMs: 5 });
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const blocker = coord.run({
      id: "blocker",
      stage: "ingest",
      build: async () => {
        await held;
        return "blocker";
      },
    });
    await waitUntil("blocker holds the slot", async () => {
      try {
        const raw = JSON.parse(await readFile(join(root, "waiters.json"), "utf8")) as unknown[];
        return Array.isArray(raw) && raw.length === 0;
      } catch {
        return false;
      }
    });
    const batch = coord.run({
      id: "batch",
      stage: "ingest",
      priority: "batch",
      build: async () => {
        order.push("batch");
        return "batch";
      },
    });
    const interactive = coord.run({
      id: "edit",
      stage: "ingest",
      priority: "interactive",
      build: async () => {
        order.push("interactive");
        return "edit";
      },
    });
    await waitUntil("batch and interactive are queued", async () => {
      try {
        const waiters = JSON.parse(await readFile(join(root, "waiters.json"), "utf8")) as { priority: string }[];
        return waiters.some((w) => w.priority === "batch") && waiters.some((w) => w.priority === "interactive");
      } catch {
        return false;
      }
    });
    release();
    expect(await Promise.all([blocker, batch, interactive])).toEqual(["blocker", "batch", "edit"]);
    expect(order).toEqual(["interactive", "batch"]);
  });
});
