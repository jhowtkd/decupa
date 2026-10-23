import { afterEach, expect, it, vi } from "vitest";
import { createState } from "./state.js";
import { contadorDaBusca, indiceDeBusca, mountBusca, normalizarBusca, ocorrencias } from "./studio-busca.js";
import { mountTexto, selectionKey } from "./texto.js";
import { El, installDom, type FakeDocument } from "./fake-dom.test-helper.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Palavra = { id: string; text: string; start: number; end: number };
type Take = { id: string; sourceId: string; start: number; end: number; removed: never[]; protected: never[] };

const take = (id: string, start: number, end: number): Take =>
  ({ id, sourceId: "a", start, end, removed: [], protected: [] });

function projeto(cenas: Take[][], palavras: Palavra[]) {
  return {
    id: "p", revision: 1, previewRevision: null as number | null, preparation: null, corrections: [] as unknown[],
    assembly: {
      name: "Montagem", fps: { num: 25, den: 1 }, width: 320, height: 240,
      sources: [{ id: "a", name: "fala.mp4", included: true, hasVideo: false }], tracks: [],
    },
    analyses: [{ sourceId: "a", status: "ready", words: palavras, visual: [], speech: [] }],
    scenes: cenas.map((takes, i) => ({
      id: `s${i + 1}`, objective: `Cena ${i + 1}`, rationale: "", takes, support: [], gaps: [],
    })),
  };
}

// s1: t1a [0,1] (um, Dois,) + t1b [1,1.5] (tres); s2: t2 [4,5.5] (seis, Sétima, tres).
// Fora da montagem: quatro tres (perto de s1) e nove (depois de s2, perto de s2).
const PALAVRAS: Palavra[] = [
  { id: "w1", text: "um", start: 0, end: 0.5 },
  { id: "w2", text: "Dois,", start: 0.5, end: 1 },
  { id: "w3", text: "tres", start: 1, end: 1.5 },
  { id: "w4", text: "quatro", start: 1.5, end: 2 },
  { id: "w5", text: "tres", start: 2, end: 2.5 },
  { id: "w6", text: "seis", start: 4, end: 4.5 },
  { id: "w7", text: "Sétima!", start: 4.5, end: 5 },
  { id: "w8", text: "tres", start: 5, end: 5.5 },
  { id: "w9", text: "nove", start: 6, end: 6.5 },
];

const base = () => projeto([[take("t1a", 0, 1), take("t1b", 1, 1.5)], [take("t2", 4, 5.5)]], PALAVRAS);
const k = (cena: string, take: string, id: string) => selectionKey(cena, take, id);

/* ---------- puras ---------- */

it("normalizarBusca ignora acento, caixa e pontuação", () => {
  expect(normalizarBusca("  Ação, ÉLÉ!!  ")).toBe("acao ele");
  expect(normalizarBusca("São-Paulo...")).toBe("sao paulo");
  expect(normalizarBusca("?!")).toBe("");
  expect(normalizarBusca(null)).toBe("");
});

it("ocorrencias acha palavra sem acento, caixa nem pontuação", () => {
  const p = base();
  expect(ocorrencias(p, "SETIMA").map((o) => o.chaves)).toEqual([[k("s2", "t2", "w7")]]);
  expect(ocorrencias(p, "dois").map((o) => o.chaves)).toEqual([[k("s1", "t1a", "w2")]]);
  expect(ocorrencias(p, "!!")).toEqual([]);
  expect(ocorrencias(p, "inexistente")).toEqual([]);
});

it("a ocorrência começa no início de uma palavra e não se sobrepõe", () => {
  const palavras: Palavra[] = ["Montagem", "gravação", "Ação", "aa", "aa", "aa"]
    .map((text, i) => ({ id: `m${i + 1}`, text, start: i, end: i + 0.5 }));
  const p = projeto([[take("t", 0, 5.5)]], palavras);
  const chaves = (consulta: string) => ocorrencias(p, consulta).map((o) => o.chaves.map((c) => c.split("\0")[2]));
  expect(chaves("mont")).toEqual([["m1"]]);
  expect(chaves("acao")).toEqual([["m3"]]);
  expect(chaves("cao")).toEqual([]);
  expect(chaves("agem")).toEqual([]);
  // "aa aa" cabe uma vez em "aa aa aa": a segunda tentativa começaria dentro da primeira.
  expect(chaves("aa aa")).toEqual([["m4", "m5"]]);
  expect(chaves("aa")).toEqual([["m4"], ["m5"], ["m6"]]);
});

it("uma frase atravessa takes da mesma cena, mas não cenas", () => {
  const p = base();
  expect(ocorrencias(p, "dois tres").map((o) => o.chaves)).toEqual([[k("s1", "t1a", "w2"), k("s1", "t1b", "w3")]]);
  // tres (fim de s1) e seis (começo de s2) são vizinhas no documento, mas de cenas diferentes.
  expect(ocorrencias(p, "tres seis")).toEqual([]);
});

it("o material fora da montagem conta uma vez só, na zona da cena mais próxima no tempo", () => {
  const p = base();
  // "nove" aparece na zona de toda cena, mas conta uma vez: na de s2 (take mais perto).
  expect(ocorrencias(p, "nove")).toEqual([{ chaves: [k("s2", "", "w9")], omitida: true, fonte: "a" }]);
  // "quatro tres" fica na zona de s1, e a frase cobre as duas palavras não usadas.
  expect(ocorrencias(p, "quatro tres")).toEqual([
    { chaves: [k("s1", "", "w4"), k("s1", "", "w5")], omitida: true, fonte: "a" },
  ]);
  // "tres": fala de s1, zona de s1 e fala de s2, na ordem do documento.
  expect(ocorrencias(p, "tres").map((o) => [o.chaves, o.omitida])).toEqual([
    [[k("s1", "t1b", "w3")], false],
    [[k("s1", "", "w5")], true],
    [[k("s2", "t2", "w8")], false],
  ]);
});

it("palavra cortada continua pesquisável e projeto sem cenas não tem ocorrência", () => {
  const p = base();
  // Outra revisão: o índice em cache do conteúdo anterior não vale para o projeto mutado.
  p.revision = 77;
  p.scenes[0]!.takes[0]!.removed = [{ start: 0.5, end: 1 }] as never[];
  expect(ocorrencias(p, "dois")).toHaveLength(1);
  expect(ocorrencias({ ...p, scenes: [] }, "um")).toEqual([]);
});

it("indiceDeBusca reaproveita o índice enquanto o conteúdo não muda, mesmo com objeto novo", () => {
  const p = base();
  expect(indiceDeBusca(p)).toBe(indiceDeBusca(p));
  expect(indiceDeBusca(base())).toBe(indiceDeBusca(p));
  expect(indiceDeBusca({ ...base(), revision: 2 })).not.toBe(indiceDeBusca(p));
});

const correcao = (status: "pending" | "aligned", words: Palavra[] = []) =>
  ({ id: "c1", sourceId: "a", start: 2, end: 2.5, text: "tres", status, words });
const treNova: Palavra = { id: "a:sha:c:c1:w000000", text: "tres", start: 2, end: 2.5 };

it("indiceDeBusca: a correção que passa de pending a aligned na mesma revisão gera outro índice", () => {
  const pendente = { ...base(), corrections: [correcao("pending")] };
  const alinhada = { ...base(), corrections: [correcao("aligned", [treNova])] };
  expect(indiceDeBusca({ ...base(), corrections: [correcao("pending")] })).toBe(indiceDeBusca(pendente));
  expect(indiceDeBusca(alinhada)).not.toBe(indiceDeBusca(pendente));
  expect(ocorrencias(alinhada, "tres").map((o) => o.chaves[0])).toContain(k("s1", "", treNova.id));
  expect(ocorrencias(pendente, "tres").map((o) => o.chaves[0])).toContain(k("s1", "", "w5"));
});

it("indiceDeBusca: análise com outro número de palavras ou status gera outro índice", () => {
  const p = base();
  const mais = { ...base(), analyses: [{ ...p.analyses[0]!, words: [...PALAVRAS, { id: "w10", text: "dez", start: 7, end: 7.5 }] }] };
  const outroStatus = { ...base(), analyses: [{ ...p.analyses[0]!, status: "running" }] };
  expect(indiceDeBusca(mais)).not.toBe(indiceDeBusca(p));
  expect(indiceDeBusca(outroStatus)).not.toBe(indiceDeBusca(mais));
});

it("contadorDaBusca: n de m, nenhuma ocorrência e fora da montagem", () => {
  const dentro = { chaves: ["x"], omitida: false, fonte: null };
  const fora = { chaves: ["y"], omitida: true, fonte: "a" };
  expect(contadorDaBusca("", [], -1)).toBe("");
  expect(contadorDaBusca("?!", [dentro], 0)).toBe("");
  expect(contadorDaBusca("x", [], -1)).toBe("Nenhuma ocorrência");
  expect(contadorDaBusca("x", [dentro, fora], 0)).toBe("1 de 2");
  expect(contadorDaBusca("x", [dentro, fora], 1)).toBe("2 de 2 · fora da montagem");
});

/* ---------- DOM ---------- */

const HTML = '<main id="center"><div id="textoHead"><span class="spacer"></span><span id="undoSlot"></span></div>'
  + '<section id="texto"></section></main><div id="dropzone" hidden></div>';

function montar(p = base()) {
  const document = installDom(HTML);
  const state = createState({ selection: new Set<string>(), playhead: null, stage: "edicao" });
  const api = {
    call: vi.fn(async (..._args: unknown[]) => ({ res: { ok: true, status: 200 }, body: {} })),
    notifyError: vi.fn(),
  };
  const player = { seek: vi.fn(), playOriginal: vi.fn(), previewBusy: () => false };
  mountTexto({ state, api, player, ui: "studio" });
  mountBusca({ state });
  return { state, api, document, p };
}

const toggle = (d: FakeDocument) => d.querySelector(".texto-busca-toggle")!;
const caixa = (d: FakeDocument) => d.getElementById("textoBusca")!;
const campo = (d: FakeDocument) => caixa(d).querySelector("input")!;
const contador = (d: FakeDocument) => caixa(d).querySelector(".busca-contador")!.textContent;
const botao = (d: FakeDocument, cena: string, id: string) =>
  d.querySelectorAll("button.word").find((b) => b.dataset.scene === cena && b.dataset.wordId === id)!;

function digitar(d: FakeDocument, texto: string) {
  const input = campo(d);
  input.value = texto;
  input.dispatchEvent({ type: "input" });
}
const tecla = (d: FakeDocument, key: string, shiftKey = false) =>
  campo(d).dispatchEvent({ type: "keydown", key, shiftKey });

it("monta o botão antes do undoSlot e a caixa antes do texto, fechada e sem cenas escondida", () => {
  const { document, state } = montar();
  expect(toggle(document).hidden).toBe(true);
  state.set("project", base());
  const head = document.getElementById("textoHead")!;
  const filhos = head.children;
  expect(filhos.indexOf(toggle(document))).toBe(filhos.indexOf(document.getElementById("undoSlot")!) - 1);
  const center = document.getElementById("center")!;
  expect(center.children.indexOf(caixa(document))).toBe(center.children.indexOf(document.getElementById("texto")!) - 1);
  expect(toggle(document).hidden).toBe(false);
  expect(caixa(document).hidden).toBe(true);
});

it("abrir, digitar, navegar e fechar a busca não chama a API nem mexe na seleção", () => {
  const { document, state, api } = montar();
  state.set("project", base());
  toggle(document).click();
  digitar(document, "tres");
  tecla(document, "Enter");
  tecla(document, "Enter", true);
  caixa(document).querySelector('[data-busca-passo="1"]')!.click();
  caixa(document).querySelector("[data-busca-fechar]")!.click();
  toggle(document).click();
  tecla(document, "Escape");
  expect(api.call).not.toHaveBeenCalled();
  expect((state.get("selection") as Set<string>).size).toBe(0);
});

it("a busca marca as ocorrências do texto, a atual e as fora da montagem", () => {
  const { document, state } = montar();
  state.set("project", base());
  toggle(document).click();
  expect(toggle(document).getAttribute("aria-expanded")).toBe("true");
  expect(caixa(document).hidden).toBe(false);
  digitar(document, "tres");
  const classe = (cena: string, id: string) => botao(document, cena, id).className.split(/\s+/);
  expect(classe("s1", "w3")).toEqual(expect.arrayContaining(["busca", "busca-atual"]));
  expect(classe("s2", "w8")).toContain("busca");
  expect(classe("s2", "w8")).not.toContain("busca-atual");
  expect(classe("s1", "w1")).not.toContain("busca");
  expect(contador(document)).toBe("1 de 3");
});

it("Enter vai à próxima, Shift+Enter à anterior, com volta circular, e o contador acompanha", () => {
  const { document, state } = montar();
  state.set("project", base());
  toggle(document).click();
  digitar(document, "tres");
  const passos: string[] = [];
  for (const [key, shift] of [["Enter", false], ["Enter", false], ["Enter", false], ["Enter", true], ["Enter", true]] as const) {
    tecla(document, key, shift);
    passos.push(contador(document)!);
  }
  expect(passos).toEqual(["2 de 3 · fora da montagem", "3 de 3", "1 de 3", "3 de 3", "2 de 3 · fora da montagem"]);
});

it("ocorrência fora da montagem abre a zona da cena atribuída e marca a palavra", () => {
  const { document, state } = montar();
  state.set("project", base());
  toggle(document).click();
  digitar(document, "nove");
  expect(contador(document)).toBe("1 de 1 · fora da montagem");
  const zona = document.querySelectorAll("details").find((d) => d.dataset.scene === "s2")!;
  expect(zona.open).toBe(true);
  const outraZona = document.querySelectorAll("details").find((d) => d.dataset.scene === "s1")!;
  expect(outraZona.open).toBe(false);
  const classes = botao(document, "s2", "w9").className.split(/\s+/);
  expect(classes).toEqual(expect.arrayContaining(["busca-omitida", "busca-atual"]));
  expect(classes).not.toContain("busca");
});

it("Esc fecha e a chave busca traz focar e revelar da atual; o foco vai à palavra", () => {
  const { document, state } = montar();
  state.set("project", base());
  toggle(document).click();
  digitar(document, "tres");
  tecla(document, "Enter");
  tecla(document, "Enter");
  tecla(document, "Escape");
  expect(caixa(document).hidden).toBe(true);
  expect(toggle(document).getAttribute("aria-expanded")).toBe("false");
  const busca = state.get("busca") as { chaves: string[]; focar: boolean; revelar: { chave: string; fonte: string | null } };
  expect(busca.focar).toBe(true);
  expect(busca.revelar).toEqual({ chave: k("s2", "t2", "w8"), fonte: null });
  expect(busca.chaves).toEqual([]);
  expect(document.activeElement?.dataset.wordId).toBe("w8");
  expect(botao(document, "s2", "w8").className).not.toContain("busca");
});

it("Ctrl+F ou Meta+F com o alvo em #center abre a busca; fora de #center não abre", () => {
  const { document, state } = montar();
  state.set("project", base());
  const fora = document.getElementById("dropzone")!;
  document.dispatchEvent({ type: "keydown", key: "f", ctrlKey: true, target: fora });
  expect(caixa(document).hidden).toBe(true);
  document.dispatchEvent({ type: "keydown", key: "f", target: botao(document, "s1", "w1") });
  expect(caixa(document).hidden).toBe(true);
  document.dispatchEvent({ type: "keydown", key: "f", ctrlKey: true, target: botao(document, "s1", "w1") });
  expect(caixa(document).hidden).toBe(false);
  expect(document.activeElement).toBe(campo(document));
  tecla(document, "Escape");
  document.dispatchEvent({ type: "keydown", key: "F", metaKey: true, target: botao(document, "s1", "w1") });
  expect(caixa(document).hidden).toBe(false);
});

it("a busca parte da primeira palavra selecionada ao abrir", () => {
  const { document, state } = montar();
  state.set("project", base());
  state.set("selection", new Set([k("s1", "", "w5")]));
  toggle(document).click();
  digitar(document, "tres");
  expect(contador(document)).toBe("2 de 3 · fora da montagem");
});

it("sem ocorrência o contador avisa e os passos ficam desabilitados", () => {
  const { document, state } = montar();
  state.set("project", base());
  toggle(document).click();
  digitar(document, "zzz");
  expect(contador(document)).toBe("Nenhuma ocorrência");
  for (const passo of caixa(document).querySelectorAll("[data-busca-passo]")) expect(passo.disabled).toBe(true);
});

it("um projeto novo mantém a busca aberta e refaz a lista sem rolar", () => {
  const { document, state } = montar();
  state.set("project", base());
  toggle(document).click();
  digitar(document, "tres");
  const revelar = vi.fn();
  (El.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = revelar;
  try {
    const p2 = base();
    p2.revision = 2;
    state.set("project", p2);
    expect(contador(document)).toBe("1 de 3");
    expect(revelar).not.toHaveBeenCalled();
  } finally {
    delete (El.prototype as unknown as { scrollIntoView?: () => void }).scrollIntoView;
  }
});

/* ---------- janela virtualizada ---------- */

function virtualGeometry(document: FakeDocument) {
  const original = El.prototype.getBoundingClientRect;
  const root = document.getElementById("texto")!;
  root.clientHeight = 200;
  root.scrollTop = 0;
  El.prototype.getBoundingClientRect = function () {
    if (this.id === "texto") return { left: 0, top: 0, right: 500, bottom: root.clientHeight, width: 500, height: root.clientHeight };
    const sceneId = this.dataset.sceneSection;
    if (sceneId) {
      const top = (Number(sceneId.slice(1)) - 1) * 300 - root.scrollTop;
      return { left: 0, top, right: 500, bottom: top + 240, width: 500, height: 240 };
    }
    return original.call(this);
  };
  const rolagens: El[] = [];
  (El.prototype as unknown as { scrollIntoView: (this: El) => void }).scrollIntoView = function (this: El) { rolagens.push(this); };
  return {
    rolagens,
    restore() {
      El.prototype.getBoundingClientRect = original;
      delete (El.prototype as unknown as { scrollIntoView?: () => void }).scrollIntoView;
    },
  };
}

function vinte() {
  const palavras: Palavra[] = Array.from({ length: 20 }, (_, i) => ({ id: `w${i + 1}`, text: `palavra${i + 1}`, start: i, end: i + 0.5 }));
  // Fora da montagem: mais perto do take de s20.
  palavras.push({ id: "w21", text: "zeta", start: 25, end: 25.5 });
  return projeto(Array.from({ length: 20 }, (_, i) => [take(`t${i + 1}`, i, i + 0.5)]), palavras);
}

it("acha palavra de cena distante, monta a cena, marca o botão e rola até ele", () => {
  const { document, state } = montar();
  const geometria = virtualGeometry(document);
  try {
    state.set("project", vinte());
    const cena = () => document.querySelector('[data-scene-section="s18"]')!;
    expect(cena().dataset.sceneMounted).toBe("false");
    toggle(document).click();
    digitar(document, "palavra18");
    expect(contador(document)).toBe("1 de 1");
    expect(cena().dataset.sceneMounted).toBe("true");
    const btn = botao(document, "s18", "w18");
    expect(btn.classList.contains("busca-atual")).toBe(true);
    expect(geometria.rolagens).toContain(btn);
  } finally {
    geometria.restore();
  }
});

it("ocorrência fora da montagem em cena desmontada abre a zona ao montar a cena", () => {
  const { document, state } = montar();
  const geometria = virtualGeometry(document);
  try {
    state.set("project", vinte());
    expect(document.querySelector('[data-scene-section="s20"]')!.dataset.sceneMounted).toBe("false");
    toggle(document).click();
    digitar(document, "zeta");
    expect(contador(document)).toBe("1 de 1 · fora da montagem");
    const secao = document.querySelector('[data-scene-section="s20"]')!;
    expect(secao.dataset.sceneMounted).toBe("true");
    expect(secao.querySelector("details")!.open).toBe(true);
    const btn = botao(document, "s20", "w21");
    expect(btn.className.split(/\s+/)).toEqual(expect.arrayContaining(["busca-omitida", "busca-atual"]));
    expect(geometria.rolagens).toContain(btn);
  } finally {
    geometria.restore();
  }
});

/* ---------- revisão do PR 3 ---------- */

it("Ctrl+F com o texto escondido não abre a caixa nem tira o atalho do navegador", () => {
  const { document, state } = montar();
  state.set("project", base());
  const prevenidos: boolean[] = [];
  document.addEventListener("keydown", (ev) => prevenidos.push(ev.defaultPrevented));
  const entrega = document.createElement("div");
  entrega.id = "delivery";
  document.getElementById("center")!.appendChild(entrega);

  document.getElementById("textoHead")!.hidden = true;
  document.getElementById("texto")!.hidden = true;
  document.dispatchEvent({ type: "keydown", key: "f", ctrlKey: true, target: entrega });
  expect(caixa(document).hidden).toBe(true);
  expect(prevenidos).toEqual([false]);

  document.getElementById("textoHead")!.hidden = false;
  document.getElementById("texto")!.hidden = false;
  document.dispatchEvent({ type: "keydown", key: "f", ctrlKey: true, target: entrega });
  expect(caixa(document).hidden).toBe(false);
  expect(prevenidos).toEqual([false, true]);
});

it("fora da Edição a busca fecha, limpa as marcas, não foca nada e não reabre sozinha", () => {
  const { document, state } = montar();
  state.set("project", base());
  toggle(document).click();
  digitar(document, "tres");
  expect((state.get("busca") as { chaves: string[] }).chaves.length).toBeGreaterThan(0);

  state.set("stage", "revisao");
  expect(caixa(document).hidden).toBe(true);
  expect(toggle(document).getAttribute("aria-expanded")).toBe("false");
  const busca = state.get("busca") as { chaves: string[]; omitidas: string[]; atuais: string[]; focar: boolean; revelar: unknown };
  expect(busca).toMatchObject({ chaves: [], omitidas: [], atuais: [], focar: false, revelar: null });
  expect(document.activeElement?.dataset.wordId).toBeUndefined();
  expect(botao(document, "s1", "w3").className).not.toContain("busca");

  state.set("stage", "edicao");
  expect(caixa(document).hidden).toBe(true);
});

it("a ocorrência atual que some segue na mais perto de onde estava", () => {
  const { document, state } = montar();
  state.set("project", base());
  toggle(document).click();
  digitar(document, "tres");
  tecla(document, "Enter");
  expect(contador(document)).toBe("2 de 3 · fora da montagem");

  // A palavra da 2ª ocorrência (w5) é refeita por uma correção alinhada, com ID novo e o mesmo texto.
  const corrigido = { ...base(), revision: 2, corrections: [correcao("aligned", [treNova])] };
  state.set("project", corrigido);
  expect(contador(document)).toBe("2 de 3 · fora da montagem");
  const busca = state.get("busca") as { atuais: string[] };
  expect(busca.atuais).toEqual([k("s1", "", treNova.id)]);
});
