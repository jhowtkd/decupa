// PR 6: os cinco dados da Revisão (blocosDaRevisao e o DOM do painel), a regra
// de que prévia antiga nunca libera entrega nova e que cada arquivo da Entrega
// é da revisão que o item indica. Regras de servidor ficam em
// resolve-drp-revisao.test.ts; o gate puro do assistido já tem watched.test.ts.
import { afterEach, expect, it, vi } from "vitest";
import { deliveryItems } from "./rail.js";
import { createState } from "./state.js";
import { blocosDaRevisao, mountRevisao } from "./studio-revisao.js";
import { stepperState } from "./topbar.js";
import { approveButtonView } from "./progress.js";
import { watchedState } from "./watched.js";
import { installDom } from "./fake-dom.test-helper.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Over = Record<string, unknown>;
const projeto = (over: Over = {}) => ({
  revision: 6,
  previewRevision: 6,
  finalApprovedRevision: null,
  scenes: [{ id: "s1" }],
  assembly: { sources: [{ id: "a", name: "fala.mp4", included: true }] },
  ...over,
});
const bloco = (blocos: Array<{ id: string }>, id: string) => blocos.find((item) => item.id === id) as
  { id: string; valor: string; detalhe: string; tom: string };
const exibida = (revisao: number | null, original: string | null = null) => ({ revisao, original });
const medida = (revision: number, ratio: number, label = "") => ({ revision, ratio, label, covered: 0, duration: 10, complete: ratio >= 1 });
const verificacao = (revision: number, extra: Over = {}) => ({ revision, status: "pendente", package: true, legendas: { status: "pronto" }, ...extra });

// ---- 1. Os cinco dados separados ----

it("lista os cinco blocos na ordem, cada um com id próprio", () => {
  const blocos = blocosDaRevisao({ project: projeto(), exibida: exibida(6) });
  expect(blocos.map((item) => item.id)).toEqual(["montagem", "previa", "cobertura", "aprovada", "entrega"]);
  expect(blocosDaRevisao({ project: null })).toEqual([]);
  expect(bloco(blocos, "montagem").valor).toBe("v6");
});

it("prévia exibida: atual, anterior, nenhuma e Original", () => {
  const atual = bloco(blocosDaRevisao({ project: projeto(), exibida: exibida(6) }), "previa");
  expect(atual.valor).toBe("v6");
  expect(atual.tom).toBe("ok");

  // Player ainda com a v5 e previewRevision null (v6 renderizando): prévia anterior.
  const antiga = projeto({ previewRevision: null });
  const anterior = bloco(blocosDaRevisao({ project: antiga, exibida: exibida(5), gerando: true }), "previa");
  expect(anterior.valor).toBe("v5");
  expect(anterior.tom).toBe("aviso");
  expect(anterior.detalhe).toContain("anterior");
  expect(anterior.detalhe).toContain("não vale para a v6");
  expect(anterior.detalhe).toContain("sendo gerada");

  const nenhuma = bloco(blocosDaRevisao({ project: antiga, exibida: exibida(null) }), "previa");
  expect(nenhuma.valor).toBe("Nenhuma");
  expect(nenhuma.detalhe).toContain("ainda não tem prévia");

  const original = bloco(blocosDaRevisao({ project: projeto(), exibida: exibida(null, "fala.mp4") }), "previa");
  expect(original.valor).toBe("Original");
  expect(original.detalhe).toContain("fala.mp4");
  expect(original.detalhe).toContain("original, não a prévia");
});

it("cobertura: nesta sessão, parcial vs completa, e não conta para a versão nova com prévia antiga", () => {
  const parcial = bloco(blocosDaRevisao({
    project: projeto(), exibida: exibida(6), coverage: medida(6, 0.4, "40% assistido"),
  }), "cobertura");
  expect(parcial.valor).toBe("40%");
  expect(parcial.detalhe).toContain("nesta sessão");
  expect(parcial.tom).toBe("");

  const completa = bloco(blocosDaRevisao({
    project: projeto(), exibida: exibida(6), watched: { revision: 6, ended: true }, coverage: medida(6, 1),
  }), "cobertura");
  expect(completa.valor).toBe("100%");
  expect(completa.detalhe).toContain("vista até o fim");
  expect(completa.tom).toBe("ok");

  // Prévia v5 no player enquanto a v6 é a atual: a cobertura é da v5 e não conta.
  const antiga = bloco(blocosDaRevisao({
    project: projeto({ previewRevision: null }), exibida: exibida(5), coverage: medida(5, 1),
  }), "cobertura");
  expect(antiga.detalhe).toContain("v5");
  expect(antiga.detalhe).toContain("não conta para a v6");
  expect(antiga.tom).toBe("aviso");

  // Cobertura medida de outra revisão que não a exibida não aparece.
  const alheia = bloco(blocosDaRevisao({ project: projeto(), exibida: exibida(6), coverage: medida(5, 1) }), "cobertura");
  expect(alheia.valor).toBe("—");
  expect(alheia.detalhe).toContain("nesta sessão");

  const original = bloco(blocosDaRevisao({ project: projeto(), exibida: exibida(null, "fala.mp4"), coverage: medida(6, 1) }), "cobertura");
  expect(original.valor).toBe("—");
  expect(original.detalhe).toContain("O original não conta");
});

it("aprovada: atual, de revisão anterior ou nenhuma", () => {
  const atual = bloco(blocosDaRevisao({ project: projeto({ finalApprovedRevision: 6 }), exibida: exibida(6) }), "aprovada");
  expect(atual.valor).toBe("v6");
  expect(atual.tom).toBe("ok");

  const anterior = bloco(blocosDaRevisao({ project: projeto({ finalApprovedRevision: 5 }), exibida: exibida(6) }), "aprovada");
  expect(anterior.valor).toBe("v5");
  expect(anterior.detalhe).toContain("Não vale para a v6");
  expect(anterior.tom).toBe("aviso");

  const nenhuma = bloco(blocosDaRevisao({ project: projeto(), exibida: exibida(6) }), "aprovada");
  expect(nenhuma.valor).toBe("Nenhuma");
  expect(nenhuma.detalhe).toContain("Aprove a prévia da v6");
  const semPrevia = bloco(blocosDaRevisao({ project: projeto({ previewRevision: null }), exibida: exibida(null) }), "aprovada");
  expect(semPrevia.detalhe).toContain("pede a prévia da v6");
});

it("entrega: bloqueada, a preparar, disponível e legendas indisponíveis", () => {
  const aprovado = projeto({ finalApprovedRevision: 6 });
  const bloqueada = bloco(blocosDaRevisao({ project: projeto(), exibida: exibida(6) }), "entrega");
  expect(bloqueada.valor).toBe("Nenhum");
  expect(bloqueada.detalhe).toContain("ao aprovar");

  const preparar = bloco(blocosDaRevisao({ project: aprovado, exibida: exibida(6) }), "entrega");
  expect(preparar.valor).toBe("A preparar");

  // Verificação de revisão antiga não vale: segue a preparar.
  const velha = bloco(blocosDaRevisao({ project: aprovado, exibida: exibida(6), verificacao: verificacao(5) }), "entrega");
  expect(velha.valor).toBe("A preparar");

  const pronta = bloco(blocosDaRevisao({ project: aprovado, exibida: exibida(6), verificacao: verificacao(6) }), "entrega");
  expect(pronta.valor).toBe("v6");
  expect(pronta.detalhe).toContain("Vídeo");
  expect(pronta.detalhe).toContain("legendas");
  expect(pronta.detalhe).not.toContain("indisponível");

  const semLegenda = bloco(blocosDaRevisao({
    project: aprovado, exibida: exibida(6), verificacao: verificacao(6, { legendas: { status: "indisponivel" } }),
  }), "entrega");
  expect(semLegenda.valor).toBe("v6");
  expect(semLegenda.detalhe).toContain("legendas indisponíveis");
});

function painel(over: { project?: Over | null; view?: string; data?: Over; stage?: string } = {}) {
  const document = installDom('<div id="stage"></div>');
  // O painel só pinta na etapa Revisão.
  const state = createState({ stage: over.stage ?? "revisao" });
  const video = document.createElement("video");
  const rev = (over.data?.rev as string | undefined) ?? "6";
  if (rev !== "") video.setAttribute("data-rev", rev);
  if (over.data?.source) video.dataset.source = String(over.data.source);
  state.set("project", over.project === undefined ? projeto() : over.project);
  state.set("view", over.view ?? "montagem");
  mountRevisao({ state, player: { el: () => video } });
  const bloco = (id: string) => {
    const el = document.querySelector(`#revisaoPainel [data-bloco="${id}"]`)!;
    return { el, texto: el.textContent, valor: el.querySelector(".revisao-valor")!.textContent, detalhe: el.querySelector(".revisao-detalhe")!.textContent };
  };
  return { document, state, video, bloco, el: () => document.getElementById("revisaoPainel")! };
}

it("o painel do DOM mostra os cinco blocos e acompanha o estado", () => {
  const t = painel();
  // No palco, logo depois do #stage (e da linha da legenda, quando existe), fora dele.
  const stage = t.document.getElementById("stage")!;
  expect(stage.contains(t.el())).toBe(false);
  const irmaos = stage.parentElement!.children;
  expect(irmaos.indexOf(t.el())).toBe(irmaos.indexOf(stage) + 1);
  expect(t.document.querySelectorAll("#revisaoPainel [data-bloco]").map((el) => el.dataset.bloco))
    .toEqual(["montagem", "previa", "cobertura", "aprovada", "entrega"]);
  expect(t.bloco("montagem").valor).toBe("v6");
  expect(t.bloco("previa").valor).toBe("v6");
  expect(t.bloco("cobertura").detalhe).toContain("nesta sessão");

  t.state.set("watchCoverage", medida(6, 0.5, "50% assistido"));
  expect(t.bloco("cobertura").valor).toBe("50%");
  t.state.set("project", projeto({ finalApprovedRevision: 6 }));
  expect(t.bloco("aprovada").valor).toBe("v6");
  t.state.set("verificacao", verificacao(6));
  expect(t.bloco("entrega").valor).toBe("v6");
});

it("o painel mostra prévia anterior, Original e some sem cenas", () => {
  const anterior = painel({ project: projeto({ previewRevision: null }), data: { rev: "5" } });
  expect(anterior.bloco("previa").valor).toBe("v5");
  expect(anterior.bloco("previa").detalhe).toContain("anterior");
  anterior.state.set("operation", { stage: "rendering" });
  expect(anterior.bloco("previa").detalhe).toContain("sendo gerada");

  const original = painel({ view: "original", data: { rev: "6", source: "a" } });
  expect(original.bloco("previa").valor).toBe("Original");
  expect(original.bloco("previa").detalhe).toContain("fala.mp4");

  const sem = painel({ project: projeto({ scenes: [] }) });
  expect(sem.el().hidden).toBe(true);
  sem.state.set("project", projeto());
  expect(sem.el().hidden).toBe(false);
});

it("fora da etapa Revisão o painel não recalcula; entrar nela repinta com o estado de agora", () => {
  const t = painel({ stage: "edicao" });
  const dados = t.el().children[0]!;
  const repinta = vi.spyOn(dados, "replaceChildren");
  expect(repinta).not.toHaveBeenCalled();

  // "Reprodução" na Edição: cobertura, projeto e verificação mudam sem tocar no DOM do painel.
  for (let segundo = 1; segundo <= 8; segundo += 1) t.state.set("watchCoverage", medida(6, segundo / 10, segundo * 10 + "% assistido"));
  t.state.set("project", projeto({ finalApprovedRevision: 6 }));
  t.state.set("verificacao", verificacao(6));
  t.state.set("view", "montagem");
  t.state.set("operation", { stage: "rendering" });
  expect(repinta).not.toHaveBeenCalled();
  expect(dados.children).toHaveLength(0);

  // Trocar de etapa N vezes fora da Revisão também não repinta.
  for (const etapa of ["materiais", "edicao", "entrega", "edicao", "materiais"]) t.state.set("stage", etapa);
  expect(repinta).not.toHaveBeenCalled();

  t.state.set("stage", "revisao");
  expect(repinta).toHaveBeenCalledTimes(1);
  expect(t.bloco("cobertura").valor).toBe("80%");
  expect(t.bloco("aprovada").valor).toBe("v6");
  expect(t.bloco("entrega").valor).toBe("v6");

  // Na Revisão volta a acompanhar o estado; ao sair, congela de novo no último texto.
  t.state.set("watchCoverage", medida(6, 0.9, "90% assistido"));
  expect(t.bloco("cobertura").valor).toBe("90%");
  const chamadas = repinta.mock.calls.length;
  t.state.set("stage", "edicao");
  t.state.set("watchCoverage", medida(6, 1));
  expect(repinta.mock.calls.length).toBe(chamadas);
  expect(t.bloco("cobertura").valor).toBe("90%");
  t.state.set("stage", "revisao");
  expect(t.bloco("cobertura").valor).toBe("100%");
});

// ---- 2. Prévia antiga nunca libera entrega nova ----
// Servidor: approve-final/export recusam em resolve-drp-revisao.test.ts,
// revisions.test.ts e export.test.ts.

it("prévia de revisão anterior trava o gate, o botão e a etapa Entrega", () => {
  const antigo = projeto({ previewRevision: 5, finalApprovedRevision: null });
  const status = watchedState(antigo, { revision: 5, ended: true });
  expect(status).toMatchObject({ fresh: false, watched: false, canApprove: false });
  expect(watchedState(projeto({ previewRevision: null }), { revision: 6, ended: true }).canApprove).toBe(false);
  const botao = approveButtonView(antigo, status, false);
  expect(botao).toMatchObject({ disabled: true, locked: true, approved: false });
  expect(stepperState(antigo, "revisao").find((etapa) => etapa.id === "entrega")!.locked).toBe(true);
  // Aprovação de revisão anterior também não destrava.
  expect(stepperState(projeto({ finalApprovedRevision: 5 }), "revisao").find((etapa) => etapa.id === "entrega")!.locked).toBe(true);
  expect(stepperState(projeto({ finalApprovedRevision: 6 }), "revisao").find((etapa) => etapa.id === "entrega")!.locked).toBe(false);
});

it("deliveryItems fica bloqueado sem aprovação da revisão atual, mesmo com verificação antiga", () => {
  for (const aprovada of [null, 5]) {
    const itens = deliveryItems(projeto({ finalApprovedRevision: aprovada }), verificacao(5));
    expect(itens.map((item) => item.id)).toEqual(["video", "legendas", "continuidade"]);
    for (const item of itens) {
      expect(item.state).toBe("bloqueado");
      expect(item.revision).toBe(6);
      expect(item.detail).toContain("v6");
    }
  }
  // Aprovada, mas a verificação é de outra revisão: nada disponível ainda.
  for (const item of deliveryItems(projeto({ finalApprovedRevision: 6 }), verificacao(5))) expect(item.state).toBe("preparar");
});

// ---- 3. Download é da revisão indicada ----

it("todo href leva a revisão do item e todo download leva decupa-r<rev>", () => {
  const caps = { resolve: true, primary: "package" };
  for (const revisao of [3, 6, 12]) {
    const itens = deliveryItems(projeto({ revision: revisao, previewRevision: revisao, finalApprovedRevision: revisao }),
      verificacao(revisao), caps as never, { status: "ready", revision: revisao, drpPath: "/x.drp" });
    const arquivos = itens.flatMap((item) => item.files.map((file) => ({ item, file })));
    expect(arquivos.length).toBeGreaterThan(4);
    for (const { item, file } of arquivos) {
      expect(item.revision).toBe(revisao);
      expect(file.href).toContain(`/${revisao}`);
      expect(file.href).toMatch(new RegExp(`/${revisao}(/|$)`));
      expect(file.download).toMatch(new RegExp(`^decupa-r${revisao}(-|\\.)`));
    }
    expect(arquivos.find(({ file }) => file.id === "package")!.file.download).toBe(`decupa-r${revisao}.tar`);
  }
});

it("itens: disponibilidade, legendas indisponíveis e nota de legenda separada", () => {
  const aprovado = projeto({ finalApprovedRevision: 6 });
  const itens = deliveryItems(aprovado, verificacao(6, { legendas: { status: "indisponivel" } }));
  const por = Object.fromEntries(itens.map((item) => [item.id, item]));
  expect(por.video!.state).toBe("disponivel");
  expect(por.legendas!.state).toBe("indisponivel");
  expect(por.legendas!.detail).toContain("não gerou legendas");
  expect(por.legendas!.note).toContain("não é gravada no MP4");
  expect(por.legendas!.files).toEqual([]);
  expect(deliveryItems(null, null)).toEqual([]);
});

it(".drp só entra com o registro da mesma revisão e aponta project/resolve-drp/<rev>", () => {
  const aprovado = projeto({ finalApprovedRevision: 6 });
  const drp = (registro: Over | null) => deliveryItems(aprovado, verificacao(6), null, registro as never)
    .find((item) => item.id === "continuidade")!.files.find((file) => file.id === "drp");
  expect(drp({ status: "ready", revision: 6, drpPath: "/x.drp" })!.href).toMatch(/project\/resolve-drp\/6$/);
  expect(drp({ status: "ready", revision: 6, drpPath: "/x.drp" })!.download).toBe("decupa-r6-projeto.drp");
  expect(drp({ status: "ready", revision: 5, drpPath: "/x.drp" })).toBeUndefined();
  expect(drp({ status: "ready", revision: 6 })).toBeUndefined();
  expect(drp(null)).toBeUndefined();
});
