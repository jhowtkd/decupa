import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createFileCoordinator } from "./index.ts";

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
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

type Holder = { projectId?: string; stage?: string; startedAt?: number };
function holdersOf(coordinator: ReturnType<typeof createFileCoordinator>): Promise<Holder[]> {
  return (coordinator as unknown as { holders(): Promise<Holder[]> }).holders();
}

it("expõe slot ativo com metadados enquanto o mesmo Projeto também tem waiter, após heartbeat", async () => {
  const root = await mkdtemp(join(tmpdir(), "coordinator-holders-heartbeat-"));
  const coordinator = createFileCoordinator(root, { limit: 1, leaseMs: 60, pollMs: 5 });
  const activeStarted = deferred();
  const releaseActive = deferred();
  const active = coordinator.withSlot({ projectId: "project-a", stage: "transcription" }, async () => {
    activeStarted.resolve();
    await releaseActive.promise;
  });
  let sameProjectWaiter: Promise<void> | undefined;
  try {
    await activeStarted.promise;
    sameProjectWaiter = coordinator.withSlot({ projectId: "project-a", stage: "rendering" }, () => undefined);
    await waitUntil("waiter for active project", async () => (await coordinator.queue()).length === 1);
    const beforeBeat = await holdersOf(coordinator);
    expect(beforeBeat).toHaveLength(1);
    expect(beforeBeat[0]).toMatchObject({ projectId: "project-a", stage: "transcription" });
    expect(beforeBeat[0]?.startedAt).toEqual(expect.any(Number));

    // Passa mais de um lease. O heartbeat deve renovar até, e sem apagar os
    // metadados observáveis do Slot.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const afterBeat = await holdersOf(coordinator);
    expect(afterBeat).toMatchObject([
      { projectId: "project-a", stage: "transcription", startedAt: beforeBeat[0]?.startedAt },
    ]);
    expect(await coordinator.queue()).toMatchObject([
      { projectId: "project-a", stage: "rendering", position: 1 },
    ]);
  } finally {
    releaseActive.resolve();
    await Promise.all([active, ...(sameProjectWaiter ? [sameProjectWaiter] : [])]);
    await rm(root, { recursive: true, force: true });
  }
});

it("preserva holder legado sem projectId e remove slot cuja lease expirou", async () => {
  const root = await mkdtemp(join(tmpdir(), "coordinator-holders-legacy-"));
  let clock = 1_000;
  const coordinator = createFileCoordinator(root, { limit: 1, leaseMs: 50, pollMs: 5, now: () => clock });
  const started = deferred();
  const release = deferred();
  const legacy = coordinator.withSlot({ stage: "legacy" }, async () => {
    started.resolve();
    await release.promise;
  });
  try {
    await started.promise;
    const current = await holdersOf(coordinator);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ stage: "legacy", startedAt: 1_000 });
    expect(current[0]?.projectId).toBeUndefined();

    clock = 1_051;
    expect(await holdersOf(coordinator)).toEqual([]);
  } finally {
    release.resolve();
    await legacy;
    await rm(root, { recursive: true, force: true });
  }
});
