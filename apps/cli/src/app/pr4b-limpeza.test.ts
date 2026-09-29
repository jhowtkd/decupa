import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { installDom } from "./assembly/editor/fake-dom.test-helper.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function recorte() {
  const html = await readFile(new URL("./page.html", import.meta.url), "utf8");
  const start = html.indexOf("function schedule()");
  const end = html.indexOf('el("cancelar").onclick');
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

function ligar(source: string, extras: Record<string, unknown> = {}) {
  vi.useFakeTimers();
  const document = installDom("", { autoIds: true });
  const toast = vi.fn();
  const render = vi.fn();
  const renderMessage = vi.fn();
  const renderProcessing = vi.fn();
  const api = vi.fn();
  const fetchMock = vi.fn();
  const sandbox = {
    document,
    el: (id: string) => document.getElementById(id),
    toast, render, renderMessage, renderProcessing, api, fetch: fetchMock,
    setTimeout, clearTimeout,
    keepList: () => [{ id: "u1" }],
    ...extras,
  };
  const vm = runInNewContext(
    "const jobId = \"j1\"; let timer = null; let review = null; let audioSrc = null;\n" + source + "\n;({ schedule, poll })",
    sandbox,
  ) as { schedule: () => void; poll: () => Promise<unknown> };
  return { vm, toast, renderMessage, renderProcessing, api, fetchMock, document };
}

it("poll sem resposta avisa e reagenda", async () => {
  const { vm, document, api } = ligar(await recorte());
  api.mockRejectedValue(new Error("offline"));
  await vm.poll().catch(() => undefined);
  expect(document.getElementById("aviso")!.textContent).toContain("Sem resposta do decupa");
  expect(vi.getTimerCount()).toBeGreaterThan(0);
});

it("job inexistente mostra a mensagem em vez de ficar transcrevendo", async () => {
  const { vm, renderMessage, renderProcessing, api } = ligar(await recorte());
  api.mockResolvedValue({ error: "job não existe" });
  await vm.poll();
  expect({
    message: renderMessage.mock.calls,
    processing: renderProcessing.mock.calls,
  }).toEqual({
    message: [["Não deu para acompanhar o processamento", "job não existe"]],
    processing: [],
  });
});

it("schedule com fetch que rejeita mostra toast e não estoura", async () => {
  const crashes: unknown[] = [];
  const onCrash = (err: unknown) => { crashes.push(err); };
  process.on("unhandledRejection", onCrash);
  try {
    const { vm, toast, fetchMock } = ligar(await recorte());
    fetchMock.mockRejectedValue(new Error("offline"));
    vm.schedule();
    await vi.advanceTimersByTimeAsync(250);
    await Promise.resolve();
    expect({
      toasted: toast.mock.calls.map((call) => String(call[0])).join(" "),
      crashes: crashes.length,
    }).toEqual({ toasted: expect.stringContaining("Não deu para salvar a seleção"), crashes: 0 });
  } finally {
    process.off("unhandledRejection", onCrash);
  }
});

it("schedule com resposta que não é JSON mostra toast", async () => {
  const crashes: unknown[] = [];
  const onCrash = (err: unknown) => { crashes.push(err); };
  process.on("unhandledRejection", onCrash);
  try {
    const { vm, toast, fetchMock } = ligar(await recorte());
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => { throw new SyntaxError("not json"); },
    });
    vm.schedule();
    await vi.advanceTimersByTimeAsync(250);
    await Promise.resolve();
    expect({
      toasted: toast.mock.calls.map((call) => String(call[0])).join(" "),
      crashes: crashes.length,
    }).toEqual({ toasted: expect.stringContaining("502"), crashes: 0 });
  } finally {
    process.off("unhandledRejection", onCrash);
  }
});
