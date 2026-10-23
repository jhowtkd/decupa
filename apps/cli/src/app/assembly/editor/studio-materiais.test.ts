// Materiais do studio no DOM falso: a fila desenhada no rail, o modo local
// (POST project/import) e os transportes do modo equipe com cliente falso.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createState } from "./state.js";
import { uploadFingerprint } from "./media-upload.js";
import { MANIFESTO, RESERVA_PERDIDA } from "./studio-fila.js";
import { mountMateriais } from "./studio-materiais.js";
import { domWindow, installDom, type El } from "./fake-dom.test-helper.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const sha = (n: number) => n.toString(16).padStart(64, "0");
const arquivo = (nome: string, tamanho = 10) => new File([new Uint8Array(tamanho)], nome, { type: "video/mp4", lastModified: 1 });

const BODY = '<aside id="rail"><div class="rail-materials"><div id="sources"></div></div></aside>'
  + '<input type="file" id="filePicker" hidden><dialog id="mediaDialog"></dialog>';

function projeto(revision = 3, fontes: string[] = []) {
  return {
    revision,
    assembly: { sources: fontes.map((hash, i) => ({ id: "s" + i, sha256: hash })) },
  };
}

function storage() {
  const dados = new Map<string, string>();
  return {
    dados,
    getItem: (chave: string) => dados.get(chave) ?? null,
    setItem: (chave: string, valor: string) => { dados.set(chave, valor); },
    removeItem: (chave: string) => { dados.delete(chave); },
  };
}

/** Cliente de envio falso, no formato de ResumableMediaUpload. */
function envioFalso() {
  const clientes: Array<{
    opcoes: unknown; start: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn>;
    readSaved: ReturnType<typeof vi.fn>; uploadId: string | null;
    resolver?: (v: unknown) => void; rejeitar?: (e: unknown) => void;
  }> = [];
  const salvos = new Map<string, { id?: string; offset?: number }>();
  const criarEnvio = vi.fn((opcoes: unknown) => {
    const cliente = {
      opcoes,
      uploadId: null as string | null,
      resolver: undefined as undefined | ((v: unknown) => void),
      rejeitar: undefined as undefined | ((e: unknown) => void),
      start: vi.fn(() => new Promise((resolve, reject) => { cliente.resolver = resolve; cliente.rejeitar = reject; })),
      // Como o cliente real: pausar aborta o envio em voo com UploadPausedError.
      pause: vi.fn(() => cliente.rejeitar?.(Object.assign(new Error("envio pausado"), { name: "UploadPausedError" }))),
      cancel: vi.fn(async () => {}),
      readSaved: vi.fn((alvo: File) => salvos.get(uploadFingerprint(alvo)) ?? null),
    };
    clientes.push(cliente);
    return cliente;
  });
  return { criarEnvio, clientes, salvos };
}

type Montagem = {
  fetchImpl?: ReturnType<typeof vi.fn>;
  teamMode?: boolean;
  readOnly?: () => boolean;
  project?: unknown;
  store?: ReturnType<typeof storage>;
  criarEnvio?: ReturnType<typeof envioFalso>["criarEnvio"];
  onConflitoDeReserva?: (body: unknown) => void;
};

function montar({ fetchImpl, teamMode = false, readOnly, project = projeto(), store = storage(), criarEnvio, onConflitoDeReserva }: Montagem = {}) {
  const document = installDom(BODY);
  Object.assign(domWindow(), { removeEventListener: vi.fn(), addEventListener: vi.fn() });
  const state = createState({});
  if (project) state.set("project", project);
  const api = { call: vi.fn(async (_p: string, _o?: unknown) => ({ res: { ok: true, status: 200 }, body: {} })), notifyError: vi.fn() };
  const setStage = vi.fn();
  const onAtividade = vi.fn();
  const mat = mountMateriais({
    state, api, setStage, teamMode, mediaEnabled: teamMode, onAtividade, storage: store as never, projeto: "alpha",
    ...(readOnly ? { readOnly } : {}),
    ...(onConflitoDeReserva ? { onConflitoDeReserva: onConflitoDeReserva as never } : {}),
    ...(fetchImpl ? { fetchImpl: fetchImpl as never } : {}),
    ...(criarEnvio ? { criarEnvio: criarEnvio as never } : {}),
  });
  return { document, state, api, setStage, onAtividade, mat, store };
}

const lis = (document: ReturnType<typeof installDom>) => document.querySelectorAll("#filaLista li");
const respostaOk = (corpo: unknown = {}, status = 200) => ({ ok: status < 400, status, json: async () => corpo });

it("50 arquivos viram 50 linhas na hora, antes de o transporte resolver", () => {
  const { document, mat, setStage } = montar({ teamMode: true, criarEnvio: envioFalso().criarEnvio });
  mat.adicionar(Array.from({ length: 50 }, (_, i) => arquivo(`c${i}.mp4`, 10 + i)));
  expect(lis(document)).toHaveLength(50);
  expect(document.getElementById("filaMateriais")!.hidden).toBe(false);
  expect(document.body.dataset.fila).toBe("ativa");
  expect(lis(document)[0]!.dataset.estado).toBe("enviando");
  expect(lis(document)[1]!.dataset.estado).toBe("aguardando");
  expect(document.getElementById("filaResumo")!.textContent).toContain("0 de 50 no projeto");
  expect(setStage).toHaveBeenCalledWith("materiais");
});

it("fecha o diálogo de Mídia ao adicionar", () => {
  const { document, mat } = montar({ teamMode: true, criarEnvio: envioFalso().criarEnvio });
  const dialog = document.getElementById("mediaDialog")!;
  dialog.showModal();
  mat.adicionar([arquivo("a.mp4")]);
  expect(dialog.open).toBe(false);
});

it("antes do primeiro projeto, adicionar avisa pela API e nada entra", () => {
  const { document, mat, api, setStage } = montar({ project: null, teamMode: true, criarEnvio: envioFalso().criarEnvio });
  mat.adicionar([arquivo("a.mp4")]);
  expect(api.notifyError).toHaveBeenCalledTimes(1);
  expect(lis(document)).toHaveLength(0);
  expect(setStage).not.toHaveBeenCalled();
});

it("em Modo Leitura nada entra", () => {
  const { document, mat, api, setStage } = montar({ readOnly: () => true, teamMode: true, criarEnvio: envioFalso().criarEnvio });
  mat.adicionar([arquivo("a.mp4")]);
  expect(lis(document)).toHaveLength(0);
  expect(api.notifyError).not.toHaveBeenCalled();
  expect(setStage).not.toHaveBeenCalled();
});

it("modo local: POST project/import com baseRevision, nome e x-file-size", async () => {
  const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => respostaOk({
    project: projeto(4, [sha(1)]), operation: null, source: { sha256: sha(1) }, reused: false,
  }));
  const { document, mat, state, onAtividade } = montar({ fetchImpl });
  const arq = arquivo("meu clipe.mp4", 12);
  mat.adicionar([arq]);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const [url, init] = fetchImpl.mock.calls[0]! as [string, RequestInit & { headers: Record<string, string> }];
  expect(url).toBe("/project/import?baseRevision=3&name=" + encodeURIComponent("meu clipe.mp4"));
  expect(init.method).toBe("POST");
  expect(init.headers["x-file-size"]).toBe("12");
  expect(init.body).toBe(arq);
  // Em voo no local: só "remover" (o POST pode ser abortado), e o bootstrap segura as edições.
  expect(init.signal).toBeInstanceOf(AbortSignal);
  expect(lis(document)[0]!.querySelectorAll("button").map((b) => b.dataset.acao)).toEqual(["remover"]);
  expect(onAtividade).toHaveBeenLastCalledWith({ importando: true, rotulo: "Enviando 1/1 · meu clipe.mp4…" });
  await flush();
  expect(state.get("project").revision).toBe(4);
  expect(lis(document)[0]!.dataset.estado).toBe("pronto");
  expect(onAtividade).toHaveBeenLastCalledWith({ importando: false, rotulo: null });
});

it("modo local: num 409 reconcilia com api.call('project') e tenta uma vez", async () => {
  const fetchImpl = vi.fn()
    .mockResolvedValueOnce(respostaOk({ error: "revisão" }, 409))
    .mockResolvedValueOnce(respostaOk({ project: projeto(5, [sha(2)]), source: { sha256: sha(2) } }));
  const { mat, api, state } = montar({ fetchImpl });
  api.call.mockImplementation(async (path: string) => {
    if (path === "project") state.set("project", projeto(4));
    return { res: { ok: true, status: 200 }, body: {} };
  });
  mat.adicionar([arquivo("a.mp4")]);
  await flush();
  expect(api.call).toHaveBeenCalledWith("project");
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(fetchImpl.mock.calls[0]![0]).toContain("baseRevision=3");
  expect(fetchImpl.mock.calls[1]![0]).toContain("baseRevision=4");
  expect(mat.fila.instantanea().itens[0]!.estado).toBe("pronto");
});

it("modo local: dois 409 seguidos viram erro (uma tentativa só)", async () => {
  const fetchImpl = vi.fn(async () => respostaOk({ error: "revisão" }, 409));
  const { mat, api } = montar({ fetchImpl });
  mat.adicionar([arquivo("a.mp4")]);
  await flush();
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(api.call).toHaveBeenCalledTimes(1);
  const item = mat.fila.instantanea().itens[0]!;
  expect(item.estado).toBe("erro");
  expect(item.mensagem).toBe("O projeto mudou durante o envio. Tente de novo.");
});

/** fetch que fica pendente até o abort do `signal`, como o POST de um arquivo grande. */
function fetchPendente() {
  const sinais: AbortSignal[] = [];
  const fetchImpl = vi.fn((_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
    sinais.push(init.signal);
    init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  }));
  return { fetchImpl, sinais };
}

it("modo local: pausar durante o POST aborta o signal, o item fica pausado e retomar faz outro POST", async () => {
  const { fetchImpl, sinais } = fetchPendente();
  const { document, mat } = montar({ fetchImpl: fetchImpl as never });
  mat.adicionar([arquivo("a.mp4")]);
  document.getElementById("filaPausar")!.click();
  expect(sinais[0]!.aborted).toBe(true);
  await flush();
  expect(lis(document)[0]!.dataset.estado).toBe("pausado");
  expect(document.getElementById("filaPausar")!.textContent).toBe("Retomar envio");
  document.getElementById("filaPausar")!.click();
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(sinais[1]!.aborted).toBe(false);
  expect(lis(document)[0]!.dataset.estado).toBe("enviando");
});

it("modo local: remover durante o POST aborta, tira o item da fila e o próximo começa", async () => {
  const { fetchImpl, sinais } = fetchPendente();
  const { document, mat } = montar({ fetchImpl: fetchImpl as never });
  mat.adicionar([arquivo("a.mp4"), arquivo("b.mp4", 11)]);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  lis(document)[0]!.querySelector('button[data-acao="remover"]')!.click();
  expect(sinais[0]!.aborted).toBe(true);
  await flush();
  expect(lis(document)).toHaveLength(1);
  expect(lis(document)[0]!.querySelector(".fila-nome")!.textContent).toBe("b.mp4");
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(mat.fila.instantanea().itens[0]!.estado).toBe("enviando");
});

describe("Reserva perdida", () => {
  it("local: 409 com dono faz um POST só, avisa a Reserva, para a fila com o motivo e o retomar volta a enviar", async () => {
    const dono = { nome: "Ana" };
    const corpo = { dono, error: "Projeto reservado para edição" };
    const fetchImpl = vi.fn(async () => respostaOk(corpo, 409));
    const onConflitoDeReserva = vi.fn();
    const { document, mat, api } = montar({ fetchImpl, onConflitoDeReserva });
    mat.adicionar([arquivo("a.mp4"), arquivo("b.mp4", 11)]);
    await flush();
    // Sem repetir o arquivo inteiro e sem reconciliar como um 409 de revisão.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(api.call).not.toHaveBeenCalled();
    expect(onConflitoDeReserva).toHaveBeenCalledTimes(1);
    expect(onConflitoDeReserva).toHaveBeenCalledWith(corpo);
    const visao = mat.fila.instantanea() as ReturnType<typeof mat.fila.instantanea> & { resumo: string };
    expect(visao.itens.map((item) => item.estado)).toEqual(["pausado", "aguardando"]);
    expect(visao.itens[0]!.mensagem).toBe(RESERVA_PERDIDA);
    expect(visao.resumo).toContain(RESERVA_PERDIDA);
    expect(document.getElementById("filaResumo")!.textContent).toContain(RESERVA_PERDIDA);
    expect(lis(document)[0]!.querySelector(".fila-msg")!.textContent).toBe(RESERVA_PERDIDA);
    // Retomar: o primeiro volta a enviar, e o segundo continua esperando.
    document.getElementById("filaPausar")!.click();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onConflitoDeReserva).toHaveBeenCalledTimes(1);
  });

  it("equipe: project/media com 409 e dono deixa o item pausado com o mediaId, e retomar só associa", async () => {
    const envio = envioFalso();
    const { document, mat, api } = montar({ teamMode: true, criarEnvio: envio.criarEnvio });
    api.call
      .mockResolvedValueOnce({ res: { ok: false, status: 409 }, body: { dono: { nome: "Ana" }, error: "reservado" } })
      .mockResolvedValueOnce({ res: { ok: true, status: 200 }, body: { source: { sha256: sha(8) } } });
    mat.adicionar([arquivo("a.mp4"), arquivo("b.mp4", 11)]);
    envio.clientes[0]!.resolver!({ mediaId: sha(8), deduplicado: false });
    await flush();
    const visao = mat.fila.instantanea();
    expect(visao.itens.map((item) => item.estado)).toEqual(["pausado", "aguardando"]);
    expect(visao.itens[0]!.texto).toBe("Pausado · falta adicionar ao projeto");
    expect(visao.pausado).toBe(true);
    // O segundo não subiu: a fila parou.
    expect(envio.clientes).toHaveLength(1);
    document.getElementById("filaPausar")!.click();
    await flush();
    expect(api.call).toHaveBeenCalledTimes(2);
    expect(JSON.parse((api.call.mock.calls[1]![1] as { body: string }).body).mediaId).toBe(sha(8));
    // O item concluído não foi reenviado: o cliente 0 é o único que fez start do primeiro arquivo.
    expect(envio.clientes[0]!.start).toHaveBeenCalledTimes(1);
    expect(mat.fila.instantanea().itens[0]!.estado).toBe("pronto");
    expect(envio.clientes).toHaveLength(2);
  });

  it("pausarPorReserva com upload em voo chama o pause() do cliente e a fila mostra o motivo", async () => {
    const envio = envioFalso();
    const { document, mat } = montar({ teamMode: true, criarEnvio: envio.criarEnvio });
    mat.adicionar([arquivo("a.mp4")]);
    mat.pausarPorReserva();
    expect(envio.clientes[0]!.pause).toHaveBeenCalledTimes(1);
    await flush();
    const visao = mat.fila.instantanea() as ReturnType<typeof mat.fila.instantanea> & { motivoDaPausa: string };
    expect(visao.pausado).toBe(true);
    expect(visao.motivoDaPausa).toBe(RESERVA_PERDIDA);
    expect(document.getElementById("filaResumo")!.textContent).toContain(RESERVA_PERDIDA);
  });

  it("pausarPorReserva sem nada pendente não faz nada, e a escolha seguinte começa direto", () => {
    const envio = envioFalso();
    const { mat } = montar({ teamMode: true, criarEnvio: envio.criarEnvio });
    mat.pausarPorReserva();
    expect(mat.fila.instantanea().pausado).toBe(false);
    mat.adicionar([arquivo("a.mp4")]);
    expect(envio.clientes).toHaveLength(1);
    expect(envio.clientes[0]!.start).toHaveBeenCalledTimes(1);
  });
});

it("equipe: remover durante o POST de criação apaga a sessão e a impressão do decupa.uploads.v1 (cliente real)", async () => {
  const store = storage();
  const chamadas: Array<{ url: string; metodo: string }> = [];
  let criacao: (valor: unknown) => void = () => {};
  const { document, mat } = montar({ teamMode: true, store });
  // installDom (dentro de montar) troca o fetch global: o falso entra depois.
  vi.stubGlobal("fetch", vi.fn((url: string, init?: { method?: string }) => {
    chamadas.push({ url, metodo: init?.method ?? "GET" });
    if (url === "/api/uploads" && init?.method === "POST") {
      return new Promise((resolve) => {
        criacao = () => resolve({ ok: true, status: 201, json: async () => ({ id: "u1", offset: 0, tamanhoParte: 5 }) });
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  }));
  const arq = arquivo("a.mp4", 12);
  mat.adicionar([arq]);
  await flush();
  expect(chamadas).toEqual([{ url: "/api/uploads", metodo: "POST" }]);
  lis(document)[0]!.querySelector('button[data-acao="remover"]')!.click();
  await flush();
  expect(lis(document)).toHaveLength(0);
  // Só agora o servidor responde, com a sessão já criada.
  criacao(undefined);
  await flush();
  await flush();
  expect(chamadas).toContainEqual({ url: "/api/uploads/u1", metodo: "DELETE" });
  const salvos = JSON.parse(store.dados.get("decupa.uploads.v1") ?? "{}") as Record<string, unknown>;
  expect(salvos[uploadFingerprint(arq)]).toBeUndefined();
  expect(Object.keys(salvos)).toEqual([]);
});

it("equipe: selecionar de novo durante o cancelamento preserva Pausar e a retomada (cliente real)", async () => {
  const store = storage();
  const { document, mat } = montar({ teamMode: true, store });
  const criacoes: Array<(valor: ReturnType<typeof respostaOk>) => void> = [];
  const sinais: AbortSignal[] = [];
  const removidos: string[] = [];
  let terminarLimpeza = () => {};
  const fetchImpl = vi.fn((url: string, init?: RequestInit) => {
    if (url === "/api/uploads" && init?.method === "POST") {
      return new Promise<ReturnType<typeof respostaOk>>((resolve) => criacoes.push(resolve));
    }
    if (init?.method === "DELETE") {
      removidos.push(url);
      if (url === "/api/uploads/antigo") {
        return new Promise<ReturnType<typeof respostaOk>>((resolve) => {
          terminarLimpeza = () => resolve(respostaOk());
        });
      }
      return Promise.resolve(respostaOk());
    }
    if (url === "/api/uploads/novo" && init?.method === "PATCH") {
      const signal = init.signal!;
      sinais.push(signal);
      return new Promise<ReturnType<typeof respostaOk>>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }
    if (url === "/api/uploads/novo" && !init?.method) {
      return Promise.resolve(respostaOk({ id: "novo", offset: 0, tamanhoParte: 5 }));
    }
    throw new Error("Pedido inesperado: " + init?.method + " " + url);
  });
  vi.stubGlobal("fetch", fetchImpl);
  const arq = arquivo("a.mp4", 12);
  const salvo = () => JSON.parse(store.getItem("decupa.uploads.v1") ?? "{}")[uploadFingerprint(arq)];

  mat.adicionar([arq]);
  lis(document)[0]!.querySelector('button[data-acao="remover"]')!.click();
  mat.adicionar([arq]);
  // A identidade continua ocupada enquanto o POST antigo ainda não respondeu.
  expect(criacoes).toHaveLength(1);
  expect(lis(document)[0]!.dataset.estado).toBe("aguardando");
  criacoes[0]!(respostaOk({ id: "antigo", offset: 0, tamanhoParte: 5 }, 201));
  await flush();
  expect(removidos).toEqual(["/api/uploads/antigo"]);
  // Nem a resposta de criação basta: a exclusão também precisa terminar.
  expect(criacoes).toHaveLength(1);
  terminarLimpeza();
  await flush();
  expect(criacoes).toHaveLength(2);
  criacoes[1]!(respostaOk({ id: "novo", offset: 0, tamanhoParte: 5 }, 201));
  await flush();
  expect(salvo()?.id).toBe("novo");
  expect(sinais).toHaveLength(1);

  document.getElementById("filaPausar")!.click();
  expect(sinais[0]!.aborted).toBe(true);
  await flush();
  expect(lis(document)[0]!.dataset.estado).toBe("pausado");
  expect(salvo()?.id).toBe("novo");
  document.getElementById("filaPausar")!.click();
  await flush();
  // Retomar consulta a sessão nova, sem criar outro envio.
  expect(criacoes).toHaveLength(2);
  expect(sinais).toHaveLength(2);
  expect(sinais[1]!.aborted).toBe(false);
  lis(document)[0]!.querySelector('button[data-acao="remover"]')!.click();
  expect(sinais[1]!.aborted).toBe(true);
  await flush();
  expect(removidos).toEqual(["/api/uploads/antigo", "/api/uploads/novo"]);
  expect(salvo()).toBeUndefined();
});

it("equipe: o botão Pausar chama o pausar do cliente de envio e o clique em Remover cancela", async () => {
  const envio = envioFalso();
  const { document, mat } = montar({ teamMode: true, criarEnvio: envio.criarEnvio });
  mat.adicionar([arquivo("a.mp4")]);
  const pausar = document.getElementById("filaPausar")!;
  expect(pausar.hidden).toBe(false);
  expect(pausar.textContent).toBe("Pausar envio");
  pausar.click();
  expect(envio.clientes[0]!.pause).toHaveBeenCalledTimes(1);
  await flush();
  expect(lis(document)[0]!.dataset.estado).toBe("pausado");
  expect(pausar.textContent).toBe("Retomar envio");
  const remover = lis(document)[0]!.querySelector('button[data-acao="remover"]')!;
  remover.click();
  await flush();
  // Pausado, o cliente em voo já saiu do mapa: o cancelamento usa um cliente novo.
  expect(envio.clientes.reduce((n, c) => n + c.cancel.mock.calls.length, 0)).toBe(1);
  expect(lis(document)).toHaveLength(0);
  expect(document.getElementById("filaMateriais")!.hidden).toBe(true);
});

it("equipe: o cancelar de um item restaurado usa o id salvo (readSaved)", async () => {
  const envio = envioFalso();
  const store = storage();
  store.dados.set(MANIFESTO, JSON.stringify({
    projetos: { alpha: [{ chave: "x", nome: "salvo.mp4", tamanho: 100, ultimaModificacao: 7, estado: "pendente" }] },
  }));
  envio.salvos.set(uploadFingerprint({ name: "salvo.mp4", size: 100, lastModified: 7 }), { id: "up-123", offset: 40 });
  const { document, mat } = montar({ teamMode: true, criarEnvio: envio.criarEnvio, store });
  const li = lis(document)[0]!;
  expect(li.dataset.estado).toBe("sem-arquivo");
  expect(li.querySelector(".fila-estado")!.textContent).toBe("Interrompido · 40% enviado");
  expect(document.getElementById("filaEscolher")!.textContent).toBe("Selecionar os arquivos de novo");
  li.querySelector('button[data-acao="remover"]')!.click();
  await flush();
  const cliente = envio.clientes.find((c) => c.cancel.mock.calls.length)!;
  expect(cliente.uploadId).toBe("up-123");
  expect(cliente.cancel).toHaveBeenCalledWith({ name: "salvo.mp4", size: 100, lastModified: 7 });
  expect(mat.fila.instantanea().itens).toHaveLength(0);
});

it("equipe: concluir associa pelo project/media com baseRevision e mediaId", async () => {
  const envio = envioFalso();
  const { mat, api } = montar({ teamMode: true, criarEnvio: envio.criarEnvio });
  api.call.mockResolvedValue({ res: { ok: true, status: 200 }, body: { source: { sha256: sha(8) } } });
  mat.adicionar([arquivo("a.mp4")]);
  envio.clientes[0]!.resolver!({ mediaId: sha(8), deduplicado: false });
  await flush();
  expect(api.call).toHaveBeenCalledTimes(1);
  const [rota, opcoes] = api.call.mock.calls[0]! as [string, { method: string; body: string }];
  expect(rota).toBe("project/media");
  expect(opcoes.method).toBe("POST");
  expect(JSON.parse(opcoes.body)).toEqual({ baseRevision: 3, mediaId: sha(8) });
  expect(mat.fila.instantanea().itens[0]!.estado).toBe("pronto");
});

it("o botão Limpar concluídos some e a linha sai", async () => {
  const fetchImpl = vi.fn(async () => respostaOk({ project: projeto(4, [sha(1)]), source: { sha256: sha(1) } }));
  const { document, mat } = montar({ fetchImpl });
  mat.adicionar([arquivo("a.mp4")]);
  await flush();
  const limpar = document.getElementById("filaLimpar")!;
  expect(limpar.hidden).toBe(false);
  limpar.click();
  expect(lis(document)).toHaveLength(0);
});

export type { El };
