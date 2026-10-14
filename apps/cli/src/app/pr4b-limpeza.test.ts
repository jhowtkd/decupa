import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { reviewGeneration } from "./review-generation.js";
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
    document, generations: reviewGeneration(), renderFillerCard: vi.fn(), changeFillers: vi.fn(), playRanges: vi.fn(),
    el: (id: string) => document.getElementById(id),
    toast, render, renderMessage, renderProcessing, api, fetch: fetchMock,
    setTimeout, clearTimeout,
    keepList: () => [{ id: "u1" }],
    ...extras,
  };
  const vm = runInNewContext(
    "const jobId = \"j1\"; let timer = null, pollTimer = null; let keepTicket = null; let review = null; let kept = new Map(); let audioSrc = null; let fillerNotes = [];\n" + source + "\n;({ schedule, poll })",
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

it.each([
  ["sem cliente ou ambíguos pendentes", false, 1, false, 0],
  ["notas pendentes", true, 1, false, 1],
  ["nova geração em andamento", false, 2, true, 1],
  ["geração com falha já encerrada", false, 2, false, 0],
])("poll ready: %s", async (_label, fillerNotesPending, desiredGeneration, planning, count) => {
  const { vm, api } = ligar(await recorte());
  api.mockResolvedValue({ stage: "ready", review: { generation: 1, units: [] }, generation: 1, desiredGeneration, fillerNotesPending, planning });
  await vm.poll(); expect(vi.getTimerCount()).toBe(count);
  if (count) {
    api.mockResolvedValue({ stage: "ready", review: { generation: 2, units: [] }, generation: 2, desiredGeneration: 2, fillerNotesPending: false });
    await vi.advanceTimersByTimeAsync(1000); expect(vi.getTimerCount()).toBe(0);
  }
});

it("nova seleção retoma poll que já tinha parado no ready", async () => {
  const { vm, api, fetchMock } = ligar(await recorte());
  const current = { generation: 1, units: [] };
  api.mockResolvedValue({ stage: "ready", review: current, generation: 1, desiredGeneration: 1, fillerNotesPending: false });
  await vm.poll(); expect(vi.getTimerCount()).toBe(0);
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ review: { ...current, generation: 2 } }) });
  vm.schedule(); await vi.advanceTimersByTimeAsync(250); expect(vi.getTimerCount()).toBe(1);
  api.mockResolvedValue({ stage: "ready", review: { ...current, generation: 2 }, generation: 2, desiredGeneration: 2, fillerNotesPending: false });
  await vi.advanceTimersByTimeAsync(750); expect(vi.getTimerCount()).toBe(0);
});

it("seleção depois de geração com falha retoma poll até a execução terminar", async () => {
  const { vm, api, fetchMock } = ligar(await recorte()), current = { generation: 1, units: [] };
  api.mockResolvedValue({ stage: "ready", review: current, generation: 1, desiredGeneration: 2, planning: false,
    warning: "a última mudança não foi aplicada", fillerNotesPending: false });
  await vm.poll(); expect(vi.getTimerCount()).toBe(0);
  let release!: (value: unknown) => void;
  fetchMock.mockReturnValue(new Promise(resolve => { release = resolve; }));
  vm.schedule(); await vi.advanceTimersByTimeAsync(250);
  api.mockResolvedValue({ stage: "ready", review: current, generation: 1, desiredGeneration: 3, planning: true, fillerNotesPending: false });
  await vi.advanceTimersByTimeAsync(750); expect(vi.getTimerCount()).toBe(1);
  release({ ok: true, json: async () => ({ review: { ...current, generation: 3 } }) });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  api.mockResolvedValue({ stage: "ready", review: { ...current, generation: 3 }, generation: 3, desiredGeneration: 3, planning: false, fillerNotesPending: false });
  await vi.advanceTimersByTimeAsync(1000); expect(vi.getTimerCount()).toBe(0);
});
