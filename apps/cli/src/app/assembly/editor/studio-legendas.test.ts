// A legenda do studio: o <track> mora no #previewPlayer único e segue a
// revisão do vídeo carregado (data-rev), com o motivo sob o monitor quando a
// rota não tem legenda daquela versão.
import { afterEach, expect, it, vi } from "vitest";
import {
  LEGENDA_FORA_DO_MP4,
  assinaturaLegenda,
  linhaDoMonitor,
  mountLegendas,
  resultadoDaResposta,
} from "./studio-legendas.js";
import { createState } from "./state.js";
import { installDom, type El } from "./fake-dom.test-helper.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const cues = [{ startMs: 0, endMs: 900, text: "alfa beta" }];
const pronto = (sha: string, origem = "atual") => ({
  status: 200, body: { revision: 0, origem, legendas: { status: "pronto", vttSha: sha, srtSha: "s" + sha }, cues },
});

type Resposta = { status: number; body: unknown };
const fluxo = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const esperar = async () => { for (let i = 0; i < 4; i++) await fluxo(); };

function monta(respostas: (rev: number, n: number) => Resposta | Promise<Resposta>, revisao = 2, dataRev: string | null = "2") {
  const document = installDom('<video id="previewPlayer"></video><p id="legendaMonitor" hidden></p>');
  const video = document.getElementById("previewPlayer")!;
  video.src = "/preview/video.mp4";
  if (dataRev !== null) video.setAttribute("data-rev", dataRev);
  const pedidos: number[] = [];
  const fetchFn = vi.fn(async (url: string) => {
    const rev = Number(/subtitles\/(\d+)\/json/.exec(url)![1]);
    pedidos.push(rev);
    const { status, body } = await respostas(rev, pedidos.filter((item) => item === rev).length);
    return { status, json: async () => body };
  });
  const state = createState({});
  const project = (extra: Record<string, unknown> = {}) => ({ revision: revisao, corrections: [], scenes: [{ id: "s1" }], ...extra });
  state.set("project", project());
  const montado = mountLegendas({ state, player: { el: () => video as never }, fetchFn: fetchFn as never });
  const monitor = () => document.getElementById("legendaMonitor")!;
  const tracks = () => video.children.filter((item) => item.tag === "track");
  return { document, video, state, fetchFn, pedidos, project, monitor, tracks, montado };
}

const troca = async (video: El, rev: string | null) => {
  if (rev === null) video.removeAttribute("data-rev"); else video.setAttribute("data-rev", rev);
  video.dispatchEvent({ type: "loadstart", bubbles: false });
  await esperar();
};

it("puras: assinaturaLegenda, resultadoDaResposta e linhaDoMonitor", () => {
  expect(assinaturaLegenda({ revision: 3, corrections: [{ id: "c1", status: "pending" }, { id: "c2", status: "aligned" }] }))
    .toBe("3:c1=pending,c2=aligned");
  expect(assinaturaLegenda({ revision: 3 })).toBe("3:");

  expect(resultadoDaResposta(200, { origem: "historico", legendas: { status: "pronto", vttSha: "v" }, cues }))
    .toEqual({ estado: "pronto", origem: "historico", vttSha: "v", cues });
  expect(resultadoDaResposta(200, { legendas: { status: "indisponivel", motivo: "sem falas retidas na montagem" }, cues: [] }))
    .toEqual({ estado: "sem-fala", motivo: "sem falas retidas na montagem", cues: [] });
  expect(resultadoDaResposta(404, { error: "a v1 não é a prévia" })).toEqual({ estado: "sem-revisao", motivo: "a v1 não é a prévia", cues: [] });
  expect(resultadoDaResposta(500, null)).toEqual({ estado: "erro", motivo: "erro 500", cues: [] });

  expect(linhaDoMonitor({ videoRev: null, atual: 2, resultado: undefined })).toEqual({ hidden: true, tom: "", texto: "" });
  expect(linhaDoMonitor({ videoRev: 2, atual: 2, resultado: { estado: "carregando" } }).texto).toBe("Carregando a legenda da v2…");
  const ok = linhaDoMonitor({ videoRev: 1, atual: 2, resultado: { estado: "pronto" } });
  expect(ok.texto).toBe("Legenda da v1 (prévia exibida) no monitor. " + LEGENDA_FORA_DO_MP4);
  expect(linhaDoMonitor({ videoRev: 2, atual: 2, resultado: { estado: "pronto" } }).texto).not.toContain("prévia exibida");
  expect(linhaDoMonitor({ videoRev: 1, atual: 2, resultado: { estado: "sem-revisao", motivo: "não é a prévia" } }).texto)
    .toBe("Sem legenda no monitor para a v1 (prévia exibida): não é a prévia.");
  expect(LEGENDA_FORA_DO_MP4).toMatch(/não é gravada no MP4/);
});

it("um <track> filho do mesmo player, sem tocar no src nem no data-rev", async () => {
  const { video, monitor, tracks, state } = monta(() => pronto("sha-a"));
  const antes = { src: video.src, rev: video.getAttribute("data-rev"), filhos: video.children.length };
  await esperar();
  expect(tracks()).toHaveLength(1);
  const track = tracks()[0]!;
  expect(track.parentElement).toBe(video);
  expect(track.dataset.legenda).toBe("2");
  expect(track.dataset.sha).toBe("sha-a");
  expect(track.getAttribute("src")).toContain("project/subtitles/2/vtt");
  expect(track.getAttribute("kind")).toBe("subtitles");
  expect(video.src).toBe(antes.src);
  expect(video.getAttribute("data-rev")).toBe(antes.rev);
  expect(antes.filhos).toBe(0);
  expect(video.children).toHaveLength(1);
  expect(monitor().hidden).toBe(false);
  expect(monitor().textContent).toBe("Legenda da v2 no monitor. " + LEGENDA_FORA_DO_MP4);
  // A faixa recebe os cues da revisão atual.
  expect(state.get("legendasFaixa")).toMatchObject({ revision: 2, estado: "pronto", vttSha: "sha-a", cues });
});

it("na troca de data-rev o track antigo sai e o novo entra; o vídeo é o mesmo", async () => {
  const { video, tracks, monitor } = monta((rev) => pronto("sha-" + rev));
  await esperar();
  const primeiro = tracks()[0]!;
  expect(primeiro.dataset.legenda).toBe("2");
  await troca(video, "1");
  expect(tracks()).toHaveLength(1);
  expect(tracks()[0]).not.toBe(primeiro);
  expect(primeiro.isConnected).toBe(false);
  expect(tracks()[0]!.dataset.legenda).toBe("1");
  expect(tracks()[0]!.getAttribute("src")).toContain("project/subtitles/1/vtt");
  expect(video.src).toBe("/preview/video.mp4");
  expect(monitor().textContent).toContain("Legenda da v1 (prévia exibida) no monitor.");
});

it("prévia antiga sem legenda (404): nenhum <track> e a linha diz o motivo", async () => {
  const { video, tracks, monitor } = monta((rev) => (rev === 2
    ? pronto("sha-2")
    : { status: 404, body: { error: "a v1 não é a prévia guardada; revisão anterior só tem legenda pela prévia" } }));
  await esperar();
  expect(tracks()).toHaveLength(1);
  await troca(video, "1");
  expect(tracks()).toHaveLength(0);
  expect(monitor().hidden).toBe(false);
  expect(monitor().textContent)
    .toBe("Sem legenda no monitor para a v1 (prévia exibida): a v1 não é a prévia guardada; revisão anterior só tem legenda pela prévia.");
});

it("sem data-rev (Original) fica sem track e a linha some", async () => {
  const { video, tracks, monitor } = monta(() => pronto("sha-a"));
  await esperar();
  expect(tracks()).toHaveLength(1);
  await troca(video, null);
  expect(tracks()).toHaveLength(0);
  expect(monitor().hidden).toBe(true);
  expect(monitor().textContent).toBe("");
  // Montar já sem data-rev também não põe track.
  const sem = monta(() => pronto("x"), 2, null);
  await esperar();
  expect(sem.tracks()).toHaveLength(0);
  expect(sem.monitor().hidden).toBe(true);
  expect(sem.fetchFn.mock.calls.map(([url]) => String(url)).filter((url) => url.includes("/2/json")).length).toBeGreaterThanOrEqual(1);
});

it("a mesma revisão com o mesmo vttSha não recria o track; sha novo recria", async () => {
  const { video, tracks, state, project, fetchFn } = monta(() => pronto("sha-a"));
  await esperar();
  const track = tracks()[0]!;
  state.set("project", project());
  await esperar();
  video.dispatchEvent({ type: "emptied", bubbles: false });
  await esperar();
  expect(tracks()).toHaveLength(1);
  expect(tracks()[0]).toBe(track);
  // Mesma assinatura: um pedido só para a revisão atual.
  expect(fetchFn).toHaveBeenCalledTimes(1);

  // Correção que termina de alinhar na mesma revisão: assinatura nova, outro vttSha, track novo.
  let sha = "sha-b";
  const segundo = monta(() => pronto(sha));
  await esperar();
  const antes = segundo.tracks()[0]!;
  expect(antes.dataset.sha).toBe("sha-b");
  sha = "sha-c";
  segundo.state.set("project", segundo.project({ corrections: [{ id: "c1", status: "aligned" }] }));
  await esperar();
  expect(segundo.tracks()).toHaveLength(1);
  expect(segundo.tracks()[0]).not.toBe(antes);
  expect(segundo.tracks()[0]!.dataset.sha).toBe("sha-c");
  expect(segundo.fetchFn).toHaveBeenCalledTimes(2);
});

it("resposta atrasada de um vídeo que já saiu é ignorada", async () => {
  const soltar: Record<number, (r: Resposta) => void> = {};
  const { video, tracks, monitor } = monta((rev) => (rev === 1
    ? new Promise<Resposta>((resolve) => { soltar[1] = resolve; })
    : pronto("sha-" + rev)));
  await esperar();
  expect(tracks()[0]!.dataset.legenda).toBe("2");
  // O vídeo da v1 carrega, mas a legenda dele demora; o player já volta à v2.
  video.setAttribute("data-rev", "1");
  video.dispatchEvent({ type: "loadstart", bubbles: false });
  await esperar();
  expect(tracks()).toHaveLength(0);
  expect(monitor().textContent).toBe("Carregando a legenda da v1…");
  await troca(video, "2");
  expect(tracks()[0]!.dataset.legenda).toBe("2");
  soltar[1]!(pronto("sha-1"));
  await esperar();
  expect(tracks()).toHaveLength(1);
  expect(tracks()[0]!.dataset.legenda).toBe("2");
  expect(monitor().textContent).toContain("Legenda da v2 no monitor.");
});

it("erro de rede não deixa track e é tentado de novo no próximo aviso", async () => {
  let falha = true;
  const { video, tracks, monitor, fetchFn } = monta(() => {
    if (falha) throw new Error("rede caiu");
    return pronto("sha-a");
  });
  await esperar();
  expect(tracks()).toHaveLength(0);
  expect(monitor().textContent).toBe("Sem legenda no monitor: não foi possível carregar a legenda da v2.");
  falha = false;
  await troca(video, "2");
  expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(tracks()).toHaveLength(1);
});

it("revisão sem fala retida: sem track, linha com o motivo, faixa em sem-fala", async () => {
  const { tracks, monitor, state } = monta(() => ({
    status: 200, body: { origem: "atual", legendas: { status: "indisponivel", motivo: "sem falas retidas na montagem" }, cues: [] },
  }));
  await esperar();
  expect(tracks()).toHaveLength(0);
  expect(monitor().textContent).toBe("Sem legenda no monitor para a v2: sem falas retidas na montagem.");
  expect(state.get("legendasFaixa")).toMatchObject({ revision: 2, estado: "sem-fala" });
});
