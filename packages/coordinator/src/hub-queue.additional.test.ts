import { mkdtemp, rm } from "node:fs/promises";
import { getEventListeners } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { coordinatorForProject, createFileCoordinator } from "./index.ts";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitUntil(label: string, probe: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "coordinator-project-queue-"));
}

it("retorna metadados e posições FIFO para projetos, preservando entradas sem projectId", async () => {
  const root = await tempDir();
  const coordinator = createFileCoordinator(root, { limit: 1, pollMs: 5 });
  const blockerStarted = deferred();
  const releaseBlocker = deferred();
  const order: string[] = [];
  const blocker = coordinator.withSlot({ stage: "blocker" }, async () => {
    blockerStarted.resolve();
    await releaseBlocker.promise;
  });
  let firstRun: Promise<string> | undefined;
  let secondRun: Promise<string> | undefined;
  try {
    await blockerStarted.promise;
    firstRun = coordinator.run({
      id: "first-task", stage: "transcription", projectId: "project-a",
      build: async () => { order.push("first"); return "first"; },
    });
    await waitUntil("first project waiter", async () => (await coordinator.queue()).length === 1);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    secondRun = coordinator.withSlot(
      { stage: "render", projectId: "project-b" },
      async () => { order.push("second"); return "second"; },
    );
    await waitUntil("two queued projects", async () => (await coordinator.queue()).length === 2);

    const queue = await coordinator.queue();
    expect(queue).toHaveLength(2);
    expect(queue).toMatchObject([
      { projectId: "project-a", stage: "transcription", position: 1 },
      { projectId: "project-b", stage: "render", position: 2 },
    ]);
    expect(queue[0]?.at).toEqual(expect.any(Number));
    expect(queue[1]?.at).toEqual(expect.any(Number));

    // A caller using the old API remains visible, with no fabricated project id.
    const legacyController = new AbortController();
    const legacy = coordinator.withSlot({ stage: "legacy", signal: legacyController.signal }, () => "legacy");
    await waitUntil("legacy waiter", async () => (await coordinator.queue()).length === 3);
    const legacyEntry = (await coordinator.queue()).find((entry) => entry.stage === "legacy");
    expect(legacyEntry).toMatchObject({ stage: "legacy", position: 3 });
    expect(legacyEntry?.projectId).toBeUndefined();
    legacyController.abort();
    await expect(legacy).rejects.toMatchObject({ name: "CancelledError" });
    releaseBlocker.resolve();
    await Promise.all([firstRun, secondRun]);
    expect(order).toEqual(["first", "second"]);
  } finally {
    releaseBlocker.resolve();
    await Promise.all([blocker, ...(firstRun ? [firstRun] : []), ...(secondRun ? [secondRun] : [])]);
    await rm(root, { recursive: true, force: true });
  }
});

it("preserva a vez de lote depois de ceder uma passagem à prioridade interativa", async () => {
  const root = await tempDir();
  const coordinator = createFileCoordinator(root, { limit: 1, pollMs: 5 });
  const blockerStarted = deferred();
  const releaseBlocker = deferred();
  const batchStarted = deferred();
  const interactiveStarted = deferred();
  const releaseInteractive = deferred();
  const order: string[] = [];
  const blocker = coordinator.withSlot({ stage: "blocker" }, async () => {
    blockerStarted.resolve();
    await releaseBlocker.promise;
  });
  let batch: Promise<string> | undefined;
  let interactive: Promise<string> | undefined;
  let followupInteractive: Promise<string> | undefined;
  try {
    await blockerStarted.promise;
    batch = coordinator.withSlot({ stage: "batch", priority: "batch", projectId: "batch-project" }, () => {
      order.push("batch");
      batchStarted.resolve();
      return "batch";
    });
    await waitUntil("batch waiter", async () => (await coordinator.queue()).length === 1);
    interactive = coordinator.withSlot(
      { stage: "interactive", priority: "interactive", projectId: "interactive-project" },
      () => {
        order.push("interactive");
        interactiveStarted.resolve();
        return releaseInteractive.promise.then(() => "interactive");
      },
    );
    await waitUntil("interactive waiter", async () => (await coordinator.queue()).length === 2);

    expect(await coordinator.queue()).toMatchObject([
      { projectId: "interactive-project", stage: "interactive", position: 1 },
      { projectId: "batch-project", stage: "batch", position: 2 },
    ]);

    releaseBlocker.resolve();
    await interactiveStarted.promise;
    expect(order).toEqual(["interactive"]);
    followupInteractive = coordinator.withSlot(
      { stage: "interactive-followup", priority: "interactive", projectId: "followup-project" },
      () => { order.push("interactive-followup"); return "followup"; },
    );
    await waitUntil("follow-up interactive waiter", async () => (await coordinator.queue()).length === 2);
    expect(await coordinator.queue()).toMatchObject([
      { projectId: "batch-project", stage: "batch", position: 1 },
      { projectId: "followup-project", stage: "interactive-followup", position: 2 },
    ]);
    releaseInteractive.resolve();
    await batchStarted.promise;
    await Promise.all([batch, interactive, followupInteractive]);
    expect(order).toEqual(["interactive", "batch", "interactive-followup"]);
  } finally {
    releaseBlocker.resolve();
    releaseInteractive.resolve();
    await Promise.all([
      blocker,
      ...(batch ? [batch] : []),
      ...(interactive ? [interactive] : []),
      ...(followupInteractive ? [followupInteractive] : []),
    ]);
    await rm(root, { recursive: true, force: true });
  }
});

it("não anuncia na fila seguidores single-flight enquanto o proprietário está ativo", async () => {
  const root = await tempDir();
  const coordinator = createFileCoordinator(root, { limit: 1, pollMs: 5 });
  const ownerStarted = deferred();
  const releaseOwner = deferred();
  const followerController = new AbortController();
  let followerBuilds = 0;
  let owner: Promise<string> | undefined;
  let follower: Promise<string> | undefined;
  try {
    owner = coordinator.run({
      id: "shared-task", stage: "analysis", projectId: "owner-project",
      build: async () => { ownerStarted.resolve(); await releaseOwner.promise; return "owner"; },
    });
    await ownerStarted.promise;
    follower = coordinator.run({
      id: "shared-task", stage: "analysis", projectId: "follower-project",
      signal: followerController.signal,
      build: async () => { followerBuilds += 1; return "follower"; },
    });
    await waitUntil("single-flight follower polls the running owner", async () => (
      getEventListeners(followerController.signal, "abort").length > 0
    ));
    expect(await coordinator.queue()).toEqual([]);

    releaseOwner.resolve();
    await expect(owner).resolves.toBe("owner");
    await expect(follower).resolves.toBe("owner");
    expect(followerBuilds).toBe(0);
  } finally {
    releaseOwner.resolve();
    followerController.abort();
    await Promise.all([...(owner ? [owner] : []), ...(follower ? [follower] : [])]);
    await rm(root, { recursive: true, force: true });
  }
});

it("coordinatorForProject acrescenta metadado por padrão e permite uma substituição explícita", async () => {
  const root = await tempDir();
  const coordinator = createFileCoordinator(root, { limit: 1, pollMs: 5 });
  const scoped = coordinatorForProject(coordinator, "default-project")!;
  const readQueue = async () => {
    if (!scoped.queue) throw new Error("coordinatorForProject não repassou queue()");
    return scoped.queue();
  };
  const blockerStarted = deferred();
  const releaseBlocker = deferred();
  const blocker = coordinator.withSlot({ stage: "blocker" }, async () => {
    blockerStarted.resolve();
    await releaseBlocker.promise;
  });
  let defaultRun: Promise<string> | undefined;
  let overrideRun: Promise<string> | undefined;
  try {
    await blockerStarted.promise;
    defaultRun = scoped.run({ id: "default", stage: "default-stage", build: () => "default" });
    await waitUntil("default scoped waiter", async () => (await readQueue()).length === 1);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    overrideRun = scoped.run({ id: "override", stage: "override-stage", projectId: "explicit-project", build: () => "override" });
    await waitUntil("two scoped waiters", async () => (await readQueue()).length === 2);
    expect(await readQueue()).toMatchObject([
      { projectId: "default-project", stage: "default-stage", position: 1 },
      { projectId: "explicit-project", stage: "override-stage", position: 2 },
    ]);
  } finally {
    releaseBlocker.resolve();
    await Promise.all([blocker, ...(defaultRun ? [defaultRun] : []), ...(overrideRun ? [overrideRun] : [])]);
    await rm(root, { recursive: true, force: true });
  }
});
