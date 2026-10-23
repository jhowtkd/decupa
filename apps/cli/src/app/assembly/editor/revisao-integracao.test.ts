// PR 6, integração sobre o body real do studio.html (como studio-bancada.test.ts):
// o rastreio da cobertura (cobertura.js) sobrevive à troca de etapa sem listener
// a mais, a aprovação sem assistir pede confirmação, e a Entrega do studio
// mostra os itens por revisão enquanto a legacy fica com a lista plana.
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { mountCobertura } from "./cobertura.js";
import { activityView } from "./progress.js";
import { mountContexto, mountStage } from "./contexto.js";
import { formatChip } from "./format.js";
import { LEGENDA_FORA_DO_MP4, formatLabel } from "./rail.js";
import { mountFormato } from "./studio-formato.js";
import { createState } from "./state.js";
import { mountBancada } from "./studio-bancada.js";
import { mountRevisao } from "./studio-revisao.js";
import { installDom, domWindow, type El } from "./fake-dom.test-helper.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const HTML = readFileSync(new URL("../studio.html", import.meta.url), "utf8");
const BODY = /<body[^>]*>([\s\S]*)<\/body>/.exec(HTML)![1]!.replace(/<script[\s\S]*?<\/script>/g, "");
const PAGE = readFileSync(new URL("../page.html", import.meta.url), "utf8");

const EVENTOS = ["timeupdate", "seeking", "seeked", "ended", "ratechange", "durationchange", "loadstart", "loadedmetadata"];

function projeto(over: Record<string, unknown> = {}) {
  return {
    revision: 3,
    previewRevision: 3,
    finalApprovedRevision: null,
    undo: { head: 3, steps: [] },
    scenes: [{
      id: "s1", objective: "Cena", speechIds: ["a:u001"],
      takes: [{ id: "t1", sourceId: "a", speechId: "a:u001", start: 0, end: 2, removed: [], protected: [] }],
      support: [], gaps: [],
    }],
    captions: [],
    corrections: [],
    analyses: [{ sourceId: "a", words: [], visual: [] }],
    assembly: {
      fps: { num: 25, den: 1 },
      sources: [{ id: "a", name: "fala.mp4", included: true, hasVideo: false }],
      tracks: [],
    },
    ...over,
  };
}

/** Monta os controladores reais; `ui` escolhe a variante do mountContexto. */
function monta(ui?: "studio", delivery: unknown = null) {
  const document = installDom(BODY);
  if (delivery) {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ capabilities: { resolve: true, primary: "package" }, delivery }),
      text: async () => "",
    })));
  }
  const state = createState({});
  const api = {
    call: vi.fn(async (_path: string, _init?: unknown) => ({ res: { ok: true, status: 200 }, body: { peaks: [] } })),
    notifyError: vi.fn(),
  };
  const video = document.getElementById("previewPlayer")!;
  const player = { seek: vi.fn(), el: () => video, playOriginal: vi.fn(), previewBusy: () => false };
  const adicionados = vi.spyOn(video, "addEventListener");
  vi.stubGlobal("MutationObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  mountStage({ state, api, player });
  mountContexto({ state, api, player, ...(ui ? { ui } : {}) });
  if (ui) mountRevisao({ state, player });
  if (ui) mountFormato({ state, api });
  return { document, state, api, video, player, adicionados };
}

/** Simula o player: duração, ranges de played e a posição lida, com o timeupdate. */
function toca(video: El, ate: number, duracao = 10) {
  Object.defineProperty(video, "duration", { value: duracao, configurable: true });
  Object.defineProperty(video, "played", {
    value: { length: 1, start: () => 0, end: () => ate }, configurable: true,
  });
  video.currentTime = ate;
  video.dispatchEvent({ type: "timeupdate" });
}
function assisteTudo(video: El, desde = 1, duracao = 10) {
  for (let t = desde; t <= duracao; t += 1) toca(video, t, duracao);
  video.dispatchEvent({ type: "ended" });
}
const chamadasAprovar = (api: { call: ReturnType<typeof vi.fn> }) => api.call.mock.calls.filter(([path]) => path === "project/approve-final");

// ---- 4. Cobertura: estável na troca de etapa, sem listener a mais ----

it("o rastreio instala cada listener do player uma vez e montar de novo não repete", () => {
  const t = monta("studio");
  const cobertura = t.adicionados.mock.calls.filter(([tipo]) => EVENTOS.includes(tipo));
  expect(cobertura.map(([tipo]) => tipo).sort()).toEqual([...EVENTOS].sort());

  const antes = t.adicionados.mock.calls.length;
  const state = createState({});
  const um = mountCobertura({ state, video: t.video as never });
  const dois = mountCobertura({ state, video: t.video as never });
  expect(dois).toBe(um);
  expect(t.adicionados.mock.calls.length).toBe(antes);
  // Montar o stage de novo no mesmo vídeo também não instala nada.
  mountStage({ state: t.state, api: t.api, player: t.player });
  expect(t.adicionados.mock.calls.filter(([tipo]) => EVENTOS.includes(tipo))).toHaveLength(EVENTOS.length);
});

it("trocar de etapa N vezes não muda watched/watchCoverage nem os listeners do player", () => {
  const t = monta("studio");
  t.state.set("project", projeto());
  expect(t.video.getAttribute("data-rev")).toBe("3");

  // Bancada real: a troca de etapa passa por show().
  const largura = { matches: true, addEventListener() {} };
  const setStage = (stage: string) => {
    if (t.state.get("stage") === stage) bancada.show(stage);
    else t.state.set("stage", stage);
  };
  const bancada = mountBancada({
    state: t.state, setStage, paintStages: () => {}, storage: { getItem: () => null, setItem() {} } as never,
    media: (() => largura) as never, projeto: "p1",
  });
  t.state.subscribe("stage", bancada.show);

  for (let t2 = 1; t2 <= 5; t2 += 1) toca(t.video, t2);
  const cobertura = structuredClone(t.state.get("watchCoverage"));
  const assistido = structuredClone(t.state.get("watched"));
  expect(cobertura).toMatchObject({ revision: 3, duration: 10 });
  expect(cobertura.covered).toBeGreaterThan(4);
  expect(assistido.ended).toBeFalsy();
  const ouvintes = t.adicionados.mock.calls.length;
  const src = t.video.src;

  for (let i = 0; i < 12; i += 1) {
    for (const etapa of ["edicao", "revisao", "entrega", "materiais", "revisao"]) setStage(etapa);
  }

  expect(t.state.get("watchCoverage")).toEqual(cobertura);
  expect(t.state.get("watched")).toEqual(assistido);
  expect(t.adicionados.mock.calls.length).toBe(ouvintes);
  expect(t.video.src).toBe(src);
  expect(t.video.currentTime).toBe(5);

  // Continuar tocando depois das trocas segue de onde parou.
  for (let t2 = 6; t2 <= 10; t2 += 1) toca(t.video, t2);
  expect(t.state.get("watchCoverage").covered).toBeGreaterThan(cobertura.covered);
});

it("cobertura completa marca watched; voltar zera; trocar o src (revisão nova) zera", () => {
  const t = monta("studio");
  t.state.set("project", projeto());
  for (let seg = 1; seg <= 5; seg += 1) toca(t.video, seg);
  expect(t.state.get("watched")?.ended).toBeFalsy();
  expect(t.state.get("watchCoverage").complete).toBe(false);

  assisteTudo(t.video, 6);
  expect(t.state.get("watched")).toEqual({ revision: 3, ended: true });
  expect(t.state.get("watchCoverage")).toMatchObject({ revision: 3, complete: true });

  // Voltar (seek para trás) recomeça a contagem.
  t.video.currentTime = 2;
  Object.defineProperty(t.video, "played", { value: { length: 1, start: () => 0, end: () => 2 }, configurable: true });
  t.video.dispatchEvent({ type: "timeupdate" });
  expect(t.state.get("watched")?.ended).toBe(false);
  expect(t.state.get("watchCoverage")).toMatchObject({ complete: false, covered: 0 });

  // Recomeçar do início: voltar a 0 zera de novo e a prévia inteira refaz a cobertura.
  toca(t.video, 0);
  assisteTudo(t.video);
  expect(t.state.get("watched")?.ended).toBe(true);

  // Revisão nova: o src troca, a cobertura recomeça para a v4 e o assistido cai.
  t.state.set("project", projeto({ revision: 4, previewRevision: 4 }));
  expect(t.video.getAttribute("data-rev")).toBe("4");
  expect(t.state.get("watched")?.ended).toBe(false);
  expect(t.state.get("watchCoverage")).toMatchObject({ revision: 4, covered: 0, complete: false });
});

// ---- 5. Confirmação explícita sem assistir tudo ----

it("aprovar sem assistir tudo pede confirmação; cancelar não chama a API", () => {
  const t = monta("studio");
  t.state.set("project", projeto());
  const confirma = domWindow().confirm;
  confirma.mockReturnValue(false);
  t.document.getElementById("approveFinal")!.click();
  expect(confirma).toHaveBeenCalledTimes(1);
  expect(String(confirma.mock.calls[0]![0])).toContain("não assistiu");
  expect(chamadasAprovar(t.api)).toHaveLength(0);

  confirma.mockReturnValue(true);
  t.document.getElementById("approveFinal")!.click();
  expect(confirma).toHaveBeenCalledTimes(2);
  const envios = chamadasAprovar(t.api);
  expect(envios).toHaveLength(1);
  expect(JSON.parse((envios[0]![1] as { body: string }).body)).toEqual({ baseRevision: 3, watchedRevision: 3 });
});

it("aprovar assistido até o fim não pede confirmação", () => {
  const t = monta("studio");
  t.state.set("project", projeto());
  assisteTudo(t.video);
  t.document.getElementById("approveFinal")!.click();
  expect(domWindow().confirm).not.toHaveBeenCalled();
  expect(JSON.parse((chamadasAprovar(t.api)[0]![1] as { body: string }).body)).toEqual({ baseRevision: 3, watchedRevision: 3 });
});

it("com prévia que não é a atual, aprovar não confirma nem envia nada", () => {
  const t = monta("studio");
  t.state.set("project", projeto({ revision: 4, previewRevision: 3 }));
  t.document.getElementById("approveFinal")!.click();
  expect(domWindow().confirm).not.toHaveBeenCalled();
  expect(chamadasAprovar(t.api)).toHaveLength(0);
  expect(t.api.notifyError).toHaveBeenCalledTimes(1);

  t.state.set("project", projeto({ revision: 4, previewRevision: null }));
  t.document.getElementById("approveFinal")!.click();
  expect(chamadasAprovar(t.api)).toHaveLength(0);
});

// ---- 3 (DOM) e 6. Entrega do studio vs. legacy ----

const verificacao = (revision: number) => ({ revision, status: "pendente", package: true, legendas: { status: "pronto" } });
const entrega = { status: "ready", revision: 3, drpPath: "/x/projeto.drp" };

/** Deixa o fetch de resolve-status (capacidades e registro do Resolve) resolver. */
type Link = El & { href: string; download: string };
/** Os <a> de um trecho do DOM; href e download são propriedades soltas no DOM falso. */
const links = (raiz: El) => raiz.querySelectorAll("a") as Link[];
/** O <li> "Revisão pronta" do checklist (o rótulo é um filho do li no DOM falso). */
const itemPronto = (document: ReturnType<typeof installDom>) => document.getElementById("deliveryChecklist")!.children
  .find((li) => li.children.some((filho) => filho.textContent === "Revisão pronta"))!;
const esperaFetch = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

it("studio: #entregaItens substitui #downloads e cada <a download> bate com a pílula vN", async () => {
  const t = monta("studio", entrega);
  await esperaFetch();
  t.state.set("verificacao", verificacao(3));
  t.state.set("project", projeto({ finalApprovedRevision: 3 }));
  const itens = t.document.getElementById("entregaItens")!;
  expect(itens.querySelectorAll("li.entrega-item").map((li) => li.dataset.item)).toEqual(["video", "legendas", "continuidade"]);
  let total = 0;
  for (const li of itens.querySelectorAll("li.entrega-item")) {
    const pilula = li.querySelector(".entrega-rev")!.textContent;
    expect(pilula).toBe("v3");
    expect(li.dataset.estado).toBe("disponivel");
    for (const a of links(li)) {
      total += 1;
      expect(a.href).toMatch(new RegExp(`/${pilula.slice(1)}(/|$)`));
      expect(a.download).toMatch(new RegExp(`^decupa-r${pilula.slice(1)}(-|\\.)`));
    }
  }
  expect(total).toBeGreaterThan(4);
  const ancora = (nome: string) => links(itens).find((a) => a.download === nome);
  expect(ancora("decupa-r3-projeto.drp")!.href).toMatch(/project\/resolve-drp\/3$/);
  expect(ancora("decupa-r3.tar")).toBeDefined();
  expect(itens.querySelector('[data-item="legendas"] .entrega-nota')!.textContent).toContain("não é gravada no MP4");
  expect(t.document.getElementById("downloads")!.childElementCount).toBe(0);
});

it("studio: sem aprovação da revisão atual os itens ficam bloqueados e o checklist exige a versão atual", () => {
  const t = monta("studio");
  t.state.set("verificacao", verificacao(2));
  t.state.set("project", projeto({ finalApprovedRevision: 2 }));
  for (const li of t.document.getElementById("entregaItens")!.querySelectorAll("li.entrega-item")) {
    expect(li.dataset.estado).toBe("bloqueado");
    expect(li.querySelectorAll("a")).toHaveLength(0);
  }
  const pronta = () => itemPronto(t.document);
  expect(pronta().classList.contains("done")).toBe(false);
  t.state.set("project", projeto({ finalApprovedRevision: 3 }));
  expect(pronta().classList.contains("done")).toBe(true);
});

it("legacy: lista plana #downloads com os nomes de sempre, .drp sem revisão e sem #entregaItens", async () => {
  const t = monta(undefined, entrega);
  await esperaFetch();
  t.state.set("verificacao", verificacao(3));
  t.state.set("project", projeto({ finalApprovedRevision: 3 }));
  expect(t.document.getElementById("entregaItens")).toBeNull();
  expect(t.document.getElementById("revisaoPainel")).toBeNull();
  const nomes = t.document.getElementById("downloads")!.querySelectorAll("li .file-name").map((el) => el.textContent);
  expect(nomes).toEqual(expect.arrayContaining(["reference.mp4", "importar-no-resolve.txt", "verificacao.json", "legendas.vtt", "legendas.srt", "decupa-r3.tar", "projeto.drp"]));
  expect(nomes.some((nome) => nome.startsWith("decupa-r3-"))).toBe(false);
  const ancoras = links(t.document.getElementById("downloads")!);
  const drp = ancoras.find((a) => a.download === "projeto.drp")!;
  expect(drp.href).toMatch(/project\/resolve-drp$/);
  const mp4 = ancoras.find((a) => a.download === "reference.mp4")!;
  expect(mp4.href).toMatch(/project\/output\/3\/mp4$/);
});

it("legacy: o checklist 'Revisão pronta' vale qualquer aprovação, como antes", () => {
  const t = monta();
  t.state.set("project", projeto({ revision: 4, previewRevision: 4, finalApprovedRevision: 3 }));
  const pronta = itemPronto(t.document);
  expect(pronta.classList.contains("done")).toBe(true);
});

it("page.html (legacy) não tem nada do painel nem dos itens da Entrega do studio", () => {
  for (const marca of ["revisaoPainel", "entregaItens", "revisao-painel"]) expect(PAGE, marca).not.toContain(marca);
});

// ---- Atividade › Cobertura (legacy) com o rastreio real ----

const textoCobertura = (state: ReturnType<typeof createState>) => activityView({
  project: state.get("project"), watched: state.get("watched"), coverage: state.get("watchCoverage"),
} as never) as unknown as Record<string, unknown>;

/** Acha o texto da cobertura na projeção da Atividade, onde quer que ela o ponha. */
function acha(view: unknown, trecho: RegExp): boolean {
  return JSON.stringify(view).match(trecho) !== null;
}

it("legacy: a Atividade mostra os segundos vistos da prévia e, no Original, cobertura não confirmada", () => {
  const t = monta();
  t.state.set("project", projeto());
  expect(t.video.getAttribute("data-rev")).toBe("3");
  for (let segundo = 1; segundo <= 5; segundo += 1) toca(t.video, segundo);
  expect(acha(textoCobertura(t.state), /Prévia v3 · 0:05 de 0:10 vistos/)).toBe(true);

  // playOriginal troca o src sem data-rev: a cobertura da prévia deixa de valer.
  t.video.removeAttribute("data-rev");
  t.video.dataset.source = "a";
  t.video.src = "/project/original/a";
  Object.defineProperty(t.video, "duration", { value: 42, configurable: true });
  t.video.dispatchEvent({ type: "loadstart" });
  const visao = textoCobertura(t.state);
  expect(acha(visao, /Prévia v3 · cobertura não confirmada nesta sessão/)).toBe(true);
  expect(acha(visao, /0:42|vistos/)).toBe(false);
});

// ---- Formato na Entrega: diálogo do PR 5 no studio, o antigo só na legacy ----

const comFormato = () => projeto({
  finalApprovedRevision: 3,
  assembly: {
    width: 1920, height: 1080, fps: { num: 30000, den: 1001 },
    sources: [{ id: "a", name: "fala.mp4", included: true, hasVideo: true }], tracks: [],
  },
});
type Dialogo = El & { open: boolean; showCount: number };

it("studio: #editFormat tem data-acao=formato e abre só o #formatoDialog", () => {
  const t = monta("studio");
  t.state.set("project", comFormato());
  const botao = t.document.getElementById("editFormat")!;
  expect(botao.getAttribute("data-acao")).toBe("formato");
  expect(t.document.getElementById("formatDialog")).toBeNull();
  const dialogo = t.document.getElementById("formatoDialog") as Dialogo;
  expect(dialogo.open).toBe(false);
  botao.click();
  expect(dialogo.open).toBe(true);
  expect(dialogo.showCount).toBe(1);
  expect(t.document.getElementById("formatDialog")).toBeNull();
});

it("legacy: #formatDialog existe, abre com largura, altura e fps do projeto; #editFormat sem data-acao", () => {
  const t = monta();
  t.state.set("project", comFormato());
  const botao = t.document.getElementById("editFormat")!;
  expect(botao.hasAttribute("data-acao")).toBe(false);
  expect(t.document.getElementById("formatoDialog")).toBeNull();
  const dialogo = t.document.getElementById("formatDialog") as Dialogo;
  expect(dialogo.open).toBe(false);
  botao.click();
  expect(dialogo.open).toBe(true);
  expect(dialogo.showCount).toBe(1);
  expect(t.document.getElementById("formatWidth")!.value).toBe(1920);
  expect(t.document.getElementById("formatHeight")!.value).toBe(1080);
  expect(t.document.getElementById("formatFps")!.value).toBe("30000/1001");
});

it("#formatLine: formatChip no studio e formatLabel na legacy", () => {
  const projetoComFormato = comFormato();
  const studio = monta("studio");
  studio.state.set("project", projetoComFormato);
  expect(studio.document.getElementById("formatLine")!.textContent).toBe(formatChip(projetoComFormato.assembly as never));
  expect(studio.document.getElementById("formatLine")!.textContent).toBe("16:9 · 1920×1080 · 29,97 fps");

  const legacy = monta();
  legacy.state.set("project", projetoComFormato);
  expect(legacy.document.getElementById("formatLine")!.textContent).toBe(formatLabel(projetoComFormato.assembly as never));
  expect(legacy.document.getElementById("formatLine")!.textContent).toBe("1920×1080 horizontal @ 30000/1001 fps");
});

it("a nota do item Legendas da Entrega é exatamente LEGENDA_FORA_DO_MP4", () => {
  const t = monta("studio");
  t.state.set("verificacao", verificacao(3));
  t.state.set("project", comFormato());
  const nota = t.document.querySelector('#entregaItens [data-item="legendas"] .entrega-nota')!;
  expect(nota.textContent).toBe(LEGENDA_FORA_DO_MP4);
});
