import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { activityView, mountActivity } from "./progress.js";
import { installDom } from "./fake-dom.test-helper.ts";
import { paintReadOnlyControls } from "../../edit-reservation-ui.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function project(over: Record<string, unknown> = {}) {
  return {
    revision: 8,
    previewRevision: 8,
    finalApprovedRevision: null,
    scenes: [{ id: "s1" }],
    preparation: null,
    assembly: { sources: [{ id: "media-1", name: "entrevista.mp4", included: true }] },
    corrections: [],
    ...over,
  };
}

const byKey = (view: ReturnType<typeof activityView>, key: string) => view.states.find((state) => state.key === key)!;

async function isolatedPageCall() {
  const source = await readFile(new URL("../page.js", import.meta.url), "utf8");
  const from = source.indexOf("async function call(");
  const to = source.indexOf("const player", from);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  const values = new Map<string, unknown>([["project", { revision: 8 }]]);
  const state = {
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => { values.set(key, value); },
  };
  const ui = {
    importing: false,
    busy: false,
    label: null as string | null,
    error: null as string | null,
    errorFromPoll: false,
    notice: null as string | null,
    connection: "connecting",
    connectionError: null as string | null,
    errorContext: null as unknown,
  };
  const client = { call: vi.fn() };
  const call = runInNewContext(source.slice(from, to) + "\n;call", {
    ui,
    client,
    state,
    renderStatus: vi.fn(),
    maybeScheduleAutoPreview: vi.fn(),
    reservationUI: { handleConflict: vi.fn() },
  }) as (path: string, opts?: { method?: string; label?: string }) => Promise<unknown>;
  return { call, ui, client, state };
}

it("mantém conexão, fila, execução, resultado, aprovação e cobertura separados", () => {
  const view = activityView({
    project: project({ preparation: { status: "ready" } }),
    operation: { stage: "queued", progress: "1 item" },
    ui: { connection: "connected" },
    previewPending: true,
    watched: { revision: null, ended: false },
    coverage: { revision: 8, ratio: 0.4, label: "0:24 de 1:00 vistos" },
  });

  expect(view.states.map((state) => state.key)).toEqual([
    "connection", "queue", "execution", "result", "approval", "coverage",
  ]);
  expect(byKey(view, "connection").detail).toContain("Conectado");
  expect(byKey(view, "queue").detail).toContain("Aguardando na fila");
  expect(byKey(view, "execution").detail).toContain("Aguardando início");
  expect(byKey(view, "result").detail).toContain("pronta");
  expect(byKey(view, "approval").detail).toBe("Versão atual não aprovada");
  expect(byKey(view, "coverage").detail).toContain("0:24 de 1:00 vistos");
});

it("aprovação excepcional nunca transforma cobertura parcial em assistência completa", () => {
  const view = activityView({
    project: project({ finalApprovedRevision: 8 }),
    watched: { revision: null, ended: false },
    coverage: { revision: 8, ratio: 0.99, label: "falta assistir um trecho" },
  });

  expect(byKey(view, "approval").detail).toBe("v8 aprovada");
  expect(byKey(view, "coverage").detail).toContain("falta assistir um trecho");
  expect(byKey(view, "coverage").detail).not.toContain("vista até o fim");
  expect(view.copyText).not.toContain("Cobertura assistida: Prévia v8 · vista até o fim");
});

it("não reutiliza cobertura nem aprovação de revisão anterior", () => {
  const view = activityView({
    project: project({ revision: 9, previewRevision: 9, finalApprovedRevision: 8 }),
    watched: { revision: 8, ended: true },
    coverage: { revision: 8, ratio: 1, label: "vista até o fim" },
  });

  expect(byKey(view, "approval").detail).toBe("v8 aprovada · v9 ainda não aprovada");
  expect(byKey(view, "coverage").detail).toBe("Prévia v9 · cobertura não confirmada nesta sessão");
});

for (const [operationStage, expected] of [["analyzing", "Analisando mídia"], ["proposing", "Propondo cenas"]] as const) {
  it(`operação ${operationStage} não usa etapa histórica da preparação pronta`, () => {
    const view = activityView({
      project: project({ preparation: { status: "ready", stage: "preview" } }),
      operation: { stage: operationStage },
    });

    expect(view.text).toBe(expected);
    expect(view.stage).toBe(expected);
    expect(byKey(view, "execution").detail).toBe(expected);
    expect(`${view.text} ${view.stage} ${byKey(view, "execution").detail}`).not.toContain("Renderizar prévia");
  });
}

it("preparação pronta sem operação não apresenta etapa histórica como atual", () => {
  const view = activityView({ project: project({ preparation: { status: "ready", stage: "preview" } }) });
  expect(view.stage).toBe("Sem etapa em execução");
  expect(view.stage).not.toBe("Renderizar prévia");
});

it("erro longo mantém texto completo, etapa, mídia e recuperação no detalhe copiável", () => {
  const error = "Falha ao analisar a mídia: " + "detalhe preservado ".repeat(22) + "<img id=nao-executar>";
  const view = activityView({
    project: project(),
    ui: {
      connection: "error",
      connectionError: error,
      error,
      label: "Análise visual",
      errorContext: { stage: "Análise visual", media: "entrevista.mp4" },
    },
  });

  expect(view.text).toBe("Falha na conexão");
  expect(view.retryConnection).toBe(true);
  expect(view.error).toBe(error);
  expect(view.stage).toBe("Análise visual");
  expect(view.media).toBe("entrevista.mp4");
  expect(view.recovery).toContain("Tente a conexão novamente");
  expect(view.copyText).toContain(error);
  expect(view.copyText).toContain("Etapa: Análise visual");
  expect(view.copyText).toContain("Mídia: entrevista.mp4");
  expect(view.copyText).toContain("Recuperação:");
});

it("falha inicial oferece nova consulta pelo callback e não perde o foco ao fechar", async () => {
  const document = installDom('<span id="status"></span>');
  const status = document.getElementById("status")!;
  const retry = vi.fn(async () => {});
  const activity = mountActivity({ statusEl: status, retry });
  const view = activityView({ project: null, ui: { connection: "error", connectionError: "Servidor indisponível" } });
  activity.render(view);

  const trigger = document.getElementById("viewActivity")!;
  trigger.click();
  expect(document.getElementById("activityDialog")!.open).toBe(true);
  expect(document.activeElement?.id).toBe("closeActivity");
  activity.render(activityView({ project: null, ui: { connection: "error", connectionError: "Ainda indisponível" } }));
  expect(document.activeElement?.id).toBe("closeActivity");
  document.getElementById("retryConnection")!.click();
  await Promise.resolve();
  expect(retry).toHaveBeenCalledTimes(1);

  document.getElementById("closeActivity")!.click();
  expect(document.getElementById("activityDialog")!.open).toBe(false);
  expect(document.activeElement?.id).toBe("viewActivity");
});

it("GET de retry recupera conexão após falha inicial de rede", async () => {
  const box = await isolatedPageCall();
  box.client.call.mockRejectedValueOnce(new TypeError("rede indisponível"));
  await expect(box.call("project")).rejects.toThrow("rede indisponível");
  expect(box.ui).toMatchObject({ connection: "error", connectionError: "rede indisponível" });

  box.client.call.mockResolvedValueOnce({
    res: { ok: true, status: 200 },
    body: { project: { revision: 9 }, operation: null },
  });
  await box.call("project");

  expect(box.ui).toMatchObject({ connection: "connected", connectionError: null, error: null });
  expect(box.state.get("project")).toEqual({ revision: 9 });
});

it("reconciliação GET após 409 restaura conexão sem trocar conflito pela falha de rede anterior", async () => {
  const box = await isolatedPageCall();
  box.client.call.mockRejectedValueOnce(new TypeError("rede fechada"));
  await expect(box.call("project/edit", { method: "POST", label: "Salvando…" }))
    .rejects.toThrow("rede fechada");

  box.client.call.mockResolvedValueOnce({
    res: { ok: false, status: 409 },
    body: { error: "conflito: a versão atual mudou" },
  });
  box.client.call.mockResolvedValueOnce({
    res: { ok: true, status: 200 },
    body: { project: { revision: 9 }, operation: null },
  });
  await box.call("project/edit", { method: "POST", label: "Salvando…" });

  expect(box.ui).toMatchObject({
    connection: "connected",
    connectionError: null,
    error: "conflito: a versão atual mudou",
  });
  expect(box.ui.error).not.toContain("rede fechada");
  expect(box.state.get("project")).toEqual({ revision: 9 });
  expect(box.client.call.mock.calls.map(([path]) => path)).toEqual([
    "project/edit", "project/edit", "project",
  ]);
});

it("não duplica a reconexão pendente e permite uma nova depois da resposta", async () => {
  const document = installDom('<span id="status"></span>');
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const retry = vi.fn()
    .mockReturnValueOnce(pending)
    .mockResolvedValue(undefined);
  const activity = mountActivity({ statusEl: document.getElementById("status")!, retry });
  activity.render(activityView({ project: null, ui: { connection: "error", connectionError: "offline" } }));
  document.getElementById("retryConnection")!.click();
  document.getElementById("retryConnection")!.click();
  expect(retry).toHaveBeenCalledTimes(1);

  finish();
  await Promise.resolve();
  await Promise.resolve();
  document.getElementById("retryConnection")!.click();
  await Promise.resolve();
  expect(retry).toHaveBeenCalledTimes(2);
});

it("rejeição do retry não impede uma nova tentativa", async () => {
  const document = installDom('<span id="status"></span>');
  const retry = vi.fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(undefined);
  const activity = mountActivity({ statusEl: document.getElementById("status")!, retry });
  activity.render(activityView({ project: null, ui: { connection: "error", connectionError: "offline" } }));

  document.getElementById("retryConnection")!.click();
  await Promise.resolve();
  await Promise.resolve();
  expect(document.getElementById("retryConnection")!.disabled).toBe(false);
  document.getElementById("retryConnection")!.click();
  await Promise.resolve();
  expect(retry).toHaveBeenCalledTimes(2);
});

it("modal exibe erro longo integralmente como texto e copia o detalhe", async () => {
  const document = installDom('<span id="status"></span>');
  const status = document.getElementById("status")!;
  const copied: string[] = [];
  vi.stubGlobal("navigator", { clipboard: { writeText: async (text: string) => { copied.push(text); } } });
  const activity = mountActivity({ statusEl: status, retry: vi.fn() });
  const error = "Falha · " + "x".repeat(340) + " <img id=nao-criar>";
  const view = activityView({
    project: project(),
    ui: { error, label: "Renderização", errorContext: { stage: "Renderização", media: "take.mp4" } },
  });
  activity.render(view);

  document.getElementById("viewActivity")!.click();
  expect(document.getElementById("activityError")!.textContent).toBe(error);
  expect(document.getElementById("activityError")!.textContent.length).toBeGreaterThan(300);
  expect(document.querySelector("#activityError img")).toBeNull();
  document.getElementById("copyActivity")!.click();
  await Promise.resolve();
  await Promise.resolve();
  expect(copied).toEqual([view.copyText]);
  expect(document.getElementById("activityCopyStatus")!.textContent).toBe("Detalhe copiado.");
});

it("clipboard indisponível deixa fallback de texto selecionável", async () => {
  const document = installDom('<span id="status"></span>');
  vi.stubGlobal("navigator", { clipboard: { writeText: async () => { throw new Error("clipboard indisponível"); } } });
  const activity = mountActivity({ statusEl: document.getElementById("status")!, retry: vi.fn() });
  const view = activityView({ project: project(), ui: { error: "Erro longo para copiar" } });
  activity.render(view);
  const fallback = document.getElementById("activityCopyText")!;
  const select = vi.fn();
  (fallback as unknown as { select: () => void }).select = select;

  document.getElementById("viewActivity")!.click();
  document.getElementById("copyActivity")!.click();
  await Promise.resolve();
  await Promise.resolve();

  expect(fallback.hidden).toBe(false);
  expect(fallback.value).toBe(view.copyText);
  expect(document.activeElement?.id).toBe("activityCopyText");
  expect(select).toHaveBeenCalledOnce();
  expect(document.getElementById("activityCopyStatus")!.textContent).toContain("copie");
});

it("controles de atividade continuam habilitados no Modo Leitura", () => {
  const document = installDom('<span id="status"></span>');
  const activity = mountActivity({ statusEl: document.getElementById("status")!, retry: vi.fn() });
  activity.render(activityView({ project: null, ui: { connection: "error", connectionError: "offline" } }));
  const trigger = document.getElementById("viewActivity")!;
  const dialog = document.getElementById("activityDialog")!;
  expect(trigger.getAttribute("data-edit-reservation-dialog")).not.toBeNull();
  expect(dialog.getAttribute("data-edit-reservation-dialog")).not.toBeNull();

  paintReadOnlyControls(document, { nome: "outra pessoa" }, null, new WeakMap());

  for (const id of ["viewActivity", "closeActivity", "copyActivity", "retryConnection"]) {
    expect(document.getElementById(id)!.disabled, id).toBe(false);
  }
});
