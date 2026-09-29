import { afterEach, expect, it, vi } from "vitest";
import { createState } from "./state.js";
import { mountTexto } from "./texto.js";
import { installDom, type FakeDocument } from "./fake-dom.test-helper.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Palavra = { id: string; text: string; start: number; end: number };

function projeto(palavras: Palavra[] = [
  { id: "w1", text: "ola", start: 0, end: 0.5 },
  { id: "w2", text: "mundo", start: 0.5, end: 1 },
]) {
  return {
    id: "p",
    revision: 3,
    previewRevision: null as number | null,
    preparation: null,
    corrections: [],
    assembly: {
      name: "Montagem",
      fps: { num: 25, den: 1 },
      width: 320,
      height: 240,
      sources: [{ id: "a", name: "fala.mp4", included: true, hasVideo: false }],
      tracks: [],
    },
    analyses: [{ sourceId: "a", status: "ready", words: palavras, visual: [], speech: [] }],
    scenes: [{
      id: "s1",
      objective: "Abertura",
      rationale: "",
      takes: [{ id: "t1", sourceId: "a", start: 0, end: 1, removed: [], protected: [] }],
      support: [],
      gaps: [],
    }],
  };
}

function montar(confirm = vi.fn((_message?: string) => false)) {
  const document = installDom('<section id="texto"></section><div id="dropzone" hidden></div>');
  const state = createState({ selection: new Set<string>(), playhead: null });
  const calls: unknown[] = [];
  const api = {
    call: vi.fn(async (...args: unknown[]) => {
      calls.push(args);
      return { res: { ok: true, status: 200 }, body: {} };
    }),
    notifyError: vi.fn(),
  };
  const player = { seek: vi.fn(), previewBusy: () => false };
  mountTexto({ state, api, player, confirm });
  return { state, api, calls, confirm, document };
}

function arrastar(document: FakeDocument) {
  const texto = document.getElementById("texto")!;
  texto.dispatchEvent({ type: "pointerdown", clientX: 0, clientY: 0 });
  document.dispatchEvent({ type: "pointerup", clientX: 40, clientY: 10 });
}

function menuAberto(document: FakeDocument) {
  return document.querySelector('[aria-label="Ações do trecho"]');
}

it("menu Corrigir e o texto digitado sobrevivem à prévia da mesma montagem", () => {
  const { state, document } = montar();
  const p = projeto();
  state.set("project", p);
  arrastar(document);
  const corrigir = [...document.querySelectorAll("button")].find((btn) => btn.textContent === "Corrigir");
  corrigir?.click();
  const input = document.querySelector('input[aria-label="Correção do trecho"]');
  expect(input).toBeTruthy();
  input!.value = "olá corrigido";
  state.set("project", { ...p, previewRevision: p.revision });
  const ainda = document.querySelector('input[aria-label="Correção do trecho"]');
  expect({
    menu: !!menuAberto(document),
    valor: ainda?.value ?? null,
  }).toEqual({ menu: true, valor: "olá corrigido" });
});

it("menu fecha quando a palavra selecionada sai do documento", () => {
  const { state, document } = montar();
  const p = projeto();
  state.set("project", p);
  arrastar(document);
  expect(menuAberto(document)).toBeTruthy();
  const semW1 = projeto([{ id: "w2", text: "mundo", start: 0.5, end: 1 }]);
  state.set("project", { ...p, analyses: semW1.analyses });
  expect(menuAberto(document)).toBeNull();
});

it("apagar cena pede confirmação e cancelar não chama o servidor", async () => {
  const { state, calls, confirm, document } = montar(vi.fn((_message?: string) => false));
  state.set("project", projeto());
  document.querySelector("[data-scene-menu]")?.dispatchEvent({ type: "click" });
  [...document.querySelectorAll("button")].find((btn) => btn.textContent === "Apagar cena")?.click();
  await Promise.resolve();
  const message = String(confirm.mock.calls[0]?.[0] ?? "");
  expect({
    asked: confirm.mock.calls.length,
    edits: calls.length,
    mentions: message.includes("Apagar a cena") && message.includes("Desfazer"),
  }).toEqual({ asked: 1, edits: 0, mentions: true });
});

it("confirmar Apagar cena envia delete-scene", async () => {
  const { state, api, confirm, document } = montar(vi.fn((_message?: string) => true));
  state.set("project", projeto());
  document.querySelector("[data-scene-menu]")?.dispatchEvent({ type: "click" });
  [...document.querySelectorAll("button")].find((btn) => btn.textContent === "Apagar cena")?.click();
  await Promise.resolve();
  await Promise.resolve();
  expect(confirm).toHaveBeenCalledTimes(1);
  const body = JSON.parse(String(api.call.mock.calls[0]?.[1] && (api.call.mock.calls[0][1] as { body?: string }).body));
  expect(body.action).toEqual({ type: "delete-scene", sceneId: "s1" });
});
