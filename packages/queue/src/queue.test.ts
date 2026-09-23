import { describe, expect, it } from "vitest";
import { CancelledError, createLimitedQueue, isCancelledError } from "./index.ts";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createLimitedQueue", () => {
  it("mantém em execução no máximo o limite e devolve na ordem de entrada", async () => {
    const queue = createLimitedQueue(2);
    const started: number[] = [];
    const finished: number[] = [];
    const results = await queue.map([1, 2, 3, 4], async (n) => {
      started.push(n);
      expect(queue.inFlight).toBeLessThanOrEqual(2);
      await delay(n === 2 || n === 4 ? 5 : 25);
      finished.push(n);
      return n * 10;
    });
    expect(results).toEqual([10, 20, 30, 40]);
    expect(queue.maxInFlight).toBeLessThanOrEqual(2);
    expect(queue.maxInFlight).toBe(2);
    expect(finished[0]).not.toBe(1);
    expect(new Set(started)).toEqual(new Set([1, 2, 3, 4]));
  });

  it("limit=1 serializa como o caminho legado de controle", async () => {
    const queue = createLimitedQueue(1);
    const order: number[] = [];
    const results = await queue.map([1, 2, 3], async (n) => {
      order.push(n);
      expect(queue.inFlight).toBe(1);
      await delay(5);
      return n;
    });
    expect(results).toEqual([1, 2, 3]);
    expect(order).toEqual([1, 2, 3]);
    expect(queue.maxInFlight).toBe(1);
  });

  it("cancelado na espera não vaza slot nem impede o próximo", async () => {
    const queue = createLimitedQueue(1);
    const controller = new AbortController();
    const slow = queue.run(async () => {
      await delay(40);
      return "slow";
    });
    const blocked = queue.run(async () => "não deveria", { signal: controller.signal });
    await delay(5);
    controller.abort();
    await expect(blocked).rejects.toSatisfy((err) => isCancelledError(err));
    const third = queue.run(async () => "third");
    await expect(slow).resolves.toBe("slow");
    await expect(third).resolves.toBe("third");
    expect(queue.maxInFlight).toBe(1);
    expect(queue.inFlight).toBe(0);
  });

  it("cancelar um consumidor não cancela trabalho compartilhado", async () => {
    const queue = createLimitedQueue(1);
    let runs = 0;
    const work = async () => {
      runs += 1;
      await delay(30);
      return "shared";
    };
    const controller = new AbortController();
    const keeper = queue.run(work, { key: "job-a" });
    const follower = queue.run(work, { key: "job-a", signal: controller.signal });
    await delay(5);
    controller.abort();
    await expect(follower).rejects.toBeInstanceOf(CancelledError);
    await expect(keeper).resolves.toBe("shared");
    expect(runs).toBe(1);
  });

  it("primeiro cancelado preserva trabalho compartilhado para seguidor ativo", async () => {
    const queue = createLimitedQueue(1);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const holder = queue.run(() => held);
    const controller = new AbortController();
    let runs = 0;
    const work = async () => {
      runs += 1;
      return "shared";
    };
    const first = queue.run(work, { key: "job-a", signal: controller.signal });
    await delay(5);
    const follower = queue.run(work, { key: "job-a" });
    controller.abort();
    await expect(first).rejects.toBeInstanceOf(CancelledError);
    release();
    await expect(follower).resolves.toBe("shared");
    await expect(holder).resolves.toBeUndefined();
    expect(runs).toBe(1);
  });

  it("recusa limite menor que 1", () => {
    expect(() => createLimitedQueue(0)).toThrow(/limite/);
  });

  it("saturação cresce a fila de espera e não o número de processos", async () => {
    const queue = createLimitedQueue(1);
    await queue.map([1, 2, 3, 4, 5], async () => delay(20));
    expect(queue.maxInFlight).toBe(1);
    expect(queue.maxWaiting).toBeGreaterThanOrEqual(4);
    expect(queue.waiting).toBe(0);
  });
});
