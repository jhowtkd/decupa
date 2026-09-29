import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { installDom } from "./editor/fake-dom.test-helper.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function pageJs() {
  return readFile(new URL("./page.js", import.meta.url), "utf8");
}

function slice(js: string, start: string, end: string) {
  const from = js.indexOf(start);
  const to = js.indexOf(end);
  expect(from, start).toBeGreaterThanOrEqual(0);
  expect(to, end).toBeGreaterThan(from);
  return js.slice(from, to);
}

it("prévia agendada desiste sem deixar o status em Atualizando prévia", async () => {
  vi.useFakeTimers();
  const document = installDom('<p id="status"></p>');
  const p = {
    revision: 2,
    previewRevision: 1,
    scenes: [{ id: "s" }],
    preparation: null as { status: string } | null,
    corrections: [],
  };
  const values = new Map<string, unknown>([["project", p], ["operation", null], ["previewBusy", false]]);
  const state = {
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => { values.set(key, value); },
  };
  let vm: { scheduleAutoPreview: () => void; previewBusy: () => boolean };
  const renderStatus = () => {
    const busy = vm.previewBusy();
    if (state.get("previewBusy") !== busy) state.set("previewBusy", busy);
    document.getElementById("status")!.textContent = busy ? "Atualizando prévia…" : "pronto";
  };
  const js = await pageJs();
  vm = runInNewContext(
    "let previewTimer = 0; let previewInflight = false; let previewPending = false;\n"
    + slice(js, "function maybeScheduleAutoPreview", "const poller")
    + "\n;({ scheduleAutoPreview, previewBusy: () => previewInflight || previewPending })",
    { project: () => p, state, renderStatus, setTimeout, clearTimeout, call: vi.fn(async () => ({ res: { ok: true }, body: {} })) },
  );
  vm.scheduleAutoPreview();
  p.previewRevision = p.revision;
  await vi.advanceTimersByTimeAsync(900);
  expect({
    status: document.getElementById("status")!.textContent,
    previewBusy: state.get("previewBusy"),
    player: vm.previewBusy(),
  }).toEqual({ status: "pronto", previewBusy: false, player: false });
});

it("prévia agendada desiste quando a preparação passa a running", async () => {
  vi.useFakeTimers();
  const document = installDom('<p id="status"></p>');
  const p = {
    revision: 2,
    previewRevision: 1,
    scenes: [{ id: "s" }],
    preparation: null as { status: string } | null,
    corrections: [],
  };
  const values = new Map<string, unknown>([["project", p], ["operation", null], ["previewBusy", false]]);
  const state = {
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => { values.set(key, value); },
  };
  let vm: { scheduleAutoPreview: () => void; previewBusy: () => boolean };
  const renderStatus = () => {
    const busy = vm.previewBusy();
    state.set("previewBusy", busy);
    document.getElementById("status")!.textContent = busy ? "Atualizando prévia…" : "pronto";
  };
  const js = await pageJs();
  vm = runInNewContext(
    "let previewTimer = 0; let previewInflight = false; let previewPending = false;\n"
    + slice(js, "function maybeScheduleAutoPreview", "const poller")
    + "\n;({ scheduleAutoPreview, previewBusy: () => previewInflight || previewPending })",
    { project: () => p, state, renderStatus, setTimeout, clearTimeout, call: vi.fn(async () => ({ res: { ok: true }, body: {} })) },
  );
  vm.scheduleAutoPreview();
  p.preparation = { status: "running" };
  await vi.advanceTimersByTimeAsync(900);
  expect(vm.previewBusy()).toBe(false);
  expect(document.getElementById("status")!.textContent).not.toBe("Atualizando prévia…");
});

function callSandbox(currentRevision: number) {
  const sets: Array<[string, unknown]> = [];
  let project: { revision: number } | undefined = { revision: currentRevision };
  const state = {
    get: (key: string) => key === "project" ? project : undefined,
    set: (key: string, value: unknown) => {
      sets.push([key, value]);
      if (key === "project") project = value as { revision: number };
    },
  };
  const ui = { importing: false, busy: false, label: null as string | null, error: null as string | null, errorFromPoll: false, notice: null as string | null };
  const client = { call: vi.fn() };
  return { sets, state, ui, client };
}

it("resposta com revisão mais velha não sobrescreve o projeto", async () => {
  const js = await pageJs();
  const box = callSandbox(5);
  const call = runInNewContext(
    slice(js, "async function call(", "const player") + "\n;call",
    { ui: box.ui, client: box.client, state: box.state, renderStatus: vi.fn(), maybeScheduleAutoPreview: vi.fn() },
  ) as (path: string, opts?: unknown) => Promise<unknown>;
  box.client.call.mockResolvedValueOnce({
    res: { ok: true, status: 200 },
    body: { project: { revision: 3 }, undoRevision: 2, operation: { stage: "idle" } },
  });
  await call("/project");
  expect(box.sets.filter(([key]) => key === "project" || key === "undoRevision" || key === "operation")).toEqual([]);
});

it("409 reconcilia com o servidor mesmo quando ele voltou a uma revisão menor", async () => {
  const js = await pageJs();
  const box = callSandbox(10);
  const call = runInNewContext(
    slice(js, "async function call(", "const player") + "\n;call",
    { ui: box.ui, client: box.client, state: box.state, renderStatus: vi.fn(), maybeScheduleAutoPreview: vi.fn() },
  ) as (path: string, opts?: unknown) => Promise<unknown>;
  box.client.call.mockResolvedValueOnce({
    res: { ok: false, status: 409 },
    body: { error: "revisão desatualizada: base 10, atual 9" },
  });
  box.client.call.mockResolvedValueOnce({
    res: { ok: true, status: 200 },
    body: { project: { revision: 9 }, operation: { stage: "idle" } },
  });
  await call("/project/edit", { method: "POST", label: "Salvando…" });
  expect(box.sets.filter(([key]) => key === "project" || key === "operation")).toEqual([
    ["project", { revision: 9 }],
    ["operation", { stage: "idle" }],
  ]);
});

it("erro de ação sobrevive ao GET de fundo e some na ação seguinte", async () => {
  const js = await pageJs();
  const box = callSandbox(5);
  const api = runInNewContext(
    slice(js, "async function call(", "const player") + "\n;({ call, notifyError: api.notifyError })",
    { ui: box.ui, client: box.client, state: box.state, renderStatus: vi.fn(), maybeScheduleAutoPreview: vi.fn() },
  ) as { call: (path: string, opts?: unknown) => Promise<unknown>; notifyError: (message: string) => void };
  box.client.call.mockResolvedValueOnce({ res: { ok: false, status: 500 }, body: { error: "falhou a ação" } });
  await api.call("/project/edit", { method: "POST", label: "Salvando…" });
  box.client.call.mockResolvedValueOnce({ res: { ok: true, status: 200 }, body: { project: { revision: 5 } } });
  await api.call("/project");
  expect(box.ui.error).toBe("falhou a ação");
  api.notifyError("aviso da tela");
  box.client.call.mockResolvedValueOnce({ res: { ok: true, status: 200 }, body: { project: { revision: 5 } } });
  await api.call("/project");
  expect(box.ui.error).toBe("aviso da tela");
  box.client.call.mockResolvedValueOnce({ res: { ok: true, status: 200 }, body: { project: { revision: 6 } } });
  box.client.call.mockResolvedValueOnce({ res: { ok: true, status: 200 }, body: { project: { revision: 6 } } });
  await api.call("/project/edit", { method: "POST", label: "de novo" });
  expect(box.ui.error).toBeNull();
});

it("erro de GET de fundo some no GET de fundo seguinte", async () => {
  const js = await pageJs();
  const box = callSandbox(5);
  const call = runInNewContext(
    slice(js, "async function call(", "const player") + "\n;call",
    { ui: box.ui, client: box.client, state: box.state, renderStatus: vi.fn(), maybeScheduleAutoPreview: vi.fn() },
  ) as (path: string, opts?: unknown) => Promise<unknown>;
  box.client.call.mockResolvedValueOnce({ res: { ok: false, status: 500 }, body: { error: "poll fora" } });
  await call("/project");
  expect(box.ui.error).toBe("poll fora");
  box.client.call.mockResolvedValueOnce({ res: { ok: true, status: 200 }, body: { project: { revision: 5 } } });
  await call("/project");
  expect(box.ui.error).toBeNull();
});

it("aviso de projeto novo fica até a primeira ação", async () => {
  const js = await pageJs();
  const box = callSandbox(5);
  box.ui.notice = "Projeto novo em /tmp/proj";
  const call = runInNewContext(
    slice(js, "async function call(", "const player") + "\n;call",
    { ui: box.ui, client: box.client, state: box.state, renderStatus: vi.fn(), maybeScheduleAutoPreview: vi.fn() },
  ) as (path: string, opts?: unknown) => Promise<unknown>;
  box.client.call.mockResolvedValue({ res: { ok: true, status: 200 }, body: { project: { revision: 5 } } });
  await call("/project");
  expect(box.ui.notice).toBe("Projeto novo em /tmp/proj");
  await call("/project/edit", { method: "POST", label: "Salvando…" });
  expect(box.ui.notice).toBeNull();
});

it("chegada por #novo mostra a pasta no menu e no status", async () => {
  const js = await pageJs();
  const start = js.indexOf("// Pasta do projeto, injetada pelo servidor");
  const end = js.indexOf("const dropzone");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const document = installDom('<meta name="decupa-project-dir" content="/tmp/decupa-novo"><p id="projectDirLine" hidden><span id="projectDir"></span></p>');
  const ui = { notice: null as string | null };
  const location = { hash: "#novo", pathname: "/p", search: "" };
  const history = { replaceState: vi.fn() };
  runInNewContext(js.slice(start, end), { document, location, ui, history });
  expect(document.getElementById("projectDir")!.textContent).toBe("/tmp/decupa-novo");
  expect(document.getElementById("projectDirLine")!.hidden).toBe(false);
  expect(ui.notice).toBe("Projeto novo em /tmp/decupa-novo");
  expect(history.replaceState).toHaveBeenCalled();
});
