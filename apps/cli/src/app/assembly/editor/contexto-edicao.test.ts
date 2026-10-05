import { afterEach, expect, it, vi } from "vitest";
import { createState } from "./state.js";
import { mountContexto, mountStage } from "./contexto.js";
import { installDom, type FakeDocument } from "./fake-dom.test-helper.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const candidate = {
  id: "c1",
  sourceId: "b",
  start: 0,
  end: 4,
  description: "público",
  entries: [{ visualId: "b:v", offsetFrames: 0, durationFrames: 100 }],
};

function projeto(over: Record<string, unknown> = {}) {
  return {
    id: "p",
    revision: 4,
    previewRevision: null as number | null,
    previewArtifact: null,
    preparedRevision: null,
    finalApprovedRevision: null,
    preparation: null,
    corrections: [],
    proposal: null,
    input: { kind: "brief", text: "", targetSeconds: 60 },
    assembly: {
      name: "Montagem",
      fps: { num: 25, den: 1 },
      width: 320,
      height: 240,
      sources: [
        { id: "a", name: "fala.mp4", included: true, hasVideo: true },
        { id: "b", name: "apoio.mp4", included: true, hasVideo: true, role: "support" },
      ],
      tracks: [],
    },
    analyses: [{
      sourceId: "a",
      status: "ready",
      words: [{ id: "w1", text: "ola", start: 0, end: 1 }],
      visual: [{ id: "b:v", sourceId: "b", start: 0, end: 4, text: "público" }],
      speech: [],
    }],
    scenes: [
      {
        id: "s1", objective: "Abertura", takes: [{ id: "t1", sourceId: "a", start: 0, end: 1, removed: [], protected: [] }],
        support: [] as Array<{ visualId: string; offsetFrames: number; durationFrames: number }>,
        gaps: [], animationNotes: [],
      },
      {
        id: "s2", objective: "Fecho", takes: [{ id: "t2", sourceId: "a", start: 0, end: 1, removed: [], protected: [] }],
        support: [], gaps: [], animationNotes: [],
      },
    ],
    ...over,
  };
}

function player(document: FakeDocument) {
  return { previewBusy: () => false, playOriginal: vi.fn(), seek: vi.fn(), el: () => document.getElementById("previewPlayer") };
}

it("imagem de apoio guarda o que foi digitado quando o projeto chega de novo", async () => {
  const document = installDom('<section id="contexto"></section><div id="center"></div>');
  const state = createState({});
  const api = {
    call: vi.fn(async (_path: string, _init?: { body?: string }) => ({ res: { ok: true, status: 200 }, body: {} })),
    notifyError: vi.fn(),
  };
  mountContexto({ state, api, player: player(document) });
  state.set("brollCandidates", [candidate]);
  const p = projeto();
  state.set("project", p);
  const start = document.getElementById("supportStart")!;
  const duration = document.getElementById("supportDuration")!;
  start.value = "4.5";
  duration.value = "2";
  start.dispatchEvent({ type: "input" });
  duration.dispatchEvent({ type: "input" });
  state.set("brollCandidates", [{ ...candidate }]);
  state.set("project", { ...p, previewRevision: p.revision });
  expect({ start: start.value, duration: duration.value }).toEqual({ start: "4.5", duration: "2" });
  document.querySelector("form.support-editor")?.dispatchEvent({ type: "submit" });
  await Promise.resolve();
  await Promise.resolve();
  const body = JSON.parse(String(api.call.mock.calls.at(-1)?.[1]?.body));
  expect(body.action.support).toEqual([{ visualId: "b:v", offsetFrames: 113, durationFrames: 50 }]);
});

it("trocar a cena repopula o formulário de apoio", () => {
  const document = installDom('<section id="contexto"></section><div id="center"></div>');
  const state = createState({});
  const api = { call: vi.fn(async () => ({ res: { ok: true }, body: {} })), notifyError: vi.fn() };
  mountContexto({ state, api, player: player(document) });
  state.set("brollCandidates", [candidate]);
  state.set("project", projeto());
  const start = document.getElementById("supportStart")!;
  start.value = "9";
  start.dispatchEvent({ type: "input" });
  state.set("selectedScene", "s2");
  expect(start.value).toBe("1");
});

function proposta(id: string, baseRevision: number) {
  return {
    id,
    profileId: "tight",
    baseRevision,
    beforeSeconds: 10,
    afterSeconds: 8,
    takes: [] as Array<{ removedSeconds: number; pauses: unknown[] }>,
    unaligned: [] as unknown[],
    sample: null,
  };
}

it("fechar o ritmo não reabre a mesma proposta, e revisão velha fica marcada", () => {
  const document = installDom('<section id="contexto"></section><div id="center"></div>');
  const state = createState({});
  const api = { call: vi.fn(async () => ({ res: { ok: true }, body: {} })), notifyError: vi.fn() };
  mountContexto({ state, api, player: player(document) });
  const p = projeto();
  state.set("project", p);
  state.set("rhythmProposal", proposta("r1", p.revision));
  const dialog = document.getElementById("rhythmDialog")!;
  expect(dialog.showCount).toBe(1);
  document.getElementById("closeRhythm")?.click();
  state.set("project", { ...p, previewRevision: p.revision });
  state.set("rhythmProposal", proposta("r1", p.revision));
  expect(dialog.showCount).toBe(1);
  state.set("rhythmProposal", proposta("r2", p.revision));
  expect(dialog.showCount).toBe(2);
  state.set("rhythmProposal", proposta("r3", p.revision - 1));
  const stale = document.getElementById("rhythmStale")!;
  const accept = document.getElementById("acceptRhythm")!;
  expect({
    aberturas: dialog.showCount,
    stale: stale.hidden,
    accept: accept.disabled,
  }).toEqual({ aberturas: 2, stale: false, accept: true });
});

it("Atualizar prévia trava no primeiro clique e o 409 reconcilia", async () => {
  const document = installDom('<section id="stage"></section><input id="filePicker">');
  const state = createState({});
  let release: (value: { res: { ok: boolean; status: number }; body: Record<string, unknown> }) => void = () => {};
  const api = {
    call: vi.fn((path: string) => {
      if (path === "/project/preview") return new Promise((resolve) => { release = resolve; });
      return Promise.resolve({ res: { ok: true, status: 200 }, body: { project: state.get("project") } });
    }),
    notifyError: vi.fn(),
  };
  const p = projeto();
  state.set("project", p);
  mountStage({ state, api, player: player(document) });
  const events: string[] = [];
  document.addEventListener("decupa:schedule-preview", () => events.push("stale"));
  const button = document.getElementById("refreshPreview")!;
  button.click();
  button.click();
  const previews = api.call.mock.calls.filter((call) => call[0] === "/project/preview").length;
  expect({ text: button.textContent, disabled: button.disabled, previews }).toEqual({
    text: "Atualizando prévia…",
    disabled: true,
    previews: 1,
  });
  release({ res: { ok: false, status: 409 }, body: {} });
  await Promise.resolve();
  await Promise.resolve();
  expect(api.call.mock.calls.some((call) => call[0] === "/project")).toBe(true);
  expect(events).toEqual(["stale"]);
});
