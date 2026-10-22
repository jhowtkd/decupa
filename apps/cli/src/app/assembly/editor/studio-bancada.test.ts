// A bancada do studio sobre o body real do studio.html: player único, navegação
// sem API, preferência local à prova de lixo, etapa inicial, tablist e painéis.
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { mountContexto, mountStage } from "./contexto.js";
import { mountSequencia } from "./sequencia.js";
import { createState } from "./state.js";
import {
  PREFERENCIA,
  abaPorTecla,
  estadoPainel,
  etapaDerivada,
  mountBancada,
  readPreferencia,
  writePreferencia,
} from "./studio-bancada.js";
import { STAGES, stepperState } from "./topbar.js";
import { installDom, type El } from "./fake-dom.test-helper.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const HTML = readFileSync(new URL("../studio.html", import.meta.url), "utf8");
const BODY = /<body[^>]*>([\s\S]*)<\/body>/.exec(HTML)![1]!.replace(/<script[\s\S]*?<\/script>/g, "");
const ETAPAS = STAGES.map((stage) => stage.id);
const REGIOES = ["rail", "center", "palco", "inspector", "faixa"];

const LARGO = 1500;
const ESTREITO = 800;

/** matchMedia de mentira por largura simulada: `(min-width: Npx)` bate com largura >= N; `set` dispara o `change`. */
function fakeMedia(inicial: number) {
  let largura = inicial;
  const ouvintes: Array<() => void> = [];
  const media = (query: string) => {
    const minimo = Number(/min-width:\s*(\d+)px/.exec(query)![1]);
    return {
      get matches() { return largura >= minimo; },
      addEventListener: (_tipo: string, fn: () => void) => { ouvintes.push(fn); },
    };
  };
  const set = (valor: number) => {
    largura = valor;
    for (const fn of ouvintes) fn();
  };
  return { media, set };
}

function fakeStorage(raw?: string) {
  let guardado = raw;
  return {
    getItem: vi.fn((_chave: string) => guardado ?? null),
    setItem: vi.fn((_chave: string, valor: string) => { guardado = valor; }),
    raw: () => guardado,
    json: () => JSON.parse(guardado ?? "null") as { etapas: Record<string, string>; paineis: Record<string, string> },
  };
}

const prefs = (data: unknown) => fakeStorage(JSON.stringify(data));

function scene() {
  return {
    id: "s1",
    objective: "Cena",
    speechIds: ["a:u001"],
    takes: [{ id: "t1", sourceId: "a", speechId: "a:u001", start: 0, end: 2, removed: [], protected: [] }],
    support: [],
    gaps: [],
  };
}

function projeto(over: Record<string, unknown> = {}) {
  return {
    revision: 3,
    previewRevision: null,
    finalApprovedRevision: null,
    undo: { head: 3, steps: [] },
    scenes: [scene()],
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

type Opcoes = {
  storage?: ReturnType<typeof fakeStorage>;
  largura?: number;
  projeto?: string;
  project?: unknown;
};

/** Bancada montada como no page.js: setStage valida e delega, "stage" assina o show. */
function monta({ storage = fakeStorage(), largura: inicial = ESTREITO, projeto: nome = "p1", project }: Opcoes = {}) {
  const document = installDom(BODY);
  const state = createState({});
  if (project !== undefined) state.set("project", project);
  const largura = fakeMedia(inicial);
  const paintStages = () => {
    for (const item of stepperState(state.get("project"), state.get("stage"))) {
      document.querySelector('#stages [data-stage="' + item.id + '"]')!.classList.toggle("is-locked", item.locked);
    }
  };
  const bancada: { show?: (stage: string) => void; initialStage?: string } = {};
  const setStage = (stage: string) => {
    if (!ETAPAS.includes(stage)) return;
    if (state.get("stage") === stage) bancada.show!(stage);
    else state.set("stage", stage);
  };
  Object.assign(bancada, mountBancada({
    state, setStage, paintStages, storage: storage as never, media: largura.media as never, projeto: nome,
  }));
  state.subscribe("stage", bancada.show!);
  document.getElementById("stages")!.addEventListener("click", (event) => {
    const tab = event.target!.closest("[data-stage]");
    if (tab) setStage(tab.dataset.stage!);
  });
  setStage(bancada.initialStage!);
  const tab = (etapa: string) => document.getElementById("etapa-" + etapa)!;
  const pressiona = (alvo: El, key: string) => {
    const event = { type: "keydown", key, target: alvo };
    alvo.dispatchEvent(event);
  };
  const body = document.body;
  return { document, state, storage, setStage, show: bancada.show!, tab, pressiona, body, ...largura };
}

// ---- Puros ----

it("abaPorTecla: setas circulam, Home/End vão às pontas, o resto não é da tablist", () => {
  expect(abaPorTecla("materiais", "ArrowRight")).toBe("edicao");
  expect(abaPorTecla("entrega", "ArrowRight")).toBe("materiais");
  expect(abaPorTecla("materiais", "ArrowLeft")).toBe("entrega");
  expect(abaPorTecla("revisao", "ArrowLeft")).toBe("edicao");
  expect(abaPorTecla("revisao", "Home")).toBe("materiais");
  expect(abaPorTecla("edicao", "End")).toBe("entrega");
  for (const key of ["a", "Enter", " ", "ArrowUp", "ArrowDown", "Tab", "Escape"]) expect(abaPorTecla("edicao", key), key).toBeNull();
  expect(abaPorTecla("desconhecida", "ArrowRight")).toBeNull();
});

it("estadoPainel: existência por etapa, fixo só com largura, gaveta aberta", () => {
  type Entrada = { fixavel: boolean; escolha: string | undefined; aberto: string | null };
  const casos: Array<[string, string, Entrada, string | null]> = [
    // Rail: só em Edição; padrão recolhido.
    ["rail", "materiais", { fixavel: true, escolha: "fixo", aberto: "rail" }, null],
    ["rail", "revisao", { fixavel: true, escolha: "fixo", aberto: null }, null],
    ["rail", "entrega", { fixavel: false, escolha: undefined, aberto: "rail" }, null],
    ["rail", "edicao", { fixavel: true, escolha: undefined, aberto: null }, "recolhido"],
    ["rail", "edicao", { fixavel: true, escolha: "fixo", aberto: null }, "fixo"],
    ["rail", "edicao", { fixavel: true, escolha: "recolhido", aberto: null }, "recolhido"],
    ["rail", "edicao", { fixavel: false, escolha: "fixo", aberto: null }, "recolhido"],
    ["rail", "edicao", { fixavel: false, escolha: "fixo", aberto: "rail" }, "aberto"],
    ["rail", "edicao", { fixavel: false, escolha: undefined, aberto: "inspector" }, "recolhido"],
    // Com largura para fixar não há gaveta: vale a escolha gravada.
    ["rail", "edicao", { fixavel: true, escolha: "fixo", aberto: "rail" }, "fixo"],
    ["rail", "edicao", { fixavel: true, escolha: "recolhido", aberto: "rail" }, "recolhido"],
    // Inspector: Edição e Revisão; padrão fixo.
    ["inspector", "materiais", { fixavel: true, escolha: undefined, aberto: null }, null],
    ["inspector", "entrega", { fixavel: true, escolha: "fixo", aberto: "inspector" }, null],
    ["inspector", "edicao", { fixavel: true, escolha: undefined, aberto: null }, "fixo"],
    ["inspector", "revisao", { fixavel: true, escolha: undefined, aberto: null }, "fixo"],
    ["inspector", "revisao", { fixavel: true, escolha: "recolhido", aberto: null }, "recolhido"],
    ["inspector", "revisao", { fixavel: false, escolha: undefined, aberto: null }, "recolhido"],
    ["inspector", "edicao", { fixavel: false, escolha: undefined, aberto: "inspector" }, "aberto"],
  ];
  for (const [nome, etapa, entrada, esperado] of casos) {
    expect(estadoPainel(nome, etapa, entrada as never), `${nome}/${etapa}/${JSON.stringify(entrada)}`).toBe(esperado);
  }
});

it("etapaDerivada: sem cena Materiais, com cena Edição, versão atual aprovada Entrega", () => {
  expect(etapaDerivada(null)).toBe("materiais");
  expect(etapaDerivada(undefined)).toBe("materiais");
  expect(etapaDerivada(projeto({ scenes: [] }))).toBe("materiais");
  expect(etapaDerivada(projeto())).toBe("edicao");
  expect(etapaDerivada(projeto({ finalApprovedRevision: 2 }))).toBe("edicao");
  expect(etapaDerivada(projeto({ finalApprovedRevision: 3 }))).toBe("entrega");
});

it("readPreferencia/writePreferencia: ida e volta, e o limite de 30 projetos fica com os mais recentes", () => {
  const storage = fakeStorage();
  for (let i = 0; i < 35; i += 1) writePreferencia(storage, { projeto: "p" + i, etapa: "edicao" });
  writePreferencia(storage, { painel: "rail", escolha: "fixo" });
  expect(storage.setItem).toHaveBeenCalledWith(PREFERENCIA, expect.any(String));
  const lida = readPreferencia(storage);
  expect([...lida.etapas.keys()]).toEqual(Array.from({ length: 30 }, (_, i) => "p" + (i + 5)));
  expect(lida.paineis).toEqual({ rail: "fixo" });
  // Sem storage ou com storage que lança, vira o padrão e a escrita não propaga.
  expect(readPreferencia(null)).toEqual({ etapas: new Map(), paineis: {} });
  expect(() => writePreferencia(null, { projeto: "p1", etapa: "edicao" })).not.toThrow();
  const quebrado = { getItem: () => { throw new Error("negado"); }, setItem: () => { throw new Error("cota"); } };
  expect(readPreferencia(quebrado)).toEqual({ etapas: new Map(), paineis: {} });
  expect(() => writePreferencia(quebrado, { painel: "rail", escolha: "fixo" })).not.toThrow();
});

// ---- 3. Preferência ausente ou corrompida ----

const LIXO = [
  "{não é json",
  "null",
  "42",
  '"texto"',
  "[]",
  '{"etapas":"x"}',
  '{"etapas":[1,2]}',
  '{"etapas":{"p1":"zzz"}}',
  '{"etapas":{"p1":42}}',
  '{"paineis":{"rail":"sim","inspector":42}}',
  '{"paineis":"x"}',
];

it.each(LIXO)("preferência corrompida %s volta ao padrão sem quebrar o boot", (raw) => {
  const t = monta({ storage: fakeStorage(raw), largura: LARGO });
  expect(t.state.get("stage")).toBe("materiais");
  expect(t.body.dataset.stage).toBe("materiais");
  t.setStage("edicao");
  expect(t.body.dataset.rail).toBe("recolhido");
  expect(t.body.dataset.inspector).toBe("fixo");
});

it("storage que lança em getItem/setItem, ou nulo, não quebra a bancada", () => {
  const lanca = {
    getItem: vi.fn(() => { throw new Error("negado"); }),
    setItem: vi.fn(() => { throw new Error("cota"); }),
  };
  for (const storage of [lanca, null]) {
    const t = monta({ storage: storage as never, largura: LARGO });
    expect(t.state.get("stage")).toBe("materiais");
    t.setStage("edicao");
    t.tab("revisao").click();
    expect(t.body.dataset.stage).toBe("revisao");
    expect(t.body.dataset.inspector).toBe("fixo");
  }
  expect(lanca.setItem).toHaveBeenCalled();
});

it("preferência válida: etapa é por projeto e a escolha de painel é respeitada", () => {
  const gravada = { etapas: { p1: "revisao" }, paineis: { rail: "fixo", inspector: "recolhido" } };
  const mesmo = monta({ storage: prefs(gravada), largura: LARGO, projeto: "p1" });
  expect(mesmo.state.get("stage")).toBe("revisao");
  expect(mesmo.body.dataset.inspector).toBe("recolhido");
  mesmo.setStage("edicao");
  expect(mesmo.body.dataset.rail).toBe("fixo");
  expect(mesmo.body.dataset.inspector).toBe("recolhido");

  // Outro projeto não herda a etapa, mas os painéis são globais.
  const outro = monta({ storage: prefs(gravada), largura: LARGO, projeto: "p2" });
  expect(outro.state.get("stage")).toBe("materiais");
  outro.setStage("edicao");
  expect(outro.body.dataset.rail).toBe("fixo");
});

it("navegar grava a etapa do projeto sem apagar os outros; passar de 30 derruba o mais antigo", () => {
  const etapas = Object.fromEntries(Array.from({ length: 30 }, (_, i) => ["p" + i, "edicao"]));
  const t = monta({ storage: prefs({ etapas, paineis: {} }), projeto: "novo" });
  t.setStage("revisao");
  const gravado = t.storage.json().etapas;
  expect(Object.keys(gravado)).toHaveLength(30);
  expect(gravado.novo).toBe("revisao");
  expect(gravado.p0).toBeUndefined();
  expect(gravado.p1).toBe("edicao");
  // Revisitar um projeto antigo o põe como o mais recente.
  const t2 = monta({ storage: prefs({ etapas: { a: "edicao", b: "edicao" }, paineis: {} }), projeto: "a" });
  t2.setStage("revisao");
  expect(Object.keys(t2.storage.json().etapas)).toEqual(["b", "a"]);
});

// ---- 4. Etapa inicial sem preferência ----

it("sem cena, a primeira resposta mantém Materiais", async () => {
  const t = monta({});
  t.state.set("project", projeto({ scenes: [] }));
  await Promise.resolve();
  expect(t.state.get("stage")).toBe("materiais");
  expect(t.body.dataset.stage).toBe("materiais");
  expect(t.storage.json().etapas.p1).toBe("materiais");
});

it("com cena e versão não aprovada, a primeira resposta leva a Edição; só depois de uma microtarefa", async () => {
  const t = monta({});
  expect(t.storage.setItem).not.toHaveBeenCalled();
  t.state.set("project", projeto());
  expect(t.state.get("stage")).toBe("materiais");
  await Promise.resolve();
  expect(t.state.get("stage")).toBe("edicao");
  expect(t.body.dataset.stage).toBe("edicao");
  expect(t.tab("edicao").getAttribute("aria-selected")).toBe("true");
  expect(t.storage.json().etapas.p1).toBe("edicao");
});

it("versão atual aprovada abre em Entrega", async () => {
  const t = monta({});
  t.state.set("project", projeto({ finalApprovedRevision: 3 }));
  await Promise.resolve();
  expect(t.state.get("stage")).toBe("entrega");
  expect(t.tab("entrega").classList.contains("is-locked")).toBe(false);
});

it("decide uma vez: respostas seguintes não arrastam a pessoa de volta", async () => {
  const t = monta({});
  t.state.set("project", projeto());
  await Promise.resolve();
  t.setStage("materiais");
  t.state.set("project", projeto({ revision: 4 }));
  await Promise.resolve();
  expect(t.state.get("stage")).toBe("materiais");
  expect(t.storage.json().etapas.p1).toBe("materiais");
});

it("quem navegou antes da primeira resposta fica onde foi", async () => {
  const t = monta({});
  t.tab("revisao").click();
  t.state.set("project", projeto({ finalApprovedRevision: 3 }));
  await Promise.resolve();
  expect(t.state.get("stage")).toBe("revisao");
  expect(t.storage.json().etapas.p1).toBe("revisao");
});

it("a troca de etapa do state.js (transcrição chegando na preparação) vence a decisão", async () => {
  const t = monta({});
  const palavras = [{ id: "w1", sourceId: "a", text: "oi", confidence: null, start: 0.1, end: 0.4 }];
  // Aprovada: sozinha, a decisão levaria a Entrega.
  t.state.set("project", projeto({
    finalApprovedRevision: 3,
    preparation: { status: "running" },
    analyses: [{ sourceId: "a", words: palavras, visual: [] }],
  }));
  await Promise.resolve();
  expect(t.state.get("stage")).toBe("edicao");
  expect(t.body.dataset.stage).toBe("edicao");
  expect(t.storage.json().etapas.p1).toBe("edicao");
});

it("preferência gravada em Entrega travada abre nela, com a tab travada", () => {
  const t = monta({ storage: prefs({ etapas: { p1: "entrega" }, paineis: {} }), project: projeto() });
  expect(t.state.get("stage")).toBe("entrega");
  expect(t.tab("entrega").classList.contains("is-locked")).toBe(true);
  expect(t.tab("entrega").getAttribute("aria-selected")).toBe("true");
  expect(t.document.getElementById("texto")!.hidden).toBe(true);
});

it("com preferência gravada a primeira resposta não decide nada", async () => {
  const t = monta({ storage: prefs({ etapas: { p1: "materiais" }, paineis: {} }) });
  t.state.set("project", projeto());
  await Promise.resolve();
  expect(t.state.get("stage")).toBe("materiais");
});

it("decidir a etapa inicial não dispara fetch nem api", async () => {
  const t = monta({});
  const fetchMock = vi.mocked(fetch);
  fetchMock.mockClear();
  t.state.set("project", projeto());
  await Promise.resolve();
  expect(t.state.get("stage")).toBe("edicao");
  expect(fetchMock).not.toHaveBeenCalled();
});

// ---- 5. Tablist por teclado ----

it("tablist: setas e Home/End, foco na tab nova, aria-selected/tabIndex e aria-labelledby", () => {
  const t = monta({});
  const confere = (ativa: string) => {
    for (const etapa of ETAPAS) {
      const tab = t.tab(etapa);
      expect(tab.getAttribute("aria-selected"), etapa).toBe(String(etapa === ativa));
      expect(tab.tabIndex, etapa).toBe(etapa === ativa ? 0 : -1);
      expect(tab.getAttribute("aria-current"), etapa).toBeNull();
    }
    expect(t.document.getElementById("bancada")!.getAttribute("aria-labelledby")).toBe("etapa-" + ativa);
    expect(t.document.activeElement).toBe(t.tab(ativa));
  };
  t.tab("materiais").focus();
  const passos: Array<[string, string]> = [
    ["ArrowRight", "edicao"], ["ArrowRight", "revisao"], ["ArrowRight", "entrega"], ["ArrowRight", "materiais"],
    ["ArrowLeft", "entrega"], ["ArrowLeft", "revisao"], ["Home", "materiais"], ["End", "entrega"],
  ];
  for (const [key, esperada] of passos) {
    const atual = ETAPAS.find((etapa) => t.tab(etapa).getAttribute("aria-selected") === "true")!;
    t.pressiona(t.tab(atual), key);
    expect(t.state.get("stage"), key).toBe(esperada);
    confere(esperada);
  }
});

it("tecla irrelevante na tablist não navega nem é engolida", () => {
  const t = monta({});
  const eventos: Array<{ defaultPrevented: boolean }> = [];
  t.document.addEventListener("keydown", (event) => { eventos.push(event); });
  t.pressiona(t.tab("materiais"), "a");
  t.pressiona(t.tab("materiais"), "Enter");
  expect(t.state.get("stage")).toBe("materiais");
  expect(eventos.map((event) => event.defaultPrevented)).toEqual([false, false]);
});

it("seta na tablist chama preventDefault (não rola a página)", () => {
  const t = monta({});
  const eventos: Array<{ defaultPrevented: boolean }> = [];
  t.document.addEventListener("keydown", (event) => { eventos.push(event); });
  t.pressiona(t.tab("materiais"), "ArrowRight");
  expect(eventos[0]!.defaultPrevented).toBe(true);
});

it("seta fora de uma tab não navega, mesmo com o body carregando data-stage", () => {
  const t = monta({});
  t.pressiona(t.document.getElementById("stages")!, "ArrowRight");
  expect(t.state.get("stage")).toBe("materiais");
});

// ---- 6. Painéis ----

it("botões existem só onde o painel existe, com aria-expanded e data-* coerentes", () => {
  const t = monta({ largura: LARGO });
  const rail = t.document.getElementById("railToggle")!;
  const inspector = t.document.getElementById("inspectorToggle")!;
  const esperado: Record<string, [string | undefined, string | undefined]> = {
    materiais: [undefined, undefined],
    edicao: ["recolhido", "fixo"],
    revisao: [undefined, "fixo"],
    entrega: [undefined, undefined],
  };
  for (const etapa of ETAPAS) {
    t.setStage(etapa);
    const [r, i] = esperado[etapa]!;
    expect(t.body.dataset.rail, etapa).toBe(r);
    expect(t.body.dataset.inspector, etapa).toBe(i);
    expect(t.body.hasAttribute("data-rail"), etapa).toBe(r !== undefined);
    expect(t.body.hasAttribute("data-inspector"), etapa).toBe(i !== undefined);
    expect(rail.hidden, etapa).toBe(r === undefined);
    expect(inspector.hidden, etapa).toBe(i === undefined);
    if (r) expect(rail.getAttribute("aria-expanded")).toBe(String(r === "fixo"));
    if (i) expect(inspector.getAttribute("aria-expanded")).toBe(String(i === "fixo"));
  }
});

it("largura fixável: o clique alterna fixo e recolhido e grava a escolha", () => {
  const t = monta({ largura: LARGO });
  t.setStage("edicao");
  const inspector = t.document.getElementById("inspectorToggle")!;
  inspector.click();
  expect(t.body.dataset.inspector).toBe("recolhido");
  expect(inspector.getAttribute("aria-expanded")).toBe("false");
  expect(t.storage.json().paineis.inspector).toBe("recolhido");
  inspector.click();
  expect(t.body.dataset.inspector).toBe("fixo");
  expect(inspector.getAttribute("aria-expanded")).toBe("true");
  expect(t.storage.json().paineis.inspector).toBe("fixo");
  // O rail começa recolhido por padrão e o clique o fixa.
  t.document.getElementById("railToggle")!.click();
  expect(t.body.dataset.rail).toBe("fixo");
  expect(t.storage.json().paineis).toEqual({ inspector: "fixo", rail: "fixo" });
  // A escolha vale em outra etapa.
  t.setStage("revisao");
  expect(t.body.dataset.inspector).toBe("fixo");
});

it("largura não fixável: o clique abre a gaveta e leva o foco; Esc fecha e devolve o foco ao botão", () => {
  const t = monta({});
  t.setStage("edicao");
  const botao = t.document.getElementById("inspectorToggle")!;
  expect(t.body.dataset.inspector).toBe("recolhido");
  botao.click();
  expect(t.body.dataset.inspector).toBe("aberto");
  expect(botao.getAttribute("aria-expanded")).toBe("true");
  expect(t.document.activeElement).toBe(t.document.getElementById("inspector"));
  // Gaveta não é escolha: nada é gravado.
  expect(t.storage.json()?.paineis ?? {}).toEqual({});
  t.document.dispatchEvent({ type: "keydown", key: "Escape" });
  expect(t.body.dataset.inspector).toBe("recolhido");
  expect(botao.getAttribute("aria-expanded")).toBe("false");
  expect(t.document.activeElement).toBe(botao);
  // Clicar de novo no botão aberto também fecha.
  botao.click();
  botao.click();
  expect(t.body.dataset.inspector).toBe("recolhido");
});

it("Esc não fecha com dialog aberto nem com o evento já tratado", () => {
  const t = monta({});
  t.setStage("edicao");
  t.document.getElementById("railToggle")!.click();
  expect(t.body.dataset.rail).toBe("aberto");
  t.document.getElementById("mediaDialog")!.setAttribute("open", "");
  t.document.dispatchEvent({ type: "keydown", key: "Escape" });
  expect(t.body.dataset.rail).toBe("aberto");
  t.document.getElementById("mediaDialog")!.removeAttribute("open");
  t.document.dispatchEvent({ type: "keydown", key: "Escape", defaultPrevented: true });
  expect(t.body.dataset.rail).toBe("aberto");
  t.document.dispatchEvent({ type: "keydown", key: "Escape" });
  expect(t.body.dataset.rail).toBe("recolhido");
  // Outra tecla nunca fecha.
  t.document.getElementById("railToggle")!.click();
  t.document.dispatchEvent({ type: "keydown", key: "Enter" });
  expect(t.body.dataset.rail).toBe("aberto");
});

it("uma gaveta por vez, e trocar de etapa fecha a gaveta", () => {
  const t = monta({});
  t.setStage("edicao");
  t.document.getElementById("railToggle")!.click();
  expect(t.body.dataset.rail).toBe("aberto");
  t.document.getElementById("inspectorToggle")!.click();
  expect(t.body.dataset.rail).toBe("recolhido");
  expect(t.body.dataset.inspector).toBe("aberto");
  t.setStage("revisao");
  expect(t.body.dataset.inspector).toBe("recolhido");
  t.document.getElementById("inspectorToggle")!.click();
  expect(t.body.dataset.inspector).toBe("aberto");
  t.setStage("entrega");
  t.setStage("revisao");
  expect(t.body.dataset.inspector).toBe("recolhido");
});

it("recolher com o foco dentro do painel devolve o foco ao botão", () => {
  const t = monta({ largura: 1400 });
  t.setStage("edicao");
  const botao = t.document.getElementById("inspectorToggle")!;
  // Foco dentro do inspector: o painel que recolhe não deixa o foco escondido.
  t.document.getElementById("contexto")!.focus();
  botao.click();
  expect(t.body.dataset.inspector).toBe("recolhido");
  expect(t.document.activeElement).toBe(botao);
});

it("o change da media recalcula: ganhar largura fixa o inspector, perder vira gaveta", () => {
  const t = monta({});
  t.setStage("edicao");
  const botao = t.document.getElementById("inspectorToggle")!;
  expect(t.body.dataset.inspector).toBe("recolhido");
  t.set(1400);
  expect(t.body.dataset.inspector).toBe("fixo");
  expect(botao.getAttribute("aria-expanded")).toBe("true");
  t.set(ESTREITO);
  expect(t.body.dataset.inspector).toBe("recolhido");
  expect(botao.getAttribute("aria-expanded")).toBe("false");
  // Largura que fixa o rail não o abre: o padrão dele é recolhido.
  t.set(1100);
  expect(t.body.dataset.rail).toBe("recolhido");
});

it("a largura que fixa é por etapa: a 1280 px o inspector fixa na Revisão e vira gaveta na Edição", () => {
  const t = monta({ largura: 1280 });
  const botao = t.document.getElementById("inspectorToggle")!;
  t.setStage("revisao");
  expect(t.body.dataset.inspector).toBe("fixo");
  t.setStage("edicao");
  expect(t.body.dataset.inspector).toBe("recolhido");
  botao.click();
  expect(t.body.dataset.inspector).toBe("aberto");
  expect(t.document.activeElement).toBe(t.document.getElementById("inspector"));
  // Na Revisão o clique recolhe/fixa e grava; na Edição, gaveta não grava.
  t.setStage("revisao");
  botao.click();
  expect(t.body.dataset.inspector).toBe("recolhido");
  expect(t.storage.json().paineis.inspector).toBe("recolhido");
  // O limite da Revisão é 1024: abaixo disso vira gaveta também lá.
  t.set(1023);
  t.setStage("edicao");
  t.setStage("revisao");
  t.document.getElementById("inspectorToggle")!.click();
  expect(t.body.dataset.inspector).toBe("aberto");
  // Ganhar largura para fixar fecha a gaveta e vale a escolha gravada (recolhido);
  // o foco que estava nela volta ao botão, e estreitar de novo não a reabre.
  expect(t.document.activeElement).toBe(t.document.getElementById("inspector"));
  t.set(1400);
  expect(t.body.dataset.inspector).toBe("recolhido");
  expect(t.document.activeElement).toBe(t.document.getElementById("inspectorToggle"));
  t.set(1023);
  expect(t.body.dataset.inspector).toBe("recolhido");
});

// ---- 1 e 2. Player único e navegação sem API ----

/** Monta os controladores reais sobre o body do studio.html, com o projeto já carregado. */
async function carregado() {
  const document = installDom(BODY);
  const state = createState({});
  const chamadas: string[] = [];
  const api = {
    call: vi.fn(async (path: string) => {
      chamadas.push(path);
      return { res: { ok: true, status: 200 }, body: { peaks: [] } };
    }),
    notifyError: vi.fn(),
  };
  const video = document.getElementById("previewPlayer")!;
  const player = {
    seek: vi.fn(),
    el: () => video,
    playOriginal: vi.fn(),
    previewBusy: () => false,
  };
  vi.stubGlobal("MutationObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  mountStage({ state, api, player });
  mountContexto({ state, api, player });
  mountSequencia({ state, api, player, ui: "studio" });
  return { document, state, api, chamadas, video, player };
}

it("trocar de etapa não recria o player nem muda currentTime, src ou a árvore das regiões", async () => {
  const base = await carregado();
  const { document, state, video } = base;
  const storage = fakeStorage();
  const largura = fakeMedia(LARGO);
  const setStage = (stage: string) => {
    if (state.get("stage") === stage) bancada.show(stage);
    else state.set("stage", stage);
  };
  const paintStages = () => {};
  const bancada = mountBancada({ state, setStage, paintStages, storage: storage as never, media: largura.media as never, projeto: "p1" });
  state.subscribe("stage", bancada.show);
  document.getElementById("stages")!.addEventListener("click", (event) => {
    const tab = event.target!.closest("[data-stage]");
    if (tab) setStage(tab.dataset.stage!);
  });
  state.set("project", projeto());
  setStage("materiais");

  video.currentTime = 12.5;
  video.src = "/preview/v3.mp4";
  const pause = vi.spyOn(video, "pause");
  const load = vi.spyOn(video, "load");
  const tela = video.parentElement!;
  expect(tela.className).toContain("preview-screen");
  expect(tela.parentElement!.id).toBe("stage");
  expect(tela.parentElement!.parentElement!.id).toBe("palco");
  const paisRegioes = REGIOES.map((id) => document.getElementById(id)!.parentElement);
  expect(paisRegioes.every((pai) => pai === document.getElementById("bancada"))).toBe(true);

  const confere = (onde: string) => {
    const atual = document.getElementById("previewPlayer")!;
    expect(atual, onde).toBe(video);
    expect(atual.isConnected, onde).toBe(true);
    expect(atual.parentElement, onde).toBe(tela);
    expect(tela.parentElement!.id, onde).toBe("stage");
    expect(tela.parentElement!.parentElement!.id, onde).toBe("palco");
    expect(atual.currentTime, onde).toBe(12.5);
    expect(atual.src, onde).toBe("/preview/v3.mp4");
    expect(pause, onde).not.toHaveBeenCalled();
    expect(load, onde).not.toHaveBeenCalled();
    REGIOES.forEach((id, i) => expect(document.getElementById(id)!.parentElement, onde + " " + id).toBe(paisRegioes[i]));
  };

  for (const etapa of [...ETAPAS, ...ETAPAS.toReversed()]) { bancada.show(etapa); confere("show " + etapa); }
  for (const etapa of ETAPAS) { document.querySelector('#stages [data-stage="' + etapa + '"]')!.click(); confere("clique " + etapa); }
  const tab = (etapa: string) => document.getElementById("etapa-" + etapa)!;
  for (const key of ["ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowLeft", "End", "Home"]) {
    const atual = ETAPAS.find((etapa) => tab(etapa).getAttribute("aria-selected") === "true")!;
    tab(atual).dispatchEvent({ type: "keydown", key });
    confere("teclado " + key);
  }
});

it("navegar e abrir/fechar painel não chama a API nem o fetch", async () => {
  const base = await carregado();
  const { document, state, api, chamadas } = base;
  const storage = fakeStorage();
  const largura = fakeMedia(ESTREITO);
  const setStage = (stage: string) => {
    if (state.get("stage") === stage) bancada.show(stage);
    else state.set("stage", stage);
  };
  const bancada = mountBancada({ state, setStage, paintStages: () => {}, storage: storage as never, media: largura.media as never, projeto: "p1" });
  state.subscribe("stage", bancada.show);
  document.getElementById("stages")!.addEventListener("click", (event) => {
    const tab = event.target!.closest("[data-stage]");
    if (tab) setStage(tab.dataset.stage!);
  });
  state.set("project", projeto({ previewRevision: 3 }));
  // Os controladores reais estão de pé: sem isto "zero chamadas" seria vácuo.
  expect(document.getElementById("reviewCard")).not.toBeNull();
  expect(document.querySelector(".seq-strip")).not.toBeNull();
  setStage(bancada.initialStage);
  // A hidratação da waveform e a decisão inicial são do carregamento, não da navegação.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const fetchMock = vi.mocked(fetch);
  api.call.mockClear();
  fetchMock.mockClear();
  chamadas.length = 0;

  const alternaPaineis = () => {
    for (const id of ["railToggle", "inspectorToggle", "inspectorToggle", "railToggle"]) document.getElementById(id)!.click();
    document.dispatchEvent({ type: "keydown", key: "Escape" });
  };
  for (const fixavel of [false, true, false]) {
    largura.set(fixavel ? LARGO : ESTREITO);
    for (const etapa of ETAPAS) {
      document.querySelector('#stages [data-stage="' + etapa + '"]')!.click();
      alternaPaineis();
    }
  }
  for (const key of ["ArrowRight", "ArrowRight", "ArrowLeft", "End", "Home", "ArrowLeft"]) {
    const atual = ETAPAS.find((etapa) => document.getElementById("etapa-" + etapa)!.getAttribute("aria-selected") === "true")!;
    document.getElementById("etapa-" + atual)!.dispatchEvent({ type: "keydown", key });
    alternaPaineis();
  }

  expect(chamadas).toEqual([]);
  expect(api.call).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
  const proibidas = /project\/(prepare|adjust|preview|export|approve-final|edit|undo)/;
  expect([...chamadas, ...api.call.mock.calls.map((call) => String(call[0])), ...fetchMock.mock.calls.map((call) => String(call[0]))]
    .filter((url) => proibidas.test(url))).toEqual([]);
});
