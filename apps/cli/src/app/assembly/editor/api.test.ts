import { afterEach, expect, it, vi } from "vitest";
import { createProjectPoller } from "./api.js";

afterEach(() => vi.useRealTimers());

it("mantém uma consulta por intervalo mesmo com notificações durante refresh", async () => {
  vi.useFakeTimers();
  let busy = true;
  const refresh = vi.fn(async () => { poller.schedule(); });
  const poller = createProjectPoller({ refresh, isBusy: () => busy, interval: 1000 });
  for (let i = 0; i < 10; i++) poller.schedule();
  await vi.advanceTimersByTimeAsync(5000);
  expect(refresh).toHaveBeenCalledTimes(5);
  busy = false;
  await vi.advanceTimersByTimeAsync(10000);
  expect(refresh).toHaveBeenCalledTimes(6);
  expect(vi.getTimerCount()).toBe(0);
});

it("não sobrepõe consultas lentas e retoma após falha de rede", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  let busy = true;
  const refresh = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }))
    .mockRejectedValueOnce(new Error("offline")).mockImplementation(async () => { busy = false; });
  const poller = createProjectPoller({ refresh, isBusy: () => busy, interval: 1000 });
  poller.schedule();
  await vi.advanceTimersByTimeAsync(10000);
  poller.schedule();
  expect(refresh).toHaveBeenCalledTimes(1);
  release();
  await vi.advanceTimersByTimeAsync(3000);
  expect(refresh).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});
