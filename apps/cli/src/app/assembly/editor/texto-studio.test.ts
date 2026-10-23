import { afterEach, expect, it, vi } from "vitest";
import { createState } from "./state.js";
import {
  aligningKeys,
  barActionWords,
  correctionNotice,
  mountTexto,
  reconcileSelection,
  selectionBarActions,
  listenTarget,
  selectionBarBox,
  selectionKey,
} from "./texto.js";
import { El, installDom, type FakeDocument } from "./fake-dom.test-helper.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Palavra = { id: string; text: string; start: number; end: number };
type Faixa = { start: number; end: number };
type Take = { id: string; sourceId: string; start: number; end: number; removed: Faixa[]; protected: Faixa[] };
type Correcao = {
  id: string; sourceId: string; start: number; end: number; text: string;
  status: "pending" | "aligned" | "error"; words: Palavra[]; error?: string;
};

const PALAVRAS: Palavra[] = [
  { id: "w1", text: "um", start: 0, end: 0.5 },
  { id: "w2", text: "dois", start: 0.5, end: 1 },
  { id: "w3", text: "tres", start: 1, end: 1.5 },
  { id: "w4", text: "quatro", start: 1.5, end: 2 },
  { id: "w5", text: "cinco", start: 2, end: 2.5 },
  { id: "w6", text: "seis", start: 2.5, end: 3 },
];

const take = (id: string, start: number, end: number, extra: Partial<Take> = {}): Take =>
  ({ id, sourceId: "a", start, end, removed: [], protected: [], ...extra });

function projeto(opcoes: {
  takes?: Take[][]; palavras?: Palavra[]; corrections?: Correcao[]; revision?: number;
} = {}) {
  const takes = opcoes.takes ?? [[take("t1", 0, 1.5)]];
  return {
    id: "p",
    revision: opcoes.revision ?? 3,
    previewRevision: null as number | null,
    preparation: null,
    corrections: opcoes.corrections ?? [],
    assembly: {
      name: "Montagem", fps: { num: 25, den: 1 }, width: 320, height: 240,
      sources: [{ id: "a", name: "fala.mp4", included: true, hasVideo: false }], tracks: [],
    },
    analyses: [{ sourceId: "a", status: "ready", words: opcoes.palavras ?? PALAVRAS, visual: [], speech: [] }],
    scenes: takes.map((lista, i) => ({
      id: `s${i + 1}`, objective: `Cena ${i + 1}`, rationale: "", takes: lista, support: [], gaps: [],
    })),
  };
}

type Projeto = ReturnType<typeof projeto>;

const HTML = '<main id="center"><div id="textoHead"><span class="spacer"></span><span id="undoSlot"></span></div>'
  + '<section id="texto"></section></main><div id="dropzone" hidden></div>';

function montar(ui?: "studio" | "legacy", p: Projeto = projeto(), stage = "edicao") {
  const document = installDom(HTML);
  const state = createState({ selection: new Set<string>(), playhead: null, stage });
  const api = {
    call: vi.fn(async (..._args: unknown[]) => ({ res: { ok: true, status: 200 }, body: {} })),
    notifyError: vi.fn(),
  };
  const player = { seek: vi.fn(), playOriginal: vi.fn(), playMontage: vi.fn(), previewBusy: () => false };
  mountTexto({ state, api, player, ...(ui ? { ui } : {}) });
  state.set("project", p);
  return { state, api, player, document };
}

const palavra = (document: FakeDocument, cena: string, id: string, take?: string): El => {
  const found = document.querySelectorAll("button.word")
    .find((btn) => btn.dataset.scene === cena && btn.dataset.wordId === id && (take === undefined || btn.dataset.take === take));
  if (!found) throw new Error(`palavra ${cena}/${id} não montada`);
  return found;
};
const clicar = (btn: El, opcoes: { shiftKey?: boolean } = {}) => btn.dispatchEvent({ type: "click", detail: 1, ...opcoes } as Parameters<El["dispatchEvent"]>[0]);
const barra = (document: FakeDocument) => document.querySelector(".texto-barra");
const acoes = (document: FakeDocument) =>
  (barra(document)?.querySelectorAll("[data-bar-action]") ?? []).map((btn) => btn.dataset.barAction);
const acao = (document: FakeDocument, nome: string) => {
  const btn = barra(document)?.querySelector(`[data-bar-action="${nome}"]`);
  if (!btn) throw new Error(`ação ${nome} ausente`);
  return btn;
};
const status = (document: FakeDocument) => barra(document)?.querySelector(".barra-status")?.textContent ?? "";
const chave = (cena: string, take: string, id: string) => selectionKey(cena, take, id);
const corpos = (api: { call: { mock: { calls: unknown[][] } } }) =>
  api.call.mock.calls.map((call) => JSON.parse(String((call[1] as { body: string }).body)));
const selecionados = (state: { get: (k: string) => unknown }) => [...(state.get("selection") as Set<string>)];

/** Seleciona de `de` a `ate` (mesmo take) com clique e Shift+clique. */
function selecionar(document: FakeDocument, cena: string, de: string, ate: string = de, take?: string) {
  clicar(palavra(document, cena, de, take));
  if (ate !== de) clicar(palavra(document, cena, ate, take), { shiftKey: true });
}

const submeter = (document: FakeDocument) =>
  barra(document)!.querySelector("form")!.dispatchEvent({ type: "submit", preventDefault() {} });

/* ---------- 1. selecionar não escreve ---------- */

it("studio: selecionar (clique, arraste, Shift+clique, setas, Enter) não chama a API", () => {
  const p = projeto({ takes: [[take("t1", 0, 1.5, { removed: [{ start: 0.5, end: 1 }] })]] });
  const { document, api, state } = montar("studio", p);

  clicar(palavra(document, "s1", "w1"));
  clicar(palavra(document, "s1", "w2"));
  expect(selecionados(state)).toEqual([chave("s1", "t1", "w2")]);
  clicar(palavra(document, "s1", "w3"), { shiftKey: true });
  expect(selecionados(state)).toHaveLength(2);

  const w1 = palavra(document, "s1", "w1");
  w1.dispatchEvent({ type: "pointerdown", clientX: 0, clientY: 0 });
  document.dispatchEvent({ type: "pointerup", clientX: 60, clientY: 0 });
  expect(selecionados(state).length).toBeGreaterThan(1);

  palavra(document, "s1", "w1").dispatchEvent({ type: "keydown", key: "ArrowRight" });
  palavra(document, "s1", "w2").dispatchEvent({ type: "keydown", key: "ArrowRight", shiftKey: true });
  palavra(document, "s1", "w2").dispatchEvent({ type: "keydown", key: "Enter" });
  expect(api.call).not.toHaveBeenCalled();
});

it("studio: o clique em palavra cortada só seleciona e o clique em mantida faz seek", () => {
  const p = projeto({ takes: [[take("t1", 0, 1.5, { removed: [{ start: 0.5, end: 1 }] })]] });
  const { document, api, player, state } = montar("studio", p);

  clicar(palavra(document, "s1", "w2"));
  expect(selecionados(state)).toEqual([chave("s1", "t1", "w2")]);
  expect(palavra(document, "s1", "w2").classList.contains("riscado")).toBe(true);
  expect(player.seek).not.toHaveBeenCalled();
  expect(api.call).not.toHaveBeenCalled();

  clicar(palavra(document, "s1", "w3"));
  expect(player.seek).toHaveBeenCalledTimes(1);
  expect(api.call).not.toHaveBeenCalled();
});

/* ---------- 2. cortar ---------- */

it("cortar uma seleção válida envia uma única ação remove com os IDs certos", async () => {
  const { document, api } = montar("studio");
  selecionar(document, "s1", "w1", "w3");
  expect(acoes(document)).toEqual(["ouvir", "cortar", "preservar", "corrigir"]);
  acao(document, "cortar").click();
  await vi.waitFor(() => expect(api.call).toHaveBeenCalledTimes(1));
  expect(api.call.mock.calls[0]![0]).toBe("project/edit");
  expect((api.call.mock.calls[0]![1] as { method: string }).method).toBe("POST");
  expect(corpos(api)).toEqual([
    { baseRevision: 3, action: { type: "remove", sceneId: "s1", takeId: "t1", wordIds: ["w1", "w2", "w3"] } },
  ]);
});

it("a mesma palavra da Mídia em dois takes de cenas diferentes envia os IDs do take selecionado", async () => {
  const p = projeto({ takes: [[take("tA", 0, 1.5)], [take("tB", 0, 1.5)]] });
  const { document, api } = montar("studio", p);
  selecionar(document, "s2", "w1", "w2", "tB");
  acao(document, "cortar").click();
  await vi.waitFor(() => expect(api.call).toHaveBeenCalledTimes(1));
  expect(corpos(api)).toEqual([
    { baseRevision: 3, action: { type: "remove", sceneId: "s2", takeId: "tB", wordIds: ["w1", "w2"] } },
  ]);
});

it("duplo clique em Cortar com a chamada em voo envia uma chamada só", async () => {
  const { document, api } = montar("studio");
  let liberar!: (valor: { res: { ok: boolean; status: number }; body: object }) => void;
  api.call.mockImplementationOnce(() => new Promise((resolve) => { liberar = resolve; }) as never);
  selecionar(document, "s1", "w1", "w2");
  acao(document, "cortar").click();
  acao(document, "cortar").click();
  expect(api.call).toHaveBeenCalledTimes(1);
  expect(barra(document)!.getAttribute("aria-busy")).toBe("true");
  liberar({ res: { ok: true, status: 200 }, body: {} });
  await vi.waitFor(() => expect(barra(document)!.getAttribute("aria-busy")).toBe("false"));
  expect(api.call).toHaveBeenCalledTimes(1);
});

/* ---------- 3. restaurar, preservar, mista, atravessa ---------- */

it("restaurar envia uma ação restore só com as cortadas", async () => {
  const p = projeto({ takes: [[take("t1", 0, 1.5, { removed: [{ start: 0.5, end: 1.5 }] })]] });
  const { document, api } = montar("studio", p);
  selecionar(document, "s1", "w2", "w3");
  expect(acoes(document)).toEqual(["ouvir", "restaurar", "preservar", "corrigir"]);
  acao(document, "restaurar").click();
  await vi.waitFor(() => expect(api.call).toHaveBeenCalledTimes(1));
  expect(corpos(api)).toEqual([
    { baseRevision: 3, action: { type: "restore", sceneId: "s1", takeId: "t1", wordIds: ["w2", "w3"] } },
  ]);
});

it("preservar e liberar enviam uma ação cada, com as palavras a que se aplicam", async () => {
  const p = projeto({ takes: [[take("t1", 0, 1.5, { protected: [{ start: 0, end: 0.5 }] })]] });
  const { document, api } = montar("studio", p);
  selecionar(document, "s1", "w1", "w2");
  expect(acoes(document)).toEqual(["ouvir", "preservar", "liberar", "corrigir"]);
  acao(document, "preservar").click();
  await vi.waitFor(() => expect(api.call).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(barra(document)!.getAttribute("aria-busy")).toBe("false"));
  acao(document, "liberar").click();
  await vi.waitFor(() => expect(api.call).toHaveBeenCalledTimes(2));
  expect(corpos(api)).toEqual([
    { baseRevision: 3, action: { type: "protect", sceneId: "s1", takeId: "t1", wordIds: ["w2"] } },
    { baseRevision: 3, action: { type: "unprotect", sceneId: "s1", takeId: "t1", wordIds: ["w1"] } },
  ]);
});

it("seleção mista: Cortar manda só as mantidas e Restaurar só as cortadas", async () => {
  const p = projeto({ takes: [[take("t1", 0, 1.5, { removed: [{ start: 0.5, end: 1 }] })]] });
  const { document, api } = montar("studio", p);
  selecionar(document, "s1", "w1", "w3");
  expect(acoes(document)).toEqual(["ouvir", "cortar", "restaurar", "preservar", "corrigir"]);
  acao(document, "cortar").click();
  await vi.waitFor(() => expect(api.call).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(barra(document)!.getAttribute("aria-busy")).toBe("false"));
  acao(document, "restaurar").click();
  await vi.waitFor(() => expect(api.call).toHaveBeenCalledTimes(2));
  expect(corpos(api).map((corpo) => corpo.action)).toEqual([
    { type: "remove", sceneId: "s1", takeId: "t1", wordIds: ["w1", "w3"] },
    { type: "restore", sceneId: "s1", takeId: "t1", wordIds: ["w2"] },
  ]);
});

it("Cortar não aparece quando há palavra mantida preservada", () => {
  const p = projeto({ takes: [[take("t1", 0, 1.5, { protected: [{ start: 0, end: 0.5 }] })]] });
  const { document } = montar("studio", p);
  selecionar(document, "s1", "w1", "w2");
  expect(acoes(document)).not.toContain("cortar");
});

it("seleção que atravessa takes mostra só Ouvir e o aviso, sem mutação", () => {
  const p = projeto({ takes: [[take("t1", 0, 1.5)], [take("t2", 2, 3)]] });
  const { document, api, state } = montar("studio", p);
  clicar(palavra(document, "s1", "w3"));
  clicar(palavra(document, "s2", "w5"), { shiftKey: true });
  expect(selecionados(state).length).toBeGreaterThan(1);
  expect(acoes(document)).toEqual(["ouvir"]);
  expect(status(document)).toContain("Edite um trecho por vez");
  expect(api.call).not.toHaveBeenCalled();
});

/* ---------- 4. correção e reconciliação ---------- */

const alinhada = (extra: Partial<Correcao> = {}): Correcao => ({
  id: "c1", sourceId: "a", start: 0, end: 1, text: "novo texto", status: "aligned",
  words: [
    { id: "a:sha:c:c1:w000000", text: "novo", start: 0, end: 0.5 },
    { id: "a:sha:c:c1:w000001", text: "texto", start: 0.5, end: 1 },
  ],
  ...extra,
});

it("Corrigir abre o campo com o texto selecionado e Aplicar envia correct; 202 fecha o campo", async () => {
  const { document, api } = montar("studio");
  selecionar(document, "s1", "w1", "w2");
  const form = barra(document)!.querySelector("form")!;
  expect(form.hidden).toBe(true);
  acao(document, "corrigir").click();
  const input = form.querySelector("input")!;
  expect(form.hidden).toBe(false);
  expect(input.value).toBe("um dois");
  input.value = "novo texto";
  api.call.mockResolvedValueOnce({ res: { ok: true, status: 202 }, body: {} });
  submeter(document);
  await vi.waitFor(() => expect(form.hidden).toBe(true));
  expect(corpos(api)).toEqual([
    { baseRevision: 3, action: { type: "correct", sourceId: "a", start: 0, end: 1, text: "novo texto" } },
  ]);
});

it("Cancelar fecha o campo sem enviar nada", () => {
  const { document, api } = montar("studio");
  selecionar(document, "s1", "w1", "w2");
  acao(document, "corrigir").click();
  barra(document)!.querySelector("[data-bar-cancel]")!.click();
  expect(barra(document)!.querySelector("form")!.hidden).toBe(true);
  expect(api.call).not.toHaveBeenCalled();
});

it("correção pendente: a barra avisa e as palavras do intervalo ganham a classe alinhando", () => {
  const p = projeto();
  const { document, state } = montar("studio", p);
  selecionar(document, "s1", "w1", "w2");
  const pendente = projeto({
    revision: 4,
    corrections: [{ id: "c1", sourceId: "a", start: 0, end: 1, text: "x", status: "pending", words: [] }],
  });
  state.set("project", pendente);
  expect(status(document)).toContain("Alinhando correção…");
  const marcadas = document.querySelectorAll("button.word").filter((btn) => btn.classList.contains("alinhando"));
  expect(marcadas.map((btn) => btn.dataset.wordId)).toEqual(["w1", "w2"]);
  expect(selecionados(state)).toEqual([chave("s1", "t1", "w1"), chave("s1", "t1", "w2")]);
});

it("correção alinhada com IDs novos deixa a seleção só com chaves do catálogo, cobrindo as palavras novas", () => {
  const { document, state } = montar("studio");
  selecionar(document, "s1", "w1", "w2");
  state.set("project", projeto({ revision: 4, corrections: [alinhada()] }));
  expect(selecionados(state)).toEqual([
    chave("s1", "t1", "a:sha:c:c1:w000000"),
    chave("s1", "t1", "a:sha:c:c1:w000001"),
  ]);
  const pressionadas = document.querySelectorAll('button.word[aria-pressed="true"]');
  expect(pressionadas.map((btn) => btn.dataset.wordId)).toEqual(["a:sha:c:c1:w000000", "a:sha:c:c1:w000001"]);
  expect(barra(document)!.hidden).toBe(false);
  expect(status(document)).toBe("");
});

it("correção com erro mostra a mensagem na barra e mantém a seleção", () => {
  const { document, state } = montar("studio");
  selecionar(document, "s1", "w1", "w2");
  state.set("project", projeto({
    revision: 4,
    corrections: [{ id: "c1", sourceId: "a", start: 0, end: 1, text: "x", status: "error", words: [], error: "sem áudio" }],
  }));
  expect(status(document)).toContain("sem áudio");
  expect(selecionados(state)).toHaveLength(2);
});

const corrigido = projeto({ revision: 4, corrections: [alinhada()] });
const original = projeto();

it("reconcileSelection mantém o que existe", () => {
  const selecao = new Set([chave("s1", "t1", "w1"), chave("s1", "t1", "w2")]);
  expect([...reconcileSelection(original, original, selecao)]).toEqual([...selecao]);
});

it("reconcileSelection troca o que sumiu pelas palavras novas do mesmo take", () => {
  const selecao = new Set([chave("s1", "t1", "w1"), chave("s1", "t1", "w2")]);
  expect([...reconcileSelection(original, corrigido, selecao)]).toEqual([
    chave("s1", "t1", "a:sha:c:c1:w000000"),
    chave("s1", "t1", "a:sha:c:c1:w000001"),
  ]);
});

it("reconcileSelection não puxa vizinha que já existia fora da seleção", () => {
  const selecao = new Set([chave("s1", "t1", "w1")]);
  const out = reconcileSelection(original, corrigido, selecao);
  expect([...out]).toEqual([chave("s1", "t1", "a:sha:c:c1:w000000")]);
  expect(out.has(chave("s1", "t1", "w3"))).toBe(false);
});

it("reconcileSelection cai quando o take ou a cena some, e com seleção vazia", () => {
  const selecao = new Set([chave("s1", "t1", "w1")]);
  const semTake = projeto({ takes: [[take("t9", 0, 1.5)]] });
  const semCena = { ...original, scenes: [] };
  expect(reconcileSelection(original, semTake, selecao).size).toBe(0);
  expect(reconcileSelection(original, semCena, selecao).size).toBe(0);
  expect(reconcileSelection(original, corrigido, new Set()).size).toBe(0);
});

it("reconcileSelection leva a palavra da zona omitida para o take da mesma cena (Incluir)", () => {
  const antes = projeto({ takes: [[take("t1", 0, 1)]] });
  const depois = projeto({ takes: [[take("t1", 0, 1.5)]] });
  const selecao = new Set([chave("s1", "", "w3")]);
  expect([...reconcileSelection(antes, depois, selecao)]).toEqual([chave("s1", "t1", "w3")]);
});

/* ---------- puras da barra ---------- */

it("selectionBarActions e barActionWords seguem as regras da barra", () => {
  const mantida = { removed: false, protected: false, takeId: "t" };
  const cortada = { removed: true, protected: false, takeId: "t" };
  const preservada = { removed: false, protected: true, takeId: "t" };
  const nomes = (flags: unknown[], unico = true) => selectionBarActions(flags as never, unico).map((item) => item.action);
  expect(nomes([])).toEqual([]);
  expect(nomes([mantida], false)).toEqual(["ouvir"]);
  expect(nomes([{ ...mantida, takeId: "" }])).toEqual(["ouvir", "incluir"]);
  expect(nomes([mantida])).toEqual(["ouvir", "cortar", "preservar", "corrigir"]);
  expect(nomes([cortada])).toEqual(["ouvir", "restaurar", "preservar", "corrigir"]);
  expect(nomes([preservada])).toEqual(["ouvir", "liberar", "corrigir"]);
  expect(nomes([mantida, preservada])).toEqual(["ouvir", "preservar", "liberar", "corrigir"]);
  const palavras = [
    { id: "a", removed: false, protected: false },
    { id: "b", removed: true, protected: true },
  ];
  expect(barActionWords(palavras, "cortar").map((w: { id: string }) => w.id)).toEqual(["a"]);
  expect(barActionWords(palavras, "restaurar").map((w: { id: string }) => w.id)).toEqual(["b"]);
  expect(barActionWords(palavras, "preservar").map((w: { id: string }) => w.id)).toEqual(["a"]);
  expect(barActionWords(palavras, "liberar").map((w: { id: string }) => w.id)).toEqual(["b"]);
});

it("selectionBarBox fica acima da palavra quando cabe e abaixo quando não, sem sair das bordas", () => {
  const bounds = { top: 0, left: 0, right: 500, bottom: 400 };
  const size = { width: 200, height: 40 };
  expect(selectionBarBox({ top: 100, bottom: 120, left: 50 }, size, bounds))
    .toEqual({ top: 52, left: 50, placement: "above" });
  expect(selectionBarBox({ top: 10, bottom: 30, left: 450 }, size, bounds))
    .toEqual({ top: 38, left: 292, placement: "below" });
});

it("aligningKeys e correctionNotice só enxergam correção pendente ou com erro no intervalo", () => {
  const pendente = projeto({
    corrections: [{ id: "c1", sourceId: "a", start: 0, end: 1, text: "x", status: "pending", words: [] }],
  });
  expect([...aligningKeys(pendente)]).toEqual([chave("s1", "t1", "w1"), chave("s1", "t1", "w2")]);
  expect(aligningKeys(original).size).toBe(0);
  expect(correctionNotice(pendente, "a", 0.2, 0.4)).toEqual({ status: "pending" });
  expect(correctionNotice(pendente, "a", 1, 1.5)).toBeNull();
  const erro = projeto({
    corrections: [{ id: "c1", sourceId: "a", start: 0, end: 1, text: "x", status: "error", words: [], error: "falhou" }],
  });
  expect(correctionNotice(erro, "a", 0, 1)).toEqual({ status: "error", error: "falhou" });
  const ambos = projeto({
    corrections: [
      { id: "c1", sourceId: "a", start: 0, end: 1, text: "x", status: "error", words: [], error: "falhou" },
      { id: "c2", sourceId: "a", start: 0, end: 1, text: "y", status: "pending", words: [] },
    ],
  });
  expect(correctionNotice(ambos, "a", 0, 1)).toEqual({ status: "pending" });
});

/* ---------- 6. teclado ---------- */

it("Enter, Space, ContextMenu e Shift+F10 levam o foco à barra; Esc devolve a palavra", () => {
  const { document } = montar("studio");
  const teclas = [
    { key: "Enter" }, { key: " " }, { key: "ContextMenu" }, { key: "F10", shiftKey: true },
  ];
  for (const tecla of teclas) {
    const w2 = palavra(document, "s1", "w2");
    w2.focus();
    w2.dispatchEvent({ type: "keydown", ...tecla });
    expect(document.activeElement?.dataset.barAction).toBe("ouvir");
    document.activeElement!.dispatchEvent({ type: "keydown", key: "Escape" });
    expect(document.activeElement?.dataset.wordId).toBe("w2");
  }
});

it("na barra, setas, Home e End movem entre as ações", () => {
  const { document } = montar("studio");
  selecionar(document, "s1", "w1", "w2");
  palavra(document, "s1", "w2").dispatchEvent({ type: "keydown", key: "Enter" });
  const ativa = () => document.activeElement?.dataset.barAction;
  const tecla = (key: string) => document.activeElement!.dispatchEvent({ type: "keydown", key });
  expect(ativa()).toBe("ouvir");
  tecla("ArrowRight");
  expect(ativa()).toBe("cortar");
  tecla("ArrowDown");
  expect(ativa()).toBe("preservar");
  tecla("ArrowLeft");
  expect(ativa()).toBe("cortar");
  tecla("End");
  expect(ativa()).toBe("corrigir");
  tecla("ArrowRight");
  expect(ativa()).toBe("ouvir");
  tecla("ArrowLeft");
  expect(ativa()).toBe("corrigir");
  tecla("Home");
  expect(ativa()).toBe("ouvir");
  tecla("Escape");
  expect(document.activeElement?.dataset.wordId).toBe("w2");
});

/* ---------- 7. etapa ---------- */

it("trocar de etapa esconde a barra e fecha o menu de cena; só um novo clique a reabre", () => {
  const { document, state } = montar("studio");
  selecionar(document, "s1", "w1", "w2");
  expect(barra(document)!.hidden).toBe(false);
  document.querySelector("[data-scene-menu]")!.click();
  expect(document.querySelector('[role="menu"]')).toBeTruthy();

  state.set("stage", "revisao");
  expect(barra(document)!.hidden).toBe(true);
  expect(document.querySelector('[role="menu"]')).toBeNull();

  state.set("stage", "edicao");
  expect(barra(document)!.hidden).toBe(true);

  clicar(palavra(document, "s1", "w3"));
  expect(barra(document)!.hidden).toBe(false);
});

it("a barra não aparece fora da etapa de edição nem sem seleção", () => {
  const { document, state } = montar("studio", projeto(), "revisao");
  expect(barra(document)!.hidden).toBe(true);
  clicar(palavra(document, "s1", "w1"));
  expect(barra(document)!.hidden).toBe(true);
  state.set("stage", "edicao");
  clicar(palavra(document, "s1", "w2"));
  expect(barra(document)!.hidden).toBe(false);
  state.set("selection", new Set());
  expect(barra(document)!.hidden).toBe(true);
});

/* ---------- 8. legado ---------- */

it.each([[undefined], ["legacy" as const]])("legado (ui=%s): clique em riscado faz um POST restore e não há barra", async (ui) => {
  const p = projeto({ takes: [[take("t1", 0, 1.5, { removed: [{ start: 0.5, end: 1 }] })]] });
  const { document, api } = montar(ui, p);
  expect(barra(document)).toBeNull();
  clicar(palavra(document, "s1", "w2"));
  await vi.waitFor(() => expect(api.call).toHaveBeenCalledTimes(1));
  expect(corpos(api)).toEqual([
    { baseRevision: 3, action: { type: "restore", sceneId: "s1", takeId: "t1", wordIds: ["w2"] } },
  ]);
  expect(barra(document)).toBeNull();
});

it("legado: Enter na palavra abre o menu Ações do trecho", () => {
  const { document } = montar(undefined);
  const w1 = palavra(document, "s1", "w1");
  w1.focus();
  w1.dispatchEvent({ type: "keydown", key: "Enter" });
  expect(document.querySelector('[aria-label="Ações do trecho"]')).toBeTruthy();
  expect(barra(document)).toBeNull();
});

it("legado: correção alinhada tira da seleção as chaves que sumiram, sem reconciliar", () => {
  const { document, state } = montar(undefined);
  selecionar(document, "s1", "w1", "w3");
  expect(selecionados(state)).toHaveLength(3);
  state.set("project", projeto({ revision: 4, corrections: [alinhada()] }));
  expect(selecionados(state)).toEqual([chave("s1", "t1", "w3")]);
});

/* ---------- revisão do PR 3: envelope, Ouvir, âncora, direção, reflow ---------- */

const EU_FUI: Palavra[] = [
  { id: "w1", text: "eu", start: 1, end: 1.3 },
  { id: "w2", text: "fui", start: 1.8, end: 2 },
];
const euFui = () => projeto({ takes: [[take("t1", 1, 2)]], palavras: EU_FUI });
const euJaFui = () => projeto({
  revision: 4,
  takes: [[take("t1", 1, 2)]],
  palavras: EU_FUI,
  corrections: [{
    id: "c1", sourceId: "a", start: 1, end: 2, text: "eu já fui", status: "aligned",
    words: [
      { id: "a:sha:c:c1:w000000", text: "eu", start: 1, end: 1.3 },
      { id: "a:sha:c:c1:w000001", text: "já", start: 1.4, end: 1.7 },
      { id: "a:sha:c:c1:w000002", text: "fui", start: 1.8, end: 2 },
    ],
  }],
});
const NOVAS = ["a:sha:c:c1:w000000", "a:sha:c:c1:w000001", "a:sha:c:c1:w000002"];

it("reconcileSelection por envelope: a palavra que a correção põe na pausa entra na seleção", () => {
  const selecao = new Set([chave("s1", "t1", "w1"), chave("s1", "t1", "w2")]);
  expect([...reconcileSelection(euFui(), euJaFui(), selecao)]).toEqual(NOVAS.map((id) => chave("s1", "t1", id)));
});

it("reconcileSelection: a revisão que volta devolve as chaves originais", () => {
  const novas = new Set(NOVAS.map((id) => chave("s1", "t1", id)));
  expect([...reconcileSelection(euJaFui(), euFui(), novas)]).toEqual([chave("s1", "t1", "w1"), chave("s1", "t1", "w2")]);
});

it("a correção que preenche a pausa deixa a seleção com as 3 palavras e Cortar envia as 3", async () => {
  const { document, api, state } = montar("studio", euFui());
  selecionar(document, "s1", "w1", "w2");
  state.set("project", euJaFui());
  expect(selecionados(state)).toEqual(NOVAS.map((id) => chave("s1", "t1", id)));
  acao(document, "cortar").click();
  await vi.waitFor(() => expect(api.call).toHaveBeenCalledTimes(1));
  expect(corpos(api)[0].action).toEqual({ type: "remove", sceneId: "s1", takeId: "t1", wordIds: NOVAS });
});

it("a revisão que volta, pelo estado, devolve a seleção às palavras originais", () => {
  const { document, state } = montar("studio", euFui());
  selecionar(document, "s1", "w1", "w2");
  state.set("project", euJaFui());
  state.set("project", euFui());
  expect(selecionados(state)).toEqual([chave("s1", "t1", "w1"), chave("s1", "t1", "w2")]);
});

const duasCenas = () => projeto({ takes: [[take("t1", 0, 1.5)], [take("t2", 2, 3)]] });

it("listenTarget: um grupo ouve a Mídia original; entre trechos, a montagem pelas mantidas", () => {
  const p = duasCenas();
  const sel = (...ids: Array<[string, string, string]>) => new Set(ids.map(([c, t, w]) => chave(c, t, w)));
  expect(listenTarget(p, new Set())).toBeNull();
  expect(listenTarget(p, sel(["s1", "t1", "w2"], ["s1", "t1", "w3"])))
    .toEqual({ kind: "original", sourceId: "a", start: 0.5, end: 1.5 });
  // w3 começa em 1,0 na montagem; w5 vem depois dos 1,5 s da cena 1 e dura 0,5 s.
  expect(listenTarget(p, sel(["s1", "t1", "w3"], ["s2", "t2", "w5"])))
    .toEqual({ kind: "montagem", start: 1, end: 2 });
  expect(listenTarget(p, sel(["s1", "t1", "w1"], ["s2", "t2", "w6"])))
    .toEqual({ kind: "montagem", start: 0, end: 2.5 });
});

it("listenTarget: sem palavra mantida entre trechos, só o primeiro grupo na Mídia original", () => {
  const p = projeto({ takes: [
    [take("t1", 0, 1.5, { removed: [{ start: 0.5, end: 1 }] })],
    [take("t2", 2, 3, { removed: [{ start: 2, end: 2.5 }] })],
  ] });
  expect(listenTarget(p, new Set([chave("s1", "t1", "w2"), chave("s2", "t2", "w5")])))
    .toEqual({ kind: "original", sourceId: "a", start: 0.5, end: 1 });
});

it("Ouvir entre trechos toca a montagem; num trecho só, a Mídia original com 0,7 s de contexto", () => {
  const { document, player, state } = montar("studio", duasCenas());
  clicar(palavra(document, "s1", "w3"));
  clicar(palavra(document, "s2", "w5"), { shiftKey: true });
  player.seek.mockClear();
  acao(document, "ouvir").click();
  expect(player.playMontage).toHaveBeenCalledWith(1, 2);
  expect(player.playOriginal).not.toHaveBeenCalled();

  state.set("selection", new Set());
  clicar(palavra(document, "s1", "w3"));
  acao(document, "ouvir").click();
  expect(player.playMontage).toHaveBeenCalledTimes(1);
  const [fonte, inicio, fim] = player.playOriginal.mock.calls[0]!;
  expect(fonte).toBe("a");
  expect(inicio).toBeCloseTo(0.3);
  expect(fim).toBe(1.5);
});

it("Enter na palavra do meio ancora a barra nela e Esc devolve o foco a ela, não à última", () => {
  const { document } = montar("studio");
  selecionar(document, "s1", "w1", "w3");
  palavra(document, "s1", "w2").dispatchEvent({ type: "keydown", key: "Enter" });
  expect(document.activeElement?.dataset.barAction).toBe("ouvir");
  document.activeElement!.dispatchEvent({ type: "keydown", key: "Escape" });
  expect(document.activeElement?.dataset.wordId).toBe("w2");
});

it("seleção de cena pelo chip, sem foco: a barra aparece e Esc volta a uma palavra selecionada", () => {
  const p = projeto();
  p.analyses[0]!.visual = [{ id: "v1", sourceId: "a", start: 0, end: 1, text: "Plano" }] as never[];
  p.scenes[0]!.support = [{ visualId: "v1", offsetFrames: 0, durationFrames: 10 }] as never[];
  const { document, state } = montar("studio", p);
  document.querySelector(".chip-apoio")!.click();
  expect(selecionados(state)).toHaveLength(3);
  expect(barra(document)!.hidden).toBe(false);
  const ouvir = acao(document, "ouvir");
  ouvir.focus();
  ouvir.dispatchEvent({ type: "keydown", key: "Escape" });
  const foco = document.activeElement!;
  expect(foco.dataset.wordId).toBeDefined();
  expect((state.get("selection") as Set<string>).has(chave(foco.dataset.scene!, foco.dataset.take!, foco.dataset.wordId!))).toBe(true);
});

it("com a palavra-foco fora dos limites do texto, a barra se ancora numa selecionada visível", () => {
  const original = El.prototype.getBoundingClientRect;
  const rect = (top: number, left = 30) => ({ left, top, right: left + 30, bottom: top + 20, width: 30, height: 20 });
  El.prototype.getBoundingClientRect = function (this: El) {
    if (this.id === "texto") return { left: 0, top: 0, right: 500, bottom: 600, width: 500, height: 600 };
    if (this.dataset.wordId === "w1") return rect(100);
    if (this.dataset.wordId === "w3") return rect(5000);
    return original.call(this);
  };
  try {
    const { document } = montar("studio");
    selecionar(document, "s1", "w1", "w3");
    const caixa = barra(document)!;
    expect(caixa.hidden).toBe(false);
    // Acima de w1 (100 − 8 − altura 20), alinhada à esquerda de w1.
    expect({ top: caixa.style.top, left: caixa.style.left, lugar: caixa.dataset.placement })
      .toEqual({ top: "72px", left: "30px", lugar: "above" });
  } finally {
    El.prototype.getBoundingClientRect = original;
  }
});

it("seleção feita de trás para frente segue estendendo pela esquerda depois de a correção trocar os IDs", () => {
  const { document, state } = montar("studio", projeto({ takes: [[take("t1", 0, 2.5)]] }));
  clicar(palavra(document, "s1", "w4"));
  clicar(palavra(document, "s1", "w2"), { shiftKey: true });
  expect(selecionados(state)).toHaveLength(3);
  const novas = ["n1", "n2", "n3"].map((n) => `a:sha:c:c1:${n}`);
  state.set("project", projeto({
    revision: 4,
    takes: [[take("t1", 0, 2.5)]],
    corrections: [{
      id: "c1", sourceId: "a", start: 0.5, end: 2, text: "x y z", status: "aligned",
      words: [
        { id: novas[0]!, text: "x", start: 0.5, end: 1 },
        { id: novas[1]!, text: "y", start: 1, end: 1.5 },
        { id: novas[2]!, text: "z", start: 1.5, end: 2 },
      ],
    }],
  }));
  expect(selecionados(state)).toEqual(novas.map((id) => chave("s1", "t1", id)));
  palavra(document, "s1", novas[0]!).dispatchEvent({ type: "keydown", key: "ArrowLeft", shiftKey: true });
  expect(selecionados(state)).toEqual([chave("s1", "t1", "w1"), ...novas.map((id) => chave("s1", "t1", id))]);
});

it("depois da primeira pintura, rolar ou repintar sem mudar a seleção não mede a barra de novo", () => {
  const original = El.prototype.getBoundingClientRect;
  let medidas = 0;
  El.prototype.getBoundingClientRect = function (this: El) {
    if (this.classList.contains("texto-barra")) medidas += 1;
    return original.call(this);
  };
  try {
    const { document, state } = montar("studio");
    selecionar(document, "s1", "w1", "w2");
    expect(medidas).toBeGreaterThan(0);
    const antes = medidas;
    document.getElementById("texto")!.dispatchEvent({ type: "scroll", bubbles: false });
    state.set("selection", new Set(selecionados(state)));
    expect(medidas).toBe(antes);
    // Seleção maior muda o resumo da barra: aí sim ela é medida de novo.
    clicar(palavra(document, "s1", "w3"), { shiftKey: true });
    expect(medidas).toBeGreaterThan(antes);
  } finally {
    El.prototype.getBoundingClientRect = original;
  }
});
