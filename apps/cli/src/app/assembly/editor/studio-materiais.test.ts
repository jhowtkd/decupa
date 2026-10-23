// Materiais do studio no DOM falso: a fila desenhada no rail, o modo local
// (POST project/import) e os transportes do modo equipe com cliente falso.
import { afterEach, expect, it, vi } from "vitest";
import { createState } from "./state.js";
import { uploadFingerprint } from "./media-upload.js";
import { MANIFESTO } from "./studio-fila.js";
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
};

function montar({ fetchImpl, teamMode = false, readOnly, project = projeto(), store = storage(), criarEnvio }: Montagem = {}) {
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
  // Em voo no local: sem ações, e o bootstrap segura as edições.
  expect(lis(document)[0]!.querySelectorAll("button")).toHaveLength(0);
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

it("modo local: remover não age no item em voo", () => {
  const fetchImpl = vi.fn(() => new Promise(() => {}));
  const { document, mat } = montar({ fetchImpl });
  mat.adicionar([arquivo("a.mp4")]);
  mat.fila.remover(mat.fila.instantanea().itens[0]!.chave);
  expect(lis(document)).toHaveLength(1);
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
