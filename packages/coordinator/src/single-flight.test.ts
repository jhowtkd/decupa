import { chmod, mkdir, open, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { getEventListeners } from "node:events";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CancelledError } from "@decupa/queue";
import { describe, expect, it, vi } from "vitest";
import { createFileCoordinator } from "./index.ts";

function dir(): string {
  return join(tmpdir(), `coord-single-flight-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function outcome<T>(promise: Promise<T>): Promise<
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown }
> {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason: unknown) => ({ status: "rejected", reason }),
  );
}

async function waitUntil(label: string, probe: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timeout waiting for ${label}`);
}

type PersistedWaiter = { waiterId: string; taskId: string; bypassed?: boolean };

async function readWaiters(root: string): Promise<PersistedWaiter[]> {
  try {
    return JSON.parse(await readFile(join(root, "waiters.json"), "utf8")) as PersistedWaiter[];
  } catch {
    return [];
  }
}

describe("createFileCoordinator single-flight", () => {
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "preserva o erro do build e libera o slot se gravar failed falhar",
    async () => {
      const root = dir();
      const tasksDir = join(root, "tasks");
      await mkdir(root, { recursive: true });
      const coordinator = createFileCoordinator(root, { limit: 1, leaseMs: 60_000, pollMs: 5 });
      const originalError = new Error("build original failure");
      try {
        await expect(coordinator.run({
          id: "readonly-task-record",
          stage: "build",
          build: async () => {
            await chmod(tasksDir, 0o555);
            throw originalError;
          },
        })).rejects.toBe(originalError);
        expect(await readdir(join(root, "slots"))).toEqual([]);
      } finally {
        await chmod(tasksDir, 0o755).catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("preserva bypassed quando seguidor reentra após falha do líder", async () => {
    const root = dir();
    await mkdir(root, { recursive: true });
    const clock = { now: 1_000 };
    const coordinator = createFileCoordinator(root, { limit: 1, leaseMs: 60_000, pollMs: 5, now: () => clock.now });
    const releaseBlocker = deferred();
    const blockerStarted = deferred();
    const releaseLeader = deferred();
    const leaderStarted = deferred();
    const ownerError = new Error("leader failed");
    let blockerResult: ReturnType<typeof outcome<void>> | undefined;
    let leaderResult: ReturnType<typeof outcome<string>> | undefined;
    let followerResult: ReturnType<typeof outcome<string>> | undefined;
    let interactiveResult: ReturnType<typeof outcome<string>> | undefined;
    let followerWaiterId = "";
    const fixtureSlotPath = join(root, "slots", "0.json");
    try {
      blockerResult = outcome(coordinator.withSlot({ stage: "blocker" }, async () => {
        blockerStarted.resolve();
        await releaseBlocker.promise;
      }));
      await blockerStarted.promise;

      leaderResult = outcome(coordinator.run({
        id: "single-task",
        stage: "build",
        priority: "batch",
        build: async () => {
          leaderStarted.resolve();
          await releaseLeader.promise;
          throw ownerError;
        },
      }));
      await waitUntil("leader queued behind blocker", async () => (await readWaiters(root)).length === 1);
      const leaderWaiterId = (await readWaiters(root))[0]?.waiterId;

      clock.now += 1;
      followerResult = outcome(coordinator.run({
        id: "single-task",
        stage: "build",
        priority: "batch",
        build: () => "follower-retry",
      }));
      await waitUntil("follower queued behind blocker", async () => (await readWaiters(root)).length === 2);
      followerWaiterId = (await readWaiters(root)).find((waiter) => waiter.waiterId !== leaderWaiterId)?.waiterId ?? "";
      expect(followerWaiterId).not.toBe("");

      clock.now += 1;
      interactiveResult = outcome(coordinator.run({
        id: "interactive-task",
        stage: "build",
        priority: "interactive",
        build: async () => {
          const queue = await readWaiters(root);
          expect(queue.find((waiter) => waiter.waiterId === leaderWaiterId)?.bypassed).toBe(true);
          expect(queue.find((waiter) => waiter.waiterId === followerWaiterId)?.bypassed).toBe(true);
          return "interactive-result";
        },
      }));
      await waitUntil("interactive queued", async () => (await readWaiters(root)).length === 3);
      releaseBlocker.resolve();
      expect(await interactiveResult).toEqual({ status: "fulfilled", value: "interactive-result" });
      await leaderStarted.promise;

      // O seguidor já observou o lease running e saiu da fila. Substitua o slot
      // por uma lease externa para que a reentrada fique visível em disco.
      await waitUntil("follower leaves the queue behind running owner", async () => (await readWaiters(root)).length === 0);
      await writeFile(fixtureSlotPath, JSON.stringify({ leaseId: "external-fixture", until: clock.now + 120_000 }));
      releaseLeader.reject(ownerError);
      expect(await leaderResult).toEqual({ status: "rejected", reason: ownerError });

      await waitUntil("follower re-enters after owner failure", async () => (
        await readWaiters(root)
      ).some((waiter) => waiter.waiterId === followerWaiterId));
      const reenteredFollower = (await readWaiters(root)).find((waiter) => waiter.waiterId === followerWaiterId);
      expect(reenteredFollower?.bypassed).toBe(true);

      await unlink(fixtureSlotPath);
      expect(await followerResult).toEqual({ status: "fulfilled", value: "follower-retry" });
    } finally {
      releaseBlocker.resolve();
      releaseLeader.reject(ownerError);
      await unlink(fixtureSlotPath).catch(() => undefined);
      if (blockerResult || leaderResult || followerResult || interactiveResult) {
        await Promise.all([blockerResult, leaderResult, followerResult, interactiveResult].filter(Boolean));
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("heartbeat de lease antiga não reassume slot tomado por outra tarefa", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const root = dir();
    await mkdir(root, { recursive: true });
    const leaseMs = 60_000;
    const owner = createFileCoordinator(root, { limit: 1, leaseMs, pollMs: 5 });
    const contender = createFileCoordinator(root, { limit: 1, leaseMs, pollMs: 5 });
    const follower = createFileCoordinator(root, { limit: 1, leaseMs, pollMs: 5 });
    const queued = createFileCoordinator(root, { limit: 1, leaseMs, pollMs: 5 });
    const ownerStarted = deferred();
    const releaseOwner = deferred();
    const contenderStarted = deferred();
    const releaseContender = deferred();
    const queuedStarted = deferred();
    const followerController = new AbortController();
    let ownerResult: ReturnType<typeof outcome<string>> | undefined;
    let contenderResult: ReturnType<typeof outcome<string>> | undefined;
    let queuedResult: ReturnType<typeof outcome<string>> | undefined;
    let followerResult: ReturnType<typeof outcome<string>> | undefined;
    let queuedDidStart = false;
    let ownerLeaseId = "";
    let ownerBuilds = 0;
    const taskPath = join(root, "tasks", `${encodeURIComponent("heartbeat-owner")}.json`);
    const slotPath = join(root, "slots", "0.json");
    try {
      ownerResult = outcome(owner.run({
        id: "heartbeat-owner",
        stage: "build",
        build: async () => {
          ownerBuilds += 1;
          ownerStarted.resolve();
          await releaseOwner.promise;
          return "old-owner-result";
        },
      }));
      await ownerStarted.promise;
      const lockHandle = await open(join(root, ".lock"), "wx");
      try {
        await lockHandle.writeFile(`${process.pid} ${hostname()}\n`, "utf8");
        const task = JSON.parse(await readFile(taskPath, "utf8")) as { leaseId: string; leaseUntil: number };
        const slot = JSON.parse(await readFile(slotPath, "utf8")) as { leaseId: string; until: number };
        ownerLeaseId = task.leaseId;
        const expiredAt = Date.now() - 1;
        await writeFile(taskPath, JSON.stringify({ ...task, leaseUntil: expiredAt }));
        await writeFile(slotPath, JSON.stringify({ ...slot, until: expiredAt }));
      } finally {
        await lockHandle.close();
        await unlink(join(root, ".lock"));
      }

      contenderResult = outcome(contender.withSlot({ stage: "different-task" }, async () => {
        contenderStarted.resolve();
        await releaseContender.promise;
        return "contender-result";
      }));
      await contenderStarted.promise;
      const contenderSlot = JSON.parse(await readFile(slotPath, "utf8")) as { leaseId: string; until: number };
      expect(contenderSlot.leaseId).not.toBe(JSON.parse(await readFile(taskPath, "utf8")).leaseId);

      queuedResult = outcome(queued.withSlot({ stage: "must-wait" }, () => {
        queuedDidStart = true;
        queuedStarted.resolve();
        return "queued-result";
      }));
      await waitUntil("third task waits behind contender", async () => (await readWaiters(root)).length === 1);

      // Advance only the interval clock so A's real heartbeat callback runs
      // after B owns the slot, without making the fixture lease expire.
      await vi.advanceTimersByTimeAsync(Math.max(10, Math.floor(leaseMs / 3)));
      await waitUntil("owner TaskRecord heartbeat completes", async () => {
        const current = JSON.parse(await readFile(taskPath, "utf8")) as { leaseUntil: number };
        return current.leaseUntil > Date.now();
      });
      const taskAfterBeat = JSON.parse(await readFile(taskPath, "utf8")) as { leaseId: string; leaseUntil: number };
      const slotAfterBeat = JSON.parse(await readFile(slotPath, "utf8")) as { leaseId: string; until: number };
      expect(taskAfterBeat.leaseId).toBe(ownerLeaseId);
      expect(taskAfterBeat.leaseUntil).toBeGreaterThan(Date.now());
      expect(slotAfterBeat.leaseId).toBe(contenderSlot.leaseId);

      followerResult = outcome(follower.run({
        id: "heartbeat-owner",
        stage: "build",
        signal: followerController.signal,
        build: async () => {
          ownerBuilds += 1;
          return "duplicate-owner-result";
        },
      }));
      await waitUntil("same-key follower waits on renewed task lease", async () => (
        getEventListeners(followerController.signal, "abort").length > 0
      ));

      releaseOwner.resolve();
      expect(await ownerResult).toEqual({ status: "fulfilled", value: "old-owner-result" });
      expect(await followerResult).toEqual({ status: "fulfilled", value: "old-owner-result" });
      expect(ownerBuilds).toBe(1);
      expect(queuedDidStart).toBe(false);

      releaseContender.resolve();
      expect(await contenderResult).toEqual({ status: "fulfilled", value: "contender-result" });
      await queuedStarted.promise;
      expect(await queuedResult).toEqual({ status: "fulfilled", value: "queued-result" });
    } finally {
      releaseOwner.resolve();
      releaseContender.resolve();
      followerController.abort();
      await unlink(join(root, ".lock")).catch(() => undefined);
      if (ownerResult || contenderResult || queuedResult || followerResult) {
        await Promise.all([ownerResult, contenderResult, queuedResult, followerResult].filter(Boolean));
      }
      await rm(root, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("instâncias diferentes na mesma pasta compartilham o resultado sem repetir build", async () => {
    const root = dir();
    await mkdir(root, { recursive: true });
    const owner = createFileCoordinator(root, { limit: 2, leaseMs: 60_000, pollMs: 5 });
    const follower = createFileCoordinator(root, { limit: 2, leaseMs: 60_000, pollMs: 5 });
    const started = deferred();
    const release = deferred();
    const followerController = new AbortController();
    let ownerResult: ReturnType<typeof outcome<string | { artifact: string }>> | undefined;
    let followerResult: ReturnType<typeof outcome<string | { artifact: string }>> | undefined;
    let builds = 0;
    try {
      ownerResult = outcome(owner.run({
        id: "same-task",
        stage: "build",
        build: async () => {
          builds += 1;
          started.resolve();
          await release.promise;
          return { artifact: "shared" };
        },
      }));
      await started.promise;
      followerResult = outcome(follower.run({
        id: "same-task",
        stage: "build",
        signal: followerController.signal,
        build: async () => {
          builds += 1;
          return { artifact: "duplicate" };
        },
      }));
      await waitUntil("follower polling while owner is running", async () => getEventListeners(followerController.signal, "abort").length > 0);
      release.resolve();

      expect(await ownerResult).toEqual({ status: "fulfilled", value: { artifact: "shared" } });
      expect(await followerResult).toEqual({ status: "fulfilled", value: { artifact: "shared" } });
      expect(builds).toBe(1);
    } finally {
      release.resolve();
      followerController.abort();
      if (ownerResult || followerResult) await Promise.all([ownerResult, followerResult].filter(Boolean));
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cancelar um seguidor não cancela o proprietário", async () => {
    const root = dir();
    await mkdir(root, { recursive: true });
    const owner = createFileCoordinator(root, { limit: 2, leaseMs: 60_000, pollMs: 5 });
    const follower = createFileCoordinator(root, { limit: 2, leaseMs: 60_000, pollMs: 5 });
    const started = deferred();
    const release = deferred();
    const controller = new AbortController();
    let ownerResult: ReturnType<typeof outcome<string>> | undefined;
    let followerResult: ReturnType<typeof outcome<string>> | undefined;
    let builds = 0;
    let ownerFinished = false;
    try {
      ownerResult = outcome(owner.run({
        id: "cancel-follower",
        stage: "build",
        build: async () => {
          builds += 1;
          started.resolve();
          await release.promise;
          ownerFinished = true;
          return "owner-result";
        },
      }));
      await started.promise;
      followerResult = outcome(follower.run({
        id: "cancel-follower",
        stage: "build",
        signal: controller.signal,
        build: async () => {
          builds += 1;
          return "duplicate";
        },
      }));
      await waitUntil("follower polling", async () => getEventListeners(controller.signal, "abort").length > 0);
      controller.abort();

      const cancelled = await followerResult;
      expect(cancelled.status).toBe("rejected");
      if (cancelled.status === "rejected") expect(cancelled.reason).toBeInstanceOf(CancelledError);
      expect(ownerFinished).toBe(false);
      release.resolve();
      expect(await ownerResult).toMatchObject({ status: "fulfilled", value: "owner-result" });
      expect(builds).toBe(1);
    } finally {
      release.resolve();
      controller.abort();
      if (ownerResult || followerResult) await Promise.all([ownerResult, followerResult].filter(Boolean));
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["failure", "cancellation"] as const)(
    "falha/cancelamento do proprietário libera o lease e o seguidor retoma sem expiração (%s)",
    async (mode) => {
      const root = dir();
      await mkdir(root, { recursive: true });
      const clock = { now: 1_000 };
      const owner = createFileCoordinator(root, { limit: 2, leaseMs: 60_000, pollMs: 5, now: () => clock.now });
      const follower = createFileCoordinator(root, { limit: 2, leaseMs: 60_000, pollMs: 5, now: () => clock.now });
      const started = deferred();
      const failOwner = deferred();
      void failOwner.promise.catch(() => undefined);
      const ownerController = new AbortController();
      const followerController = new AbortController();
      const ownerError = mode === "failure" ? new Error("owner failed") : new CancelledError("owner cancelled");
      let retryObserved = false;
      let ownerResult: ReturnType<typeof outcome<string>> | undefined;
      let followerResult: ReturnType<typeof outcome<string>> | undefined;
      let builds = 0;
      try {
        ownerResult = outcome(owner.run({
          id: `owner-${mode}`,
          stage: "build",
          signal: ownerController.signal,
          build: async () => {
            builds += 1;
            started.resolve();
            if (mode === "cancellation") {
              await new Promise<never>((_resolve, reject) => {
                ownerController.signal.addEventListener("abort", () => reject(new CancelledError("owner cancelled")), { once: true });
              });
            }
            await failOwner.promise;
            throw ownerError;
          },
        }));
        await started.promise;
        followerResult = outcome(follower.run({
          id: `owner-${mode}`,
          stage: "build",
          signal: followerController.signal,
          build: async () => {
            builds += 1;
            retryObserved = true;
            return "retry-result";
          },
        }));
        await waitUntil("follower polling before owner ends", async () => getEventListeners(followerController.signal, "abort").length > 0);
        if (mode === "cancellation") ownerController.abort();
        else failOwner.reject(ownerError);

        const ownerSettled = await ownerResult;
        expect(ownerSettled.status).toBe("rejected");
        if (ownerSettled.status === "rejected") {
          if (mode === "failure") expect(ownerSettled.reason).toBe(ownerError);
          else expect(ownerSettled.reason).toBeInstanceOf(CancelledError);
        }
        await waitUntil("follower retries before lease expiry", async () => retryObserved);
        expect(clock.now).toBe(1_000);
        expect(await followerResult).toEqual({ status: "fulfilled", value: "retry-result" });
        expect(builds).toBe(2);
      } finally {
        failOwner.reject(ownerError);
        ownerController.abort();
        followerController.abort();
        if (ownerResult || followerResult) await Promise.all([ownerResult, followerResult].filter(Boolean));
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each(["running", "completed"] as const)(
    "falha velha não altera a execução nova enquanto ela está %s",
    async (freshState) => {
      const root = dir();
      await mkdir(root, { recursive: true });
      const clock = { now: 1_000 };
      const stale = createFileCoordinator(root, { limit: 2, leaseMs: 50, pollMs: 5, now: () => clock.now });
      const fresh = createFileCoordinator(root, { limit: 2, leaseMs: 50, pollMs: 5, now: () => clock.now });
      const staleStarted = deferred();
      const failStale = deferred();
      const freshStarted = deferred();
      const releaseFresh = deferred();
      const staleError = new Error("stale execution failed");
      const taskPath = join(root, "tasks", `${encodeURIComponent("takeover")}.json`);
      let staleResult: ReturnType<typeof outcome<string>> | undefined;
      let freshResult: ReturnType<typeof outcome<string>> | undefined;
      let builds = 0;
      try {
        staleResult = outcome(stale.run({
          id: "takeover",
          stage: "build",
          build: async () => {
            builds += 1;
            staleStarted.resolve();
            await failStale.promise;
            throw staleError;
          },
        }));
        await staleStarted.promise;
        const oldRecord = JSON.parse(await readFile(taskPath, "utf8")) as { leaseId: string | null };
        expect(oldRecord.leaseId).toBeTruthy();
        clock.now += 100;
        freshResult = outcome(fresh.run({
          id: "takeover",
          stage: "build",
          build: async () => {
            builds += 1;
            freshStarted.resolve();
            await releaseFresh.promise;
            return "fresh-result";
          },
        }));
        await freshStarted.promise;

        const runningRecord = JSON.parse(await readFile(taskPath, "utf8")) as {
          status: string;
          leaseId: string | null;
        };
        expect(runningRecord.status).toBe("running");
        expect(runningRecord.leaseId).toBeTruthy();
        expect(runningRecord.leaseId).not.toBe(oldRecord.leaseId);

        if (freshState === "completed") {
          releaseFresh.resolve();
          expect(await freshResult).toEqual({ status: "fulfilled", value: "fresh-result" });
        }
        failStale.reject(staleError);

        expect(await staleResult).toEqual({ status: "rejected", reason: staleError });
        const afterStaleFailure = JSON.parse(await readFile(taskPath, "utf8")) as {
          status: string;
          leaseId: string | null;
          result?: unknown;
        };
        if (freshState === "running") {
          expect(afterStaleFailure.status).toBe("running");
          expect(afterStaleFailure.leaseId).toBe(runningRecord.leaseId);
          const slots = await Promise.all([0, 1].map(async (index) => {
            try {
              return JSON.parse(await readFile(join(root, "slots", `${index}.json`), "utf8")) as { leaseId: string };
            } catch {
              return null;
            }
          }));
          expect(slots.some((slot) => slot?.leaseId === runningRecord.leaseId)).toBe(true);
          releaseFresh.resolve();
        } else {
          expect(afterStaleFailure.status).toBe("completed");
          expect(afterStaleFailure.result).toBe("fresh-result");
        }

        expect(await freshResult).toEqual({ status: "fulfilled", value: "fresh-result" });
        expect(await fresh.run({ id: "takeover", stage: "build", build: () => "replayed-wrong" })).toBe("fresh-result");
        expect(builds).toBe(2);
      } finally {
        failStale.reject(staleError);
        releaseFresh.resolve();
        if (staleResult || freshResult) await Promise.all([staleResult, freshResult].filter(Boolean));
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
