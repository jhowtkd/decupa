import { describe, expect, it } from "vitest";
import { createVisualPools } from "./visual-pool.ts";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("P2 visual window residency limit", () => {
  it("defaults to four windows when no option is provided", async () => {
    const pool = createVisualPools({ ffmpegLimit: 2, networkLimit: 2 });
    const blocked = deferred();
    const fourStarted = deferred();
    let started = 0;
    let maximum = 0;
    let active = 0;
    const mapped = pool.mapWindows(Array.from({ length: 20 }, (_, i) => i), async (n) => {
      active += 1;
      maximum = Math.max(maximum, active);
      started += 1;
      if (started === 4) fourStarted.resolve();
      try {
        await blocked.promise;
        return n;
      } finally {
        active -= 1;
      }
    });
    try {
      await fourStarted.promise;
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(maximum).toBe(4);
      expect(started).toBe(4);
    } finally {
      blocked.resolve();
    }
    await mapped;
  });

  it.each([60, 600])("keeps %i blocked windows within limits 2, 3 and 4", async (count) => {
    for (const windowLimit of [2, 3, 4]) {
    const pool = createVisualPools({ ffmpegLimit: 2, networkLimit: 2, windowLimit });
    const blocked = deferred();
    const requestStarted = deferred();
    let active = 0;
    let maximum = 0;
    let extracted = 0;
    const running = pool.mapWindows(Array.from({ length: count }, (_, i) => i), async (index) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await pool.encode(() => { extracted += 1; return index; });
      await pool.request(async () => {
        requestStarted.resolve();
        await blocked.promise;
        return index;
      });
      active -= 1;
      return index;
    });

    try {
      await requestStarted.promise;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(maximum).toBeLessThanOrEqual(windowLimit);
      expect(extracted).toBeLessThanOrEqual(windowLimit);
      expect(extracted).toBe(windowLimit);
    } finally {
      blocked.resolve();
      await running;
    }
    }
  });

  it("preserves input order and rejects mapper errors after active work settles", async () => {
    const pool = createVisualPools({ ffmpegLimit: 1, networkLimit: 1, windowLimit: 2 });
    let active = 0;
    let settled = 0;
    const gate = deferred();
    const result = pool.mapWindows([0, 1, 2, 3], async (n) => {
      active += 1;
      try {
        if (n === 0) await gate.promise;
        if (n === 1) throw new Error("mapper failure");
        await Promise.resolve();
        return n;
      } finally {
        active -= 1;
        settled += 1;
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(active).toBeLessThanOrEqual(2);
    gate.resolve();
    await expect(result).rejects.toThrow("mapper failure");
    expect(settled).toBeGreaterThanOrEqual(2);

    await expect(pool.mapWindows([3, 1, 2], async (n) => n * 10)).resolves.toEqual([30, 10, 20]);
  });

  it("shares one residency budget across concurrent mapWindows calls", async () => {
    const pool = createVisualPools({ ffmpegLimit: 2, networkLimit: 2, windowLimit: 3 });
    const blocked = deferred();
    const entered = deferred();
    let active = 0;
    let maximum = 0;
    const map = (base: number) => pool.mapWindows([0, 1, 2, 3, 4], async (n) => {
      active += 1;
      maximum = Math.max(maximum, active);
      if (active >= 3) entered.resolve();
      try {
        await blocked.promise;
        return base + n;
      } finally {
        active -= 1;
      }
    });
    const first = map(0);
    const second = map(10);
    try {
      await entered.promise;
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(maximum).toBe(3);
    } finally {
      blocked.resolve();
    }
    await expect(Promise.all([first, second])).resolves.toEqual([
      [0, 1, 2, 3, 4], [10, 11, 12, 13, 14],
    ]);
  });

  it("stops admitting queued work from a failed mapper after concurrent slots free", async () => {
    const pool = createVisualPools({ ffmpegLimit: 1, networkLimit: 1, windowLimit: 3 });
    const releaseA = [deferred(), deferred(), deferred()];
    const aThreeStarted = deferred();
    const bZeroFailed = deferred();
    let aStarted = 0;
    const bStarted: number[] = [];
    const callA = pool.mapWindows([0, 1, 2], async (n) => {
      aStarted += 1;
      if (aStarted === 3) aThreeStarted.resolve();
      await releaseA[n]!.promise;
      return `A${n}`;
    });
    const callB = pool.mapWindows([0, 1, 2], async (n) => {
      bStarted.push(n);
      if (n === 0) {
        bZeroFailed.resolve();
        throw new Error("B0 failed");
      }
      return `B${n}`;
    });

    try {
      await aThreeStarted.promise;
      releaseA[0]!.resolve();
      await bZeroFailed.promise;
      releaseA[1]!.resolve();
      releaseA[2]!.resolve();
      await expect(callB).rejects.toThrow("B0 failed");
      await expect(callA).resolves.toEqual(["A0", "A1", "A2"]);
      expect(bStarted).toEqual([0]);
    } finally {
      releaseA.forEach((gate) => gate.resolve());
    }
  });

  it("settles a failed call without waiting for its queued mapper to acquire a slot", async () => {
    const pool = createVisualPools({ ffmpegLimit: 1, networkLimit: 1, windowLimit: 3 });
    const releaseA = Array.from({ length: 6 }, () => deferred());
    const releaseB = [deferred(), deferred(), deferred()];
    const firstThreeAStarted = deferred();
    const firstThreeBStarted = deferred();
    const aNextStarted = [deferred(), deferred(), deferred()];
    let aInitialStarted = 0;
    let bInitialStarted = 0;
    let bNextStarted = 0;

    const callA = pool.mapWindows(Array.from({ length: 6 }, (_, i) => i), async (n) => {
      if (n < 3) {
        aInitialStarted += 1;
        if (aInitialStarted === 3) firstThreeAStarted.resolve();
      } else {
        aNextStarted[n - 3]!.resolve();
      }
      await releaseA[n]!.promise;
      return `A${n}`;
    });
    const callB = pool.mapWindows(Array.from({ length: 6 }, (_, i) => i), async (n) => {
      if (n < 3) {
        bInitialStarted += 1;
        if (bInitialStarted === 3) firstThreeBStarted.resolve();
        await releaseB[n]!.promise;
        if (n === 1) throw new Error("B1 failed");
        return `B${n}`;
      }
      bNextStarted += 1;
      return `B${n}`;
    });
    const bSettled = callB.then(() => true, () => true);

    try {
      await firstThreeAStarted.promise;
      // Let all three B workers enqueue behind A's active windows.
      await new Promise((resolve) => setTimeout(resolve, 10));
      releaseA[0]!.resolve();
      releaseA[1]!.resolve();
      releaseA[2]!.resolve();
      await firstThreeBStarted.promise;
      // A3/A4/A5 now wait behind active B0/B1/B2.
      await new Promise((resolve) => setTimeout(resolve, 10));

      releaseB[0]!.resolve();
      await aNextStarted[0]!.promise;
      // B0's worker queues B3 behind the already waiting A4/A5.
      await new Promise((resolve) => setTimeout(resolve, 10));
      releaseB[1]!.resolve();
      await aNextStarted[1]!.promise;
      releaseB[2]!.resolve();
      await aNextStarted[2]!.promise;

      const settledBeforeReleasingA = await Promise.race([
        bSettled,
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 30)),
      ]);
      expect(settledBeforeReleasingA).toBe(true);
      expect(bNextStarted).toBe(0);
    } finally {
      releaseA.forEach((gate) => gate.resolve());
      releaseB.forEach((gate) => gate.resolve());
      await Promise.allSettled([callA, callB]);
    }
    await expect(callA).resolves.toEqual(["A0", "A1", "A2", "A3", "A4", "A5"]);
    await expect(callB).rejects.toThrow("B1 failed");
  });

  it("keeps the slot through publication after the network request resolves", async () => {
    const pool = createVisualPools({ ffmpegLimit: 2, networkLimit: 2, windowLimit: 2 });
    const publish = deferred();
    const twoPublished = deferred();
    let publicationWaiting = 0;
    let requests = 0;
    const mapped = pool.mapWindows([0, 1, 2, 3], async (n) => {
      await pool.request(() => { requests += 1; return n; });
      publicationWaiting += 1;
      if (publicationWaiting === 2) twoPublished.resolve();
      await publish.promise;
      publicationWaiting -= 1;
      return n;
    });
    try {
      await twoPublished.promise;
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(requests).toBe(2);
      expect(publicationWaiting).toBe(2);
    } finally {
      publish.resolve();
    }
    await expect(mapped).resolves.toEqual([0, 1, 2, 3]);
  });

  it("cancels admitted windows without starting the backlog and reuses the pool", async () => {
    const pool = createVisualPools({ ffmpegLimit: 2, networkLimit: 2, windowLimit: 3 });
    const controller = new AbortController();
    const threeStarted = deferred();
    let started = 0;
    const cancelled = pool.mapWindows(Array.from({ length: 60 }, (_, i) => i), async (_n, _i) => {
      started += 1;
      if (started === 3) threeStarted.resolve();
      await new Promise<void>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new Error("cooperative stop");
    }, { signal: controller.signal });

    await threeStarted.promise;
    controller.abort();
    await expect(cancelled).rejects.toThrow();
    expect(started).toBe(3);
    await expect(pool.mapWindows([1, 2], async (n) => n)).resolves.toEqual([1, 2]);
  });

  it("removes an aborted caller waiting behind another call's slots", async () => {
    const pool = createVisualPools({ ffmpegLimit: 1, networkLimit: 1, windowLimit: 2 });
    const blocked = deferred();
    const firstTwoStarted = deferred();
    let firstStarted = 0;
    let secondStarted = 0;
    const first = pool.mapWindows([0, 1], async (n) => {
      firstStarted += 1;
      if (firstStarted === 2) firstTwoStarted.resolve();
      await blocked.promise;
      return n;
    });
    const controller = new AbortController();
    const second = pool.mapWindows([2, 3], async (n) => {
      secondStarted += 1;
      return n;
    }, { signal: controller.signal });
    try {
      await firstTwoStarted.promise;
      await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort();
      await expect(second).rejects.toThrow();
      expect(secondStarted).toBe(0);
    } finally {
      blocked.resolve();
    }
    await expect(first).resolves.toEqual([0, 1]);
    await expect(pool.mapWindows([4], async (n) => n)).resolves.toEqual([4]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid windowLimit %s", (windowLimit) => {
    expect(() => createVisualPools({ ffmpegLimit: 1, networkLimit: 1, windowLimit })).toThrow();
  });
});
