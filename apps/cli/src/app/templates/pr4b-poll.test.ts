import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { installDom } from "../assembly/editor/fake-dom.test-helper.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const running = {
  id: "rec1",
  name: "Receita",
  revision: 1,
  status: "draft",
  analysis: { status: "running", stage: "media", error: "" },
  rules: [] as unknown[],
};

async function abrir() {
  vi.useFakeTimers();
  const document = installDom("", { autoIds: true });
  const urls: string[] = [];
  const fetchMock = vi.fn(async (url: string) => {
    urls.push(String(url));
    if (String(url).endsWith("/templates/api")) return { ok: true, json: async () => ({ recipes: [] }) };
    if (String(url).includes("/rec1")) {
      return { ok: true, json: async () => ({ recipe: { ...running, analysis: { ...running.analysis, status: "ready", stage: "complete" } } }) };
    }
    return { ok: true, json: async () => ({}) };
  });
  const source = await readFile(new URL("./page.js", import.meta.url), "utf8");
  const vm = runInNewContext(source + "\n;({ show, act, getBusy: () => busy })", {
    document, fetch: fetchMock, setTimeout, clearTimeout, confirm: () => true,
  }) as {
    show: (recipe: typeof running) => void;
    act: (work: () => Promise<unknown>) => Promise<unknown>;
    getBusy: () => boolean;
  };
  for (let i = 0; i < 20 && vm.getBusy(); i += 1) await Promise.resolve();
  return { vm, urls };
}

it("tick de polling com outra ação em curso é reagendado até a análise sair de running", async () => {
  const { vm, urls } = await abrir();
  expect(vm.getBusy()).toBe(false);
  let release: () => void = () => {};
  const hang = vm.act(() => new Promise<void>((resolve) => { release = resolve; }));
  expect(vm.getBusy()).toBe(true);
  vm.show(running);
  await vi.advanceTimersByTimeAsync(1000);
  expect(urls.filter((url) => url.includes("/rec1"))).toEqual([]);
  release();
  await hang;
  expect(vm.getBusy()).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(urls.filter((url) => url.includes("/rec1")).length).toBeGreaterThan(0);
});
