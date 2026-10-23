// O formato do studio: proporção com a resolução de saída, fps preservado,
// os dois avisos (não reenquadra; a legenda não vai para o MP4) e o POST.
import { afterEach, expect, it, vi } from "vitest";
import { formatChip, formatRatio, fpsLabel, PROPORCOES } from "./format.js";
import { LEGENDA_FORA_DO_MP4 } from "./studio-legendas.js";
import {
  abrirFormato,
  avisoDeReenquadrar,
  lerFps,
  mountFormato,
  opcoesDeFormato,
  pedidoDeFormato,
  resolucaoDe,
} from "./studio-formato.js";
import { createState } from "./state.js";
import { installDom } from "./fake-dom.test-helper.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const fps = { num: 30000, den: 1001 };
const assembly = (width = 1920, height = 1080, taxa = fps) => ({
  fps: taxa, width, height,
  sources: [
    { id: "a", name: "fala.mp4", hasVideo: true, hasAudio: true, fps: { num: 25, den: 1 } },
    { id: "b", name: "so-audio.wav", hasVideo: false, hasAudio: true },
  ],
});
const projeto = (a = assembly()) => ({ revision: 7, assembly: a, scenes: [], corrections: [] });
const prop = (id: string) => PROPORCOES.find((item) => item.id === id)!;
const par = (n: number) => Number.isInteger(n) && n > 0 && n % 2 === 0;

it("format.js: fpsLabel, formatRatio e formatChip", () => {
  expect(fpsLabel({ num: 30, den: 1 })).toBe("30 fps");
  expect(fpsLabel(fps)).toBe("29,97 fps");
  expect(fpsLabel(null)).toBe("0 fps");
  expect(formatRatio(1920, 1080)).toBe("16:9");
  expect(formatRatio(1080, 1920)).toBe("9:16");
  expect(formatRatio(1080, 1080)).toBe("1:1");
  expect(formatRatio(1080, 1350)).toBe("4:5");
  expect(formatRatio(1000, 600)).toBe("5:3");
  expect(formatRatio(0, 10)).toBe("");
  expect(formatChip(assembly())).toBe("16:9 · 1920×1080 · 29,97 fps");
  expect(formatChip(undefined)).toBe("");
});

it("resolucaoDe mantém o lado menor: 1920×1080 → 1080×1920, 1080×1080 e 1080×1350", () => {
  const a = assembly();
  expect(resolucaoDe(prop("16:9"), a)).toEqual({ width: 1920, height: 1080 });
  expect(resolucaoDe(prop("9:16"), a)).toEqual({ width: 1080, height: 1920 });
  expect(resolucaoDe(prop("1:1"), a)).toEqual({ width: 1080, height: 1080 });
  expect(resolucaoDe(prop("4:5"), a)).toEqual({ width: 1080, height: 1350 });
  // Quadro vertical de partida: o menor continua sendo a largura.
  expect(resolucaoDe(prop("16:9"), assembly(1080, 1920))).toEqual({ width: 1920, height: 1080 });
  expect(resolucaoDe(prop("9:16"), assembly(1080, 1920))).toEqual({ width: 1080, height: 1920 });
});

it("medidas sempre pares, mesmo quando a conta não fecha", () => {
  for (const [w, h] of [[1920, 1080], [1280, 720], [854, 480], [1000, 563], [270, 270], [2, 2], [3840, 2160], [1082, 1922]]) {
    for (const item of PROPORCOES) {
      const r = resolucaoDe(item, assembly(w, h));
      expect(par(r.width) && par(r.height), `${item.id} de ${w}×${h} → ${r.width}×${r.height}`).toBe(true);
    }
  }
  expect(resolucaoDe(prop("4:5"), assembly(1080, 270))).toEqual({ width: 270, height: 338 });
  expect(resolucaoDe(prop("16:9"), assembly(2, 2))).toEqual({ width: 4, height: 2 });
});

it("opcoesDeFormato lista as quatro proporções com a resolução e marca a atual", () => {
  const opcoes = opcoesDeFormato(assembly());
  expect(opcoes.map((o) => [o.id, o.width, o.height, o.atual])).toEqual([
    ["16:9", 1920, 1080, true],
    ["9:16", 1080, 1920, false],
    ["1:1", 1080, 1080, false],
    ["4:5", 1080, 1350, false],
  ]);
  expect(opcoesDeFormato(assembly(1080, 1350)).find((o) => o.atual)?.id).toBe("4:5");
});

it("pedidoDeFormato por proporção leva a resolução certa e o fps atual", () => {
  const p = projeto();
  expect(pedidoDeFormato("9:16", p)).toEqual({ body: { baseRevision: 7, width: 1080, height: 1920, fps: { num: 30000, den: 1001 } } });
  expect(pedidoDeFormato("1:1", p)).toEqual({ body: { baseRevision: 7, width: 1080, height: 1080, fps: { num: 30000, den: 1001 } } });
  expect(pedidoDeFormato("4:5", p)).toEqual({ body: { baseRevision: 7, width: 1080, height: 1350, fps: { num: 30000, den: 1001 } } });
  // O fps não é copiado por referência nem trocado pelo da fonte (25).
  const corpo = pedidoDeFormato("9:16", p).body!;
  expect(corpo.fps).not.toBe(p.assembly.fps);
  expect(pedidoDeFormato("9:16", projeto(assembly(1920, 1080, { num: 24, den: 1 }))).body!.fps).toEqual({ num: 24, den: 1 });
  // O formato que já é o atual não vira pedido.
  expect(pedidoDeFormato("16:9", p)).toEqual({ erro: "Este já é o formato da montagem." });
});

it("pedidoDeFormato: fonte, personalizado e escolha vazia", () => {
  const p = projeto();
  expect(pedidoDeFormato("fonte", p, { sourceId: "a" })).toEqual({ body: { baseRevision: 7, sourceId: "a" } });
  expect(pedidoDeFormato("fonte", p, {})).toEqual({ erro: "Escolha a fonte." });
  expect(pedidoDeFormato("personalizado", p, { width: "1280", height: "720", fps: "30000/1001" }))
    .toEqual({ body: { baseRevision: 7, width: 1280, height: 720, fps: { num: 30000, den: 1001 } } });
  expect(pedidoDeFormato("personalizado", p, { width: "1281", height: "720", fps: "25" }).erro).toMatch(/pares/);
  expect(pedidoDeFormato("personalizado", p, { width: "1280", height: "0", fps: "25" }).erro).toMatch(/pares/);
  expect(pedidoDeFormato("personalizado", p, { width: "1280", height: "720", fps: "abc" }).erro).toMatch(/Fps inválido/);
  expect(pedidoDeFormato("", p).erro).toBe("Escolha um formato.");
});

it("lerFps aceita inteiro, decimal com vírgula e fração; o resto é nulo", () => {
  expect(lerFps("25")).toEqual({ num: 25, den: 1 });
  expect(lerFps("29,97")).toEqual({ num: 29970, den: 1000 });
  expect(lerFps(" 30000/1001 ")).toEqual({ num: 30000, den: 1001 });
  for (const ruim of ["", "0", "-1", "1/0", "a/b", "1/2/3", null, undefined, "Infinity"]) expect(lerFps(ruim), String(ruim)).toBeNull();
});

it("os avisos: (a) não reenquadra, com o fps; (b) a legenda não vai para o MP4", () => {
  const a = avisoDeReenquadrar(assembly());
  expect(a).toContain("Mudar a proporção não reenquadra");
  expect(a).toContain("faixas escuras");
  expect(a).toContain("O fps (29,97) continua o mesmo.");
  expect(avisoDeReenquadrar(assembly(1920, 1080, { num: 25, den: 1 }))).toContain("O fps (25) continua o mesmo.");
  // Preset ou nada escolhido: continua o mesmo; fonte: só as faixas; personalizado: o fps é o do campo.
  expect(avisoDeReenquadrar(assembly(), "9:16")).toContain("O fps (29,97) continua o mesmo.");
  const fonte = avisoDeReenquadrar(assembly(), "fonte");
  expect(fonte).toContain("faixas escuras");
  expect(fonte).not.toContain("continua o mesmo");
  expect(fonte).not.toContain("O fps");
  const livre = avisoDeReenquadrar(assembly(), "personalizado");
  expect(livre).toContain("faixas escuras");
  expect(livre).toContain("O fps passa a ser o do campo.");
  expect(livre).not.toContain("continua o mesmo");
  expect(LEGENDA_FORA_DO_MP4).toBe("A legenda do monitor serve só para conferir: não é gravada no MP4. Ela sai em arquivo separado (.vtt/.srt) na entrega.");
});

function monta(resposta: { ok: boolean; body?: unknown } = { ok: true, body: {} }) {
  const document = installDom('<button id="abrir" data-acao="formato">Formato…</button><button id="outro">x</button>');
  const state = createState({});
  state.set("project", projeto());
  const api = { call: vi.fn(async () => ({ res: { ok: resposta.ok }, body: resposta.body })) };
  mountFormato({ state, api } as never);
  const dialog = document.getElementById("formatoDialog")!;
  const escolhe = (valor: string) => {
    for (const input of dialog.querySelectorAll('input[name="formatoEscolha"]')) input.checked = input.value === valor;
  };
  const aplicar = async () => {
    dialog.querySelector("#formatoForm")!.dispatchEvent({ type: "submit" });
    for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  };
  return { document, state, api, dialog, escolhe, aplicar };
}

it("mountFormato: qualquer [data-acao=formato] abre o diálogo com as opções, os dois avisos e o formato atual", () => {
  const { document, dialog } = monta();
  expect(dialog.open).toBe(false);
  document.getElementById("outro")!.click();
  expect(dialog.open).toBe(false);
  document.getElementById("abrir")!.click();
  expect(dialog.open).toBe(true);
  expect(dialog.querySelector("#formatoAgora")!.textContent).toBe("16:9 · 1920×1080 · 29,97 fps");
  const opcoes = dialog.querySelectorAll("#formatoProporcoes input").map((input) => input.value);
  expect(opcoes).toEqual(["16:9", "9:16", "1:1", "4:5"]);
  expect(dialog.querySelectorAll('input[name="formatoEscolha"]').find((input) => input.checked)?.value).toBe("16:9");
  // O atual não se aplica de novo.
  expect(dialog.querySelector("#formatoAplicar")!.disabled).toBe(true);
  const notas = dialog.querySelectorAll(".formato-nota").map((el) => el.textContent);
  expect(notas).toContain(avisoDeReenquadrar(assembly()));
  expect(notas).toContain(LEGENDA_FORA_DO_MP4);
  // Só fontes com vídeo entram na lista de fontes.
  expect(dialog.querySelectorAll("#formatoFonte option")).toHaveLength(1);
});

it("abrirFormato() abre o mesmo diálogo (Entrega)", () => {
  const { dialog } = monta();
  abrirFormato();
  expect(dialog.open).toBe(true);
  expect(dialog.showCount).toBe(1);
});

it("aplicar 9:16 faz POST project/settings com resolução nova e o fps atual, e fecha", async () => {
  const { document, api, dialog, escolhe, aplicar } = monta();
  document.getElementById("abrir")!.click();
  escolhe("9:16");
  await aplicar();
  expect(api.call).toHaveBeenCalledTimes(1);
  const [caminho, init] = api.call.mock.calls[0] as unknown as [string, { method: string; body: string }];
  expect(caminho).toBe("project/settings");
  expect(init.method).toBe("POST");
  expect(JSON.parse(init.body)).toEqual({ baseRevision: 7, width: 1080, height: 1920, fps: { num: 30000, den: 1001 } });
  expect(dialog.open).toBe(false);
});

// DEFEITO (reportado ao implementador): o finally de aplicar() chama pintarEscolha(),
// que limpa #formatoErro logo depois de mostrá-lo. Troque it.fails por it quando corrigir.
it("aplicar com resposta de erro mantém o diálogo aberto e o motivo visível", async () => {
  const falha = monta({ ok: false, body: { error: "revisão desatualizada" } });
  falha.document.getElementById("abrir")!.click();
  falha.escolhe("1:1");
  await falha.aplicar();
  expect(falha.dialog.open).toBe(true);
  expect(falha.dialog.querySelector("#formatoErro")!.textContent).toBe("revisão desatualizada");
  expect(falha.dialog.querySelector("#formatoErro")!.hidden).toBe(false);
});

it("resposta de erro mantém o diálogo aberto; formato igual ao atual nem chama a API", async () => {
  const falha = monta({ ok: false, body: { error: "revisão desatualizada" } });
  falha.document.getElementById("abrir")!.click();
  falha.escolhe("1:1");
  await falha.aplicar();
  expect(falha.api.call).toHaveBeenCalledTimes(1);
  expect(falha.dialog.open).toBe(true);

  const atual = monta();
  atual.document.getElementById("abrir")!.click();
  atual.escolhe("16:9");
  await atual.aplicar();
  expect(atual.api.call).not.toHaveBeenCalled();
  expect(atual.dialog.querySelector("#formatoErro")!.textContent).toBe("Este já é o formato da montagem.");
});

// ---- Aviso por escolha e diálogo aberto ----

const muda = (alvo: { dispatchEvent: (e: { type: string }) => void }) => alvo.dispatchEvent({ type: "change" });

it("o aviso do diálogo acompanha a escolha: preset 'continua o mesmo', fonte com o fps dela, personalizado 'o do campo'", () => {
  const { document, dialog, escolhe } = monta();
  document.getElementById("abrir")!.click();
  const nota = () => dialog.querySelector("#formatoReenquadra")!.textContent;
  expect(nota()).toContain("O fps (29,97) continua o mesmo.");

  escolhe("9:16");
  muda(dialog.querySelectorAll('input[name="formatoEscolha"]').find((i) => i.value === "9:16")!);
  expect(nota()).toContain("O fps (29,97) continua o mesmo.");

  escolhe("fonte");
  muda(dialog.querySelectorAll('input[name="formatoEscolha"]').find((i) => i.value === "fonte")!);
  expect(nota()).toContain("faixas escuras");
  expect(nota()).not.toContain("continua o mesmo");
  const aviso = dialog.querySelector("#formatoFonteAviso")!;
  expect(aviso.hidden).toBe(false);
  expect(aviso.textContent).toBe("Adota o tamanho e o fps de fala.mp4 (25 fps), não só a proporção.");

  escolhe("personalizado");
  muda(dialog.querySelectorAll('input[name="formatoEscolha"]').find((i) => i.value === "personalizado")!);
  expect(nota()).toContain("O fps passa a ser o do campo.");
  expect(nota()).not.toContain("continua o mesmo");

  escolhe("1:1");
  muda(dialog.querySelectorAll('input[name="formatoEscolha"]').find((i) => i.value === "1:1")!);
  expect(nota()).toContain("O fps (29,97) continua o mesmo.");
});

it("com o diálogo aberto, projeto novo com outro quadro atualiza as resoluções e mantém a escolha", () => {
  const { document, state, dialog, escolhe } = monta();
  document.getElementById("abrir")!.click();
  escolhe("9:16");
  muda(dialog.querySelectorAll('input[name="formatoEscolha"]').find((i) => i.value === "9:16")!);
  const resolucoes = () => dialog.querySelectorAll("#formatoProporcoes .formato-opcao").map((el) => el.querySelector(".mono")!.textContent);
  expect(resolucoes()).toEqual(["1920×1080", "1080×1920", "1080×1080", "1080×1350"]);

  state.set("project", { ...projeto(assembly(1280, 720)), revision: 8 });
  expect(resolucoes()).toEqual(["1280×720", "720×1280", "720×720", "720×900"]);
  expect(dialog.querySelectorAll('input[name="formatoEscolha"]').find((i) => i.checked)?.value).toBe("9:16");
  expect(dialog.querySelector("#formatoAgora")!.textContent).toBe("16:9 · 1280×720 · 29,97 fps");
  expect(dialog.open).toBe(true);
});

it("o repreenchimento guarda a fonte escolhida e o que foi digitado no personalizado", () => {
  const { document, state, dialog, escolhe } = monta();
  const duas = (largura: number) => ({
    ...projeto({ ...assembly(largura, 1080), sources: [
      { id: "a", name: "fala.mp4", hasVideo: true, hasAudio: true, fps: { num: 25, den: 1 } },
      { id: "c", name: "mudo.mp4", hasVideo: true, hasAudio: false, fps: { num: 24, den: 1 } },
    ] } as never),
    revision: 9,
  });
  state.set("project", duas(1920));
  document.getElementById("abrir")!.click();
  const select = dialog.querySelector("#formatoFonte")!;
  expect(dialog.querySelectorAll("#formatoFonte option")).toHaveLength(2);
  select.value = "c";
  escolhe("fonte");
  muda(select);
  expect(dialog.querySelector("#formatoFonteAviso")!.textContent).toBe("Adota o tamanho e o fps de mudo.mp4 (24 fps), não só a proporção.");
  state.set("project", duas(1280));
  expect(dialog.querySelector("#formatoFonte")!.value).toBe("c");
  expect(dialog.querySelectorAll('input[name="formatoEscolha"]').find((i) => i.checked)?.value).toBe("fonte");

  escolhe("personalizado");
  dialog.querySelector("#formatoLargura")!.value = "1000";
  dialog.querySelector("#formatoAltura")!.value = "500";
  dialog.querySelector("#formatoFps")!.value = "24";
  muda(dialog.querySelector("#formatoLargura")!);
  state.set("project", duas(1920));
  expect(dialog.querySelector("#formatoLargura")!.value).toBe("1000");
  expect(dialog.querySelector("#formatoAltura")!.value).toBe("500");
  expect(dialog.querySelector("#formatoFps")!.value).toBe("24");
  expect(dialog.querySelectorAll('input[name="formatoEscolha"]').find((i) => i.checked)?.value).toBe("personalizado");
});

it("o erro do POST recusado sobrevive ao repreenchimento e some ao mudar a escolha ou reabrir", async () => {
  const { document, state, dialog, escolhe, aplicar } = monta({ ok: false, body: { error: "revisão desatualizada" } });
  document.getElementById("abrir")!.click();
  escolhe("1:1");
  await aplicar();
  const erro = dialog.querySelector("#formatoErro")!;
  expect(erro.textContent).toBe("revisão desatualizada");
  expect(erro.hidden).toBe(false);

  state.set("project", { ...projeto(assembly(1280, 720)), revision: 8 });
  expect(erro.textContent).toBe("revisão desatualizada");
  expect(erro.hidden).toBe(false);

  escolhe("4:5");
  muda(dialog.querySelectorAll('input[name="formatoEscolha"]').find((i) => i.value === "4:5")!);
  expect(erro.textContent).toBe("");
  expect(erro.hidden).toBe(true);

  await aplicar();
  expect(erro.hidden).toBe(false);
  dialog.close();
  document.getElementById("abrir")!.click();
  expect(erro.textContent).toBe("");
});

it("projeto novo com o diálogo fechado não repreenche nada", () => {
  const { state, dialog } = monta();
  state.set("project", { ...projeto(assembly(1280, 720)), revision: 8 });
  expect(dialog.querySelectorAll("#formatoProporcoes .formato-opcao")).toHaveLength(0);
  expect(dialog.open).toBe(false);
});
