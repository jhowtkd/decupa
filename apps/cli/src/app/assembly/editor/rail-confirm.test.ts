import { afterEach, expect, it, vi } from "vitest";
import { createState } from "./state.js";
import { mountRail } from "./rail.js";
import { domWindow, installDom } from "./fake-dom.test-helper.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function projeto(scenes: number, prepared: number | null) {
  return {
    id: "p",
    revision: 2,
    preparedRevision: prepared,
    previewRevision: null,
    finalApprovedRevision: null,
    preparation: null,
    corrections: [],
    proposal: null,
    input: { kind: "brief", text: "um vídeo", targetSeconds: 60 },
    analyses: [{ sourceId: "a", words: [], visual: [], status: "ready" }],
    assembly: {
      name: "Montagem",
      fps: { num: 25, den: 1 },
      width: 320,
      height: 240,
      sources: [{ id: "a", name: "fala.mp4", included: true, hasVideo: false, role: "speech" }],
      tracks: [],
    },
    scenes: Array.from({ length: scenes }, (_, i) => ({
      id: "s" + i,
      objective: "Cena",
      takes: [{ id: "t" + i, sourceId: "a", start: 0, end: 1, removed: [], protected: [] }],
      support: [],
      gaps: [],
    })),
  };
}

function montar(confirm = vi.fn(() => false)) {
  const document = installDom(
    '<button id="newProject" type="button"></button><span id="primaryAction"></span>'
    + '<aside id="rail"></aside><div id="activity"></div><div id="monitorBriefing"></div>',
  );
  const state = createState({});
  const api = {
    call: vi.fn(async (_path: string) => ({ res: { ok: true, status: 201 }, body: { url: "http://127.0.0.1:9/" } })),
    notifyError: vi.fn(),
  };
  mountRail({ state, api, player: { previewBusy: () => false, seek: vi.fn() }, confirm });
  return { state, api, confirm, document };
}

it("Montar com cenas desatualizadas pede confirmação e cancelar não prepara", async () => {
  const { state, api, confirm, document } = montar();
  state.set("project", projeto(1, 1));
  document.getElementById("prepare")?.click();
  await Promise.resolve();
  await Promise.resolve();
  const paths = api.call.mock.calls.map((call) => call[0]);
  expect({ asked: confirm.mock.calls.length, paths }).toEqual({ asked: 1, paths: [] });
});

it("montar de novo na revisão já preparada não pergunta", async () => {
  const { state, api, confirm, document } = montar(vi.fn(() => false));
  state.set("project", projeto(1, 2));
  document.getElementById("prepare")?.click();
  await Promise.resolve();
  expect(confirm).not.toHaveBeenCalled();
  expect(api.call.mock.calls.map((call) => call[0])).toContain("/project/prepare");
});

it("Novo projeto abre a página com #novo", async () => {
  const { api, document } = montar();
  document.getElementById("newProject")?.click();
  await Promise.resolve();
  await Promise.resolve();
  expect(api.call.mock.calls[0]?.[0]).toBe("/project/new");
  expect(domWindow().location.assign).toHaveBeenCalledWith("http://127.0.0.1:9/#novo");
});

it("depois de desfazer Preparar (pronta, sem cenas) o botão volta a Montar e chama o prepare sem confirmar", async () => {
  const { state, api, confirm, document } = montar();
  const desfeito = {
    ...projeto(0, null),
    preparation: { status: "ready", sources: { a: { media: "ready", audio: "ready", visual: "ready" } } },
  };
  state.set("project", desfeito);
  const button = document.getElementById("prepare");
  const antes = { label: button?.textContent, action: button?.dataset.action, disabled: button?.disabled };
  const dispatch = vi.spyOn(domWindow(), "dispatchEvent");
  button?.click();
  await Promise.resolve();
  await Promise.resolve();
  expect({
    antes,
    navegou: dispatch.mock.calls.length,
    confirmou: confirm.mock.calls.length,
    paths: api.call.mock.calls.map((call) => call[0]),
  }).toEqual({
    antes: { label: "Montar vídeo", action: "montar", disabled: false },
    navegou: 0,
    confirmou: 0,
    paths: ["/project/prepare"],
  });
});

it("preparação pronta com cenas segue Revisar prévia e navega sem chamar o prepare", async () => {
  const { state, api, document } = montar();
  state.set("project", {
    ...projeto(1, 2),
    preparation: { status: "ready", sources: { a: {} } },
    assembly: {
      ...projeto(1, 2).assembly,
      tracks: [{ id: "v", clips: [{ id: "c1" }] }],
    },
  });
  const button = document.getElementById("prepare");
  expect(button?.dataset.action).toBe("revisar");
  button?.click();
  await Promise.resolve();
  expect(api.call.mock.calls.map((call) => call[0])).not.toContain("/project/prepare");
});
