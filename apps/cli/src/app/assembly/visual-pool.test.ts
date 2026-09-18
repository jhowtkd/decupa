import { describe, expect, it } from "vitest";
import { CancelledError, isCancelledError } from "@decupa/queue";
import { createVisualPools, isVisualRetryable } from "./visual-pool.ts";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createVisualPools", () => {
  it("janela à espera da API não segura vaga de encode", async () => {
    const pool = createVisualPools({ ffmpegLimit: 1, networkLimit: 2 });
    let encoding = 0;
    let maxEncode = 0;
    let waitingApi = 0;
    let overlap = 0;
    const window = async (id: number) => {
      await pool.encode(async () => {
        encoding += 1;
        maxEncode = Math.max(maxEncode, encoding);
        await delay(20);
        encoding -= 1;
        return id;
      });
      await pool.request(async () => {
        waitingApi += 1;
        if (encoding > 0) overlap += 1;
        await delay(40);
        waitingApi -= 1;
        return id;
      });
    };
    await Promise.all([window(1), window(2)]);
    expect(maxEncode).toBe(1);
    expect(overlap).toBeGreaterThan(0);
  });

  it("limit=1 é idêntico ao legado serial", async () => {
    const pool = createVisualPools({ ffmpegLimit: 1, networkLimit: 1 });
    let encoding = 0;
    let requesting = 0;
    let maxEncode = 0;
    let maxNetwork = 0;
    const results = await pool.mapWindows([1, 2, 3], async (n) => {
      await pool.encode(async () => {
        encoding += 1;
        maxEncode = Math.max(maxEncode, encoding);
        await delay(8);
        encoding -= 1;
      });
      await pool.request(async () => {
        requesting += 1;
        maxNetwork = Math.max(maxNetwork, requesting);
        await delay(8);
        requesting -= 1;
        return n * 10;
      });
      return n * 10;
    });
    expect(results).toEqual([10, 20, 30]);
    expect(maxEncode).toBe(1);
    expect(maxNetwork).toBe(1);
  });

  it("429/529 fazem backoff com jitter e não disparam rajada", async () => {
    const sleeps: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const pool = createVisualPools({
      ffmpegLimit: 1,
      networkLimit: 1,
      now: () => 0,
      sleep: async (ms) => { sleeps.push(ms); },
      random: () => 0.5,
      retryBudgetMs: 30_000,
    });
    const result = await pool.request(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      calls += 1;
      inFlight -= 1;
      if (calls === 1) throw new Error("HTTP 429");
      if (calls === 2) throw new Error("HTTP 529");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(maxInFlight).toBe(1);
    expect(sleeps).toEqual([437.5, 875]);
  });

  it("cancelamento aborta o trabalho próprio", async () => {
    const pool = createVisualPools({ ffmpegLimit: 1, networkLimit: 1 });
    const ac = new AbortController();
    const killed: string[] = [];
    const pending = pool.encode(async () => {
      ac.abort();
      await delay(30);
      if (ac.signal.aborted) killed.push("ffmpeg");
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }, { signal: ac.signal });
    await expect(pending).rejects.toSatisfy((err) => isCancelledError(err) || err instanceof CancelledError);
    expect(killed).toEqual(["ffmpeg"]);
  });
});

describe("isVisualRetryable", () => {
  it("só 429 e 529 repetem", () => {
    expect(isVisualRetryable(new Error("HTTP 429"))).toBe(true);
    expect(isVisualRetryable(new Error("HTTP 529 overloaded"))).toBe(true);
    expect(isVisualRetryable(new Error("HTTP 401"))).toBe(false);
    expect(isVisualRetryable(new Error("HTTP 422"))).toBe(false);
  });
});
