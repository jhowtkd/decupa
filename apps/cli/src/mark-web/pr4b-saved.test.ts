import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { installDom } from "../app/assembly/editor/fake-dom.test-helper.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function ligar() {
  const html = await readFile(new URL("./page.html", import.meta.url), "utf8");
  const nearestStart = html.indexOf("// <nearest>");
  const nearestEnd = html.indexOf("// </nearest>");
  const changedAt = html.indexOf("function marksChanged");
  const bodyStart = changedAt >= 0 ? changedAt : html.indexOf("function addMark");
  const bodyEnd = html.indexOf("// O loop de reprodução");
  const unloadStart = html.indexOf('window.addEventListener("beforeunload"');
  const unloadEnd = html.indexOf("(async function start()");
  expect(nearestStart).toBeGreaterThanOrEqual(0);
  expect(bodyStart).toBeGreaterThanOrEqual(0);
  expect(unloadStart).toBeGreaterThan(bodyEnd);
  const source = [
    html.slice(nearestStart, nearestEnd),
    html.slice(bodyStart, bodyEnd),
    html.slice(unloadStart, unloadEnd),
  ].join("\n");
  const document = installDom('<button id="save" disabled></button><p id="toast"></p>');
  const listeners = new Map<string, Array<(event: { preventDefault: () => void; returnValue?: string }) => void>>();
  const window = {
    addEventListener(type: string, fn: (event: { preventDefault: () => void }) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    removeEventListener() {},
    devicePixelRatio: 1,
  };
  const vm = runInNewContext(
    "let saved = true; let marks = [100, 400]; let cursorMs = 400;\n" + source
    + "\n;({ addMark, removeNearest, save, getSaved: () => saved, getMarks: () => marks, setCursor: (v) => { cursorMs = v; } })",
    {
      document,
      window,
      el: (id: string) => document.getElementById(id),
      toast: vi.fn(),
      render: vi.fn(),
      fetch: vi.fn(),
    },
  ) as {
    addMark: () => void;
    removeNearest: () => void;
    save: () => Promise<void>;
    getSaved: () => boolean;
    getMarks: () => number[];
    setCursor: (v: number) => void;
  };
  return { vm, document, listeners };
}

function warn(listeners: Map<string, Array<(event: { preventDefault: () => void }) => void>>) {
  const event = { preventDefault: vi.fn(), returnValue: "" };
  for (const fn of listeners.get("beforeunload") ?? []) fn(event);
  return event.preventDefault.mock.calls.length;
}

it("marca nova depois de salvar volta a pedir salvar e a avisar ao fechar", async () => {
  const { vm, document, listeners } = await ligar();
  vm.setCursor(250);
  vm.addMark();
  expect({
    saved: vm.getSaved(),
    disabled: (document.getElementById("save") as unknown as { disabled: boolean }).disabled,
    warned: warn(listeners),
  }).toEqual({ saved: false, disabled: false, warned: 1 });
});

it("apagar a marca mais próxima depois de salvar volta a pedir salvar", async () => {
  const { vm, document, listeners } = await ligar();
  vm.removeNearest();
  expect({
    saved: vm.getSaved(),
    disabled: (document.getElementById("save") as unknown as { disabled: boolean }).disabled,
    warned: warn(listeners),
    marks: vm.getMarks(),
  }).toEqual({ saved: false, disabled: false, warned: 1, marks: [100] });
});

it("marca adicionada enquanto o save está em voo não fica salva", async () => {
  const { vm, document } = await ligar();
  let release: (value: Response | PromiseLike<Response>) => void = () => {};
  vi.mocked(fetch).mockImplementation(() => new Promise((resolve) => { release = resolve; }));
  vm.setCursor(100);
  const pending = vm.save();
  vm.setCursor(250);
  vm.addMark();
  release({ ok: true, json: async () => ({ count: 1 }) } as Response);
  await pending;
  expect({
    saved: vm.getSaved(),
    disabled: (document.getElementById("save") as unknown as { disabled: boolean }).disabled,
  }).toEqual({ saved: false, disabled: false });
});
