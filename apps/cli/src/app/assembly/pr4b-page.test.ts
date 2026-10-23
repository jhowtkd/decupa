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

async function callWithReservation(box: ReturnType<typeof callSandbox>) {
  const js = await pageJs();
  const reservationUI = { handleConflict: vi.fn() };
  const call = runInNewContext(
    slice(js, "async function call(", "const player") + "\n;call",
    { ui: box.ui, client: box.client, state: box.state, reservationUI, renderStatus: vi.fn(), maybeScheduleAutoPreview: vi.fn() },
  ) as (path: string, opts?: unknown) => Promise<unknown>;
  return { call, reservationUI };
}

it("resposta da mesma revisão é aceita: correção que termina em segundo plano substitui o projeto e as chaves laterais", async () => {
  const box = callSandbox(5);
  (box.state.get("project") as Record<string, unknown>).corrections = [{ id: "c1", status: "pending" }];
  const { call } = await callWithReservation(box);
  box.client.call.mockResolvedValueOnce({
    res: { ok: true, status: 200 },
    body: {
      project: { revision: 5, corrections: [{ id: "c1", status: "done" }] },
      undoRevision: 4,
      operation: { stage: "idle" },
    },
  });
  await call("/project");
  expect(box.state.get("project")).toEqual({ revision: 5, corrections: [{ id: "c1", status: "done" }] });
  expect(box.sets.filter(([key]) => key !== "project")).toEqual([
    ["undoRevision", 4],
    ["operation", { stage: "idle" }],
  ]);
});

it("409 com dono avisa a UI da Reserva e ainda reconcilia pelo GET autoritativo", async () => {
  const box = callSandbox(10);
  const { call, reservationUI } = await callWithReservation(box);
  const dono = { nome: "outra pessoa", ultimoSinal: 123 };
  const conflito = { error: "Projeto em edição", dono };
  box.client.call.mockResolvedValueOnce({ res: { ok: false, status: 409 }, body: conflito });
  box.client.call.mockResolvedValueOnce({
    res: { ok: true, status: 200 },
    body: { project: { revision: 8 }, operation: { stage: "idle" } },
  });
  await call("/project/edit", { method: "POST", label: "Salvando…" });
  expect(reservationUI.handleConflict).toHaveBeenCalledTimes(1);
  expect(reservationUI.handleConflict).toHaveBeenCalledWith(conflito);
  expect(box.client.call.mock.calls.map(([path]) => path)).toEqual(["/project/edit", "project"]);
  expect(box.state.get("project")).toEqual({ revision: 8 });
});

it("409 sem dono não chama a UI da Reserva", async () => {
  const box = callSandbox(10);
  const { call, reservationUI } = await callWithReservation(box);
  box.client.call.mockResolvedValueOnce({ res: { ok: false, status: 409 }, body: { error: "revisão desatualizada" } });
  box.client.call.mockResolvedValueOnce({ res: { ok: true, status: 200 }, body: { project: { revision: 10 } } });
  await call("/project/edit", { method: "POST", label: "Salvando…" });
  expect(reservationUI.handleConflict).not.toHaveBeenCalled();
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

it.each([
  ["409", { res: { ok: false, status: 409 }, body: { error: "conflito" } }],
  ["500", { res: { ok: false, status: 500 }, body: { error: "falha" } }],
  ["rede", new Error("rede")],
])("upload recusado mantém resultado e retry repete só a associação (%s)", async (_name, outcome) => {
  const document = installDom('<div id="mediaUploads"></div>');
  let starts = 0;
  const calls: string[] = [];
  const result = { mediaId: "m1", deduplicado: false };
  let attempts = 0;
  class Upload {
    state = "concluido";
    constructor(_opts: unknown) {}
    async start() { starts++; return result; }
    pause() {}
  }
  const vm = runInNewContext(
    slice(await pageJs(), "async function uploadTeamFiles", "/* ---- Fiação ---- */") + "\n;uploadTeamFiles",
    {
      document,
      teamMode: true,
      mediaEnabled: true,
      importFiles: vi.fn(),
      UploadPausedError: class UploadPausedError extends Error {},
      ResumableMediaUpload: Upload,
      project: () => ({ revision: 7 }),
      call: vi.fn(async (path: string) => {
        calls.push(path);
        attempts++;
        if (attempts > 1) return { res: { ok: true, status: 201 }, body: {} };
        if (outcome instanceof Error) throw outcome;
        return outcome as never;
      }),
      refreshMediaLibrary: vi.fn(),
      mediaProgressText: () => "Enviando",
    },
  ) as (files: unknown[]) => Promise<void>;
  await vm([{ name: "clip.mp4" }]);
  const row = document.querySelector(".media-upload-item")!;
  const button = row.querySelector("button")!;
  expect({ starts, calls, status: row.querySelector("span")?.textContent, button: button.textContent, hidden: button.hidden })
    .toMatchObject({ starts: 1, calls: ["project/media"], status: expect.stringContaining("Envio concluído"), button: "Tentar adicionar ao projeto", hidden: false });
  await button.click();
  await Promise.resolve();
  await Promise.resolve();
  expect({ starts, calls, status: row.querySelector("span")?.textContent })
    .toEqual({ starts: 1, calls: ["project/media", "project/media"], status: "Adicionado ao projeto" });
});

it("upload aceito mostra que foi adicionado ao projeto", async () => {
  const document = installDom('<div id="mediaUploads"></div>');
  class Upload {
    state = "concluido";
    constructor(_opts: unknown) {}
    async start() { return { mediaId: "m1", deduplicado: false }; }
    pause() {}
  }
  const vm = runInNewContext(
    slice(await pageJs(), "async function uploadTeamFiles", "/* ---- Fiação ---- */") + "\n;uploadTeamFiles",
    {
      document,
      teamMode: true,
      mediaEnabled: true,
      importFiles: vi.fn(),
      UploadPausedError: class UploadPausedError extends Error {},
      ResumableMediaUpload: Upload,
      project: () => ({ revision: 7 }),
      call: vi.fn(async () => ({ res: { ok: true, status: 201 }, body: {} })),
      refreshMediaLibrary: vi.fn(),
      mediaProgressText: () => "Enviando",
    },
  ) as (files: unknown[]) => Promise<void>;
  await vm([{ name: "clip.mp4" }]);
  const row = document.querySelector(".media-upload-item")!;
  expect({ status: row.querySelector("span")?.textContent, button: row.querySelector("button")?.hidden })
    .toEqual({ status: "Adicionado ao projeto", button: true });
});

it("associação pendente mostra envio concluído, bloqueia duplo clique e aceita retry", async () => {
  const document = installDom('<div id="mediaUploads"></div>');
  let release!: (value: { res: { ok: boolean; status: number }; body: object }) => void;
  let uploads = 0;
  const calls: string[] = [];
  class Upload {
    state = "concluido";
    constructor(_opts: unknown) {}
    async start() { uploads++; return { mediaId: "m1", deduplicado: false }; }
    pause() {}
  }
  const vm = runInNewContext(
    slice(await pageJs(), "async function uploadTeamFiles", "/* ---- Fiação ---- */") + "\n;uploadTeamFiles",
    {
      document, teamMode: true, mediaEnabled: true, importFiles: vi.fn(),
      UploadPausedError: class UploadPausedError extends Error {}, ResumableMediaUpload: Upload,
      project: () => ({ revision: 7 }),
      call: vi.fn((path: string) => { calls.push(path); return new Promise(resolve => { release = resolve; }); }),
      refreshMediaLibrary: vi.fn(), mediaProgressText: () => "Enviando",
    },
  ) as (files: unknown[]) => Promise<void>;
  const pending = vm([{ name: "clip.mp4" }]);
  await vi.waitFor(() => expect(calls).toEqual(["project/media"]));
  const row = document.querySelector(".media-upload-item")!;
  const button = row.querySelector("button")!;
  await vi.waitFor(() => expect(button.textContent).toBe("Adicionando…"));
  expect({ status: row.querySelector("span")?.textContent, text: button.textContent, disabled: button.disabled, uploads, calls })
    .toEqual({ status: "Envio concluído · adicionando ao projeto…", text: "Adicionando…", disabled: true, uploads: 1, calls: ["project/media"] });
  button.click();
  expect(calls).toEqual(["project/media"]);
  release({ res: { ok: false, status: 409 }, body: { error: "conflito" } });
  await pending;
  await vi.waitFor(() => expect(button.textContent).toBe("Tentar adicionar ao projeto"));
  expect({ status: row.querySelector("span")?.textContent, button: button.textContent, disabled: button.disabled })
    .toMatchObject({ status: expect.stringContaining("Envio concluído"), button: "Tentar adicionar ao projeto", disabled: false });
  button.click();
  await Promise.resolve();
  expect(calls).toEqual(["project/media", "project/media"]);
  release({ res: { ok: true, status: 201 }, body: {} });
  await vi.waitFor(() => expect(row.querySelector("span")?.textContent).toBe("Adicionado ao projeto"));
  expect({ uploads, status: row.querySelector("span")?.textContent }).toEqual({ uploads: 1, status: "Adicionado ao projeto" });
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

it("retomar após erro de rede conclui a mesma Mídia no Projeto", async () => {
  const js = await pageJs();
  const document = installDom('<div id="mediaUploads"></div>');
  const call = vi.fn(async () => ({ res: { ok: true }, body: { project: { revision: 1 } } }));
  const refreshMediaLibrary = vi.fn(async () => undefined);
  const starts: boolean[] = [];
  class UploadMock {
    state = "parado";
    paused = false;
    async start() {
      starts.push(true);
      if (starts.length === 1) throw new Error("rede caiu");
      this.state = "concluido";
      return { mediaId: "e".repeat(64), deduplicado: false };
    }
    pause() { this.paused = true; }
  }
  class PausedMockError extends Error {}
  const file = { name: "aula.mp4", size: 5 };
  const uploadTeamFiles = runInNewContext(
    "const mediaProgressText = () => '';\n" + slice(js, "async function uploadTeamFiles", "/* ---- Fiação ----") + "\n;uploadTeamFiles",
    {
      document, teamMode: true, mediaEnabled: true, importFiles: vi.fn(),
      ResumableMediaUpload: UploadMock, UploadPausedError: PausedMockError,
      call, project: () => ({ revision: 1 }), refreshMediaLibrary,
    },
  );
  await uploadTeamFiles([file]);
  const pause = document.getElementById("mediaUploads")!.children[0]!.children[3]!;
  pause.click();
  await Promise.resolve();
  await Promise.resolve();
  expect(starts).toHaveLength(2);
  expect(call).toHaveBeenCalledWith("project/media", expect.objectContaining({ method: "POST" }));
});

it("permite repetir a adição ao Projeto sem reenviar Mídia já concluída", async () => {
  const js = await pageJs();
  const document = installDom('<div id="mediaUploads"></div>');
  let additions = 0;
  const call = vi.fn(async () => {
    additions += 1;
    if (additions === 1) throw new Error("POST do Projeto caiu");
    return { res: { ok: true }, body: { project: { revision: 1 } } };
  });
  const starts: boolean[] = [];
  class UploadMock {
    state = "parado";
    async start() { starts.push(true); this.state = "concluido"; return { mediaId: "1".repeat(64), deduplicado: false }; }
    pause() { throw new Error("não deve pausar Mídia concluída"); }
  }
  const uploadTeamFiles = runInNewContext(
    "const mediaProgressText = () => '';\n" + slice(js, "async function uploadTeamFiles", "/* ---- Fiação ----") + "\n;uploadTeamFiles",
    {
      document, teamMode: true, mediaEnabled: true, importFiles: vi.fn(),
      ResumableMediaUpload: UploadMock, UploadPausedError: class extends Error {},
      call, project: () => ({ revision: 1 }), refreshMediaLibrary: vi.fn(async () => undefined),
    },
  );
  await uploadTeamFiles([{ name: "aula.mp4", size: 5 }]);
  const pause = document.getElementById("mediaUploads")!.children[0]!.children[3]!;
  pause.click();
  await Promise.resolve();
  await Promise.resolve();
  expect(starts).toHaveLength(1);
  expect(additions).toBe(2);
});

it("redoRevision é aceito em resposta fresca e ignorado em resposta atrasada", async () => {
  const js = await pageJs();
  const rodar = async (revisaoAtual: number, revisaoResposta: number) => {
    const box = callSandbox(revisaoAtual);
    const call = runInNewContext(
      slice(js, "async function call(", "const player") + "\n;call",
      { ui: box.ui, client: box.client, state: box.state, renderStatus: vi.fn(), maybeScheduleAutoPreview: vi.fn() },
    ) as (path: string, opts?: unknown) => Promise<unknown>;
    box.client.call.mockResolvedValueOnce({
      res: { ok: true, status: 200 },
      body: { project: { revision: revisaoResposta }, undoRevision: 2, redoRevision: 3 },
    });
    await call("/project");
    return box.sets.filter(([key]) => key === "redoRevision");
  };
  expect({ fresca: await rodar(5, 5), atrasada: await rodar(5, 3) }).toEqual({
    fresca: [["redoRevision", 3]],
    atrasada: [],
  });
});
