// O modelo puro da fila de Materiais (sem DOM): todo arquivo aparece antes do
// primeiro envio, um por vez, o manifesto decupa.materiais.v1 sobrevive à
// recarga e nada concluído sobe de novo. Transportes falsos, como no gaveta.test.ts.
import { describe, expect, it, vi } from "vitest";
import { uploadFingerprint } from "./media-upload.js";
import {
  IMPRESSAO_CONCLUIDA, IMPRESSAO_REPETIDA, MANIFESTO, MAX_ITENS, RESERVA_PERDIDA, acoesDoItem, aparar, criarFila, gravarManifesto, lerManifesto, mensagemDeErro,
  motivoInvalido, textoDoItem,
} from "./studio-fila.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const sha = (n: number) => n.toString(16).padStart(64, "0");

function arquivo(nome: string, tamanho = 10, tipo = "video/mp4", modificado = 1) {
  return new File([new Uint8Array(tamanho)], nome, { type: tipo, lastModified: modificado });
}

function arquivos(quantos: number) {
  return Array.from({ length: quantos }, (_, i) => arquivo(`clipe-${String(i + 1).padStart(2, "0")}.mp4`, 10 + i));
}

function storageEmMemoria(inicial?: string) {
  const dados = new Map<string, string>();
  if (inicial !== undefined) dados.set(MANIFESTO, inicial);
  return {
    dados,
    getItem: vi.fn((chave: string) => dados.get(chave) ?? null),
    setItem: vi.fn((chave: string, valor: string) => { dados.set(chave, valor); }),
    removeItem: vi.fn((chave: string) => { dados.delete(chave); }),
  };
}

type Pendente = { item: { nome: string; arquivo: File | null }; resolve(valor: unknown): void; reject(erro: unknown): void };

/** Transporte falso: cada `enviar` fica pendente até o teste decidir o desfecho. */
function transporte() {
  const envios: Pendente[] = [];
  const enviar = vi.fn((item: Pendente["item"]) => new Promise((resolve, reject) => { envios.push({ item, resolve, reject }); }));
  return { envios, enviar };
}

type Opcoes = Partial<Parameters<typeof criarFila>[0]> & { shas?: Set<string> | null };

function montar({ shas = new Set<string>(), ...resto }: Opcoes = {}) {
  const t = transporte();
  let fontes: Set<string> | null = shas;
  const config = {
    modo: "equipe" as const,
    projeto: "alpha",
    chaveDoArquivo: uploadFingerprint,
    enviar: t.enviar,
    adicionar: vi.fn(async (mediaId: string) => ({ sha256: mediaId, reaproveitada: false })),
    pausar: vi.fn(),
    cancelar: vi.fn(async () => {}),
    parcial: vi.fn(() => null),
    fontes: () => fontes,
    storage: storageEmMemoria(),
    ...resto,
  };
  const fila = criarFila(config as Parameters<typeof criarFila>[0]);
  return { fila, t, config, storage: config.storage as ReturnType<typeof storageEmMemoria>, setFontes: (valor: Set<string> | null) => { fontes = valor; } };
}

type Fila = ReturnType<typeof criarFila>;
/** A visão devolve também resumo e pausa/retomada, que o tipo inferido do JS não enxerga. */
const vista = (fila: Fila) => fila.instantanea() as ReturnType<Fila["instantanea"]> & { resumo: string; podeRetomar: boolean; podePausar: boolean };
const estados = (fila: Fila) => fila.instantanea().itens.map((item) => item.estado);

describe("50 arquivos entram na fila antes do primeiro envio", () => {
  it("equipe: 50 itens, o primeiro enviando, os outros aguardando e um envio só", () => {
    const { fila, t } = montar();
    fila.sincronizar();
    const novos = fila.adicionarArquivos(arquivos(50));
    const visao = vista(fila);
    expect(novos).toBe(50);
    expect(visao.itens).toHaveLength(50);
    expect(visao.itens[0]!.estado).toBe("enviando");
    expect(visao.itens.slice(1).every((item) => item.estado === "aguardando")).toBe(true);
    expect(t.enviar).toHaveBeenCalledTimes(1);
    expect(visao.itens[0]!.nome).toBe("clipe-01.mp4");
    expect(visao.resumo).toContain("0 de 50 no projeto");
  });

  it("é um por vez: o próximo só começa quando o anterior conclui", async () => {
    const { fila, t } = montar();
    fila.sincronizar();
    fila.adicionarArquivos(arquivos(3));
    expect(t.enviar).toHaveBeenCalledTimes(1);
    t.envios[0]!.resolve({ mediaId: sha(1), deduplicado: false });
    await flush();
    expect(estados(fila)).toEqual(["pronto", "enviando", "aguardando"]);
    expect(t.enviar).toHaveBeenCalledTimes(2);
    t.envios[1]!.resolve({ mediaId: sha(2), deduplicado: true });
    await flush();
    expect(t.enviar).toHaveBeenCalledTimes(3);
    t.envios[2]!.resolve({ mediaId: sha(3), deduplicado: false });
    await flush();
    expect(estados(fila)).toEqual(["pronto", "pronto", "pronto"]);
    expect(t.enviar).toHaveBeenCalledTimes(3);
    expect(fila.instantanea().itens[1]!.texto).toBe("No projeto · Mídia reaproveitada");
  });

  it("local: um por vez também, sem passar pelo acervo", async () => {
    const { fila, t, config } = montar({ modo: "local" });
    fila.sincronizar();
    fila.adicionarArquivos(arquivos(2));
    expect(t.enviar).toHaveBeenCalledTimes(1);
    t.envios[0]!.resolve({ sha256: sha(1), reaproveitada: false });
    await flush();
    expect(t.enviar).toHaveBeenCalledTimes(2);
    expect(config.adicionar).not.toHaveBeenCalled();
    expect(estados(fila)).toEqual(["pronto", "enviando"]);
  });

  it("antes do primeiro projeto os 50 aparecem e nada é enviado", () => {
    const { fila, t, setFontes } = montar({ shas: null });
    fila.adicionarArquivos(arquivos(50));
    const visao = fila.instantanea();
    expect(visao.itens).toHaveLength(50);
    expect(visao.itens.every((item) => item.estado === "aguardando")).toBe(true);
    expect(t.enviar).not.toHaveBeenCalled();
    // O projeto chega: a restauração libera o primeiro envio, e só ele.
    setFontes(new Set());
    fila.sincronizar();
    expect(t.enviar).toHaveBeenCalledTimes(1);
    expect(estados(fila)[0]).toBe("enviando");
  });
});

describe("interrupção e nova seleção não reenviam concluídos", () => {
  /** Primeira vida: 3 concluídos, o 4º em voo (parcial) e o 5º que nunca começou. */
  async function primeiraVida() {
    const arqs = arquivos(5);
    const storage = storageEmMemoria();
    const concluidos = new Set([sha(1), sha(2), sha(3)]);
    const a = montar({ storage, shas: concluidos });
    a.fila.sincronizar();
    a.fila.adicionarArquivos(arqs);
    for (let i = 0; i < 3; i += 1) {
      a.t.envios[i]!.resolve({ mediaId: sha(i + 1), deduplicado: false });
      await flush();
    }
    expect(estados(a.fila)).toEqual(["pronto", "pronto", "pronto", "enviando", "aguardando"]);
    return { arqs, storage, concluidos };
  }

  it("a recarga mostra 3 prontos, 1 interrompido com 40% e 1 que nunca começou", async () => {
    const { arqs, storage, concluidos } = await primeiraVida();
    const b = montar({
      storage, shas: concluidos,
      parcial: vi.fn((entrada: { nome: string }) => (entrada.nome === arqs[3]!.name ? 40 : null)),
    });
    b.fila.restaurar();
    const itens = b.fila.instantanea().itens;
    expect(itens.map((item) => item.estado)).toEqual(["pronto", "pronto", "pronto", "sem-arquivo", "sem-arquivo"]);
    expect(itens[3]!.percent).toBe(40);
    expect(itens[3]!.texto).toBe("Interrompido · 40% enviado");
    expect(itens[4]!.percent).toBeNull();
    expect(itens[4]!.texto).toBe("Não enviado");
    expect(b.t.enviar).not.toHaveBeenCalled();
    expect(b.fila.instantanea().precisaArquivo).toBe(true);
  });

  it("sincronizar também restaura (o primeiro projeto chega depois)", async () => {
    const { storage, concluidos } = await primeiraVida();
    const b = montar({ storage, shas: null });
    b.fila.sincronizar();
    expect(b.fila.instantanea().itens).toHaveLength(0);
    b.setFontes(concluidos);
    b.fila.sincronizar();
    expect(b.fila.instantanea().itens).toHaveLength(5);
  });

  it("selecionar os mesmos 5 de novo só envia o 4º e o 5º", async () => {
    const { arqs, storage, concluidos } = await primeiraVida();
    const b = montar({ storage, shas: concluidos });
    b.fila.restaurar();
    const novos = b.fila.adicionarArquivos(arqs);
    expect(novos).toBe(2);
    const itens = b.fila.instantanea().itens;
    expect(itens.slice(0, 3).every((item) => item.estado === "pronto" && item.reconhecido)).toBe(true);
    expect(itens[0]!.texto).toBe("Já no projeto · não reenviado");
    expect(b.t.enviar).toHaveBeenCalledTimes(1);
    expect(b.t.envios[0]!.item.nome).toBe(arqs[3]!.name);
    expect(b.t.envios[0]!.item.arquivo).toBe(arqs[3]);
    b.t.envios[0]!.resolve({ mediaId: sha(4), deduplicado: false });
    await flush();
    expect(b.t.enviar).toHaveBeenCalledTimes(2);
    expect(b.t.envios[1]!.item.nome).toBe(arqs[4]!.name);
  });

  it("se a fonte saiu do projeto, o concluído some na restauração e a nova seleção reenvia", async () => {
    const { arqs, storage } = await primeiraVida();
    // O projeto só guarda as fontes 1 e 2: a 3 foi removida.
    const b = montar({ storage, shas: new Set([sha(1), sha(2)]) });
    b.fila.restaurar();
    const antes = b.fila.instantanea().itens;
    expect(antes.map((item) => item.nome)).toEqual([arqs[0]!.name, arqs[1]!.name, arqs[3]!.name, arqs[4]!.name]);
    b.fila.adicionarArquivos([arqs[2]!]);
    expect(b.t.enviar).toHaveBeenCalledTimes(1);
    expect(b.t.envios[0]!.item.nome).toBe(arqs[2]!.name);
  });

  it("sincronizar tira da fila o concluído cuja fonte saiu depois", async () => {
    const { fila, setFontes } = montar({ shas: new Set([sha(1)]) });
    fila.sincronizar();
    // Simula um concluído: envia, conclui e depois tira a fonte do projeto.
    fila.adicionarArquivos([arquivo("um.mp4")]);
    await Promise.resolve();
    setFontes(new Set());
    fila.sincronizar();
    expect(fila.instantanea().itens.filter((item) => item.estado === "pronto")).toHaveLength(0);
  });
});

describe("parcial, pausa, erros e associação", () => {
  it("pausar chama o pausar do transporte; UploadPausedError deixa o item pausado e retomar envia de novo o mesmo arquivo", async () => {
    const { fila, t, config } = montar();
    fila.sincronizar();
    const [primeiro] = arquivos(1);
    fila.adicionarArquivos([primeiro!]);
    fila.pausar();
    expect(config.pausar).toHaveBeenCalledTimes(1);
    t.envios[0]!.reject(Object.assign(new Error("envio pausado"), { name: "UploadPausedError" }));
    await flush();
    const visao = vista(fila);
    expect(visao.itens[0]!.estado).toBe("pausado");
    expect(visao.pausado).toBe(true);
    expect(visao.podeRetomar).toBe(true);
    fila.retomar();
    expect(t.enviar).toHaveBeenCalledTimes(2);
    expect(t.envios[1]!.item.arquivo).toBe(primeiro);
  });

  it("erro sem status (rede) pausa a fila com mensagem e não começa o próximo", async () => {
    const { fila, t } = montar();
    fila.sincronizar();
    fila.adicionarArquivos(arquivos(2));
    t.envios[0]!.reject(new TypeError("Failed to fetch"));
    await flush();
    const visao = fila.instantanea();
    expect(visao.itens.map((item) => item.estado)).toEqual(["pausado", "aguardando"]);
    expect(visao.itens[0]!.mensagem).toMatch(/Conexão interrompida/);
    expect(visao.pausado).toBe(true);
    expect(t.enviar).toHaveBeenCalledTimes(1);
    fila.retomar();
    expect(t.enviar).toHaveBeenCalledTimes(2);
    expect(t.envios[1]!.item.nome).toBe("clipe-01.mp4");
  });

  it("erro HTTP (413) vira erro e a fila segue para o próximo", async () => {
    const { fila, t } = montar();
    fila.sincronizar();
    fila.adicionarArquivos(arquivos(2));
    t.envios[0]!.reject(Object.assign(new Error("grande"), { status: 413 }));
    await flush();
    const visao = fila.instantanea();
    expect(visao.itens[0]!.estado).toBe("erro");
    expect(visao.itens[0]!.texto).toBe("Falhou");
    expect(visao.itens[0]!.mensagem).toBe("Este arquivo passa do tamanho máximo permitido.");
    expect(visao.itens[0]!.acoes).toEqual(["tentar", "remover"]);
    expect(visao.pausado).toBe(false);
    expect(visao.itens[1]!.estado).toBe("enviando");
    expect(t.enviar).toHaveBeenCalledTimes(2);
  });

  it("upload concluído com falha na associação vira erro com mediaId e tentar de novo só associa", async () => {
    const adicionar = vi.fn()
      .mockRejectedValueOnce(new Error("revisão mudou"))
      .mockResolvedValueOnce({ sha256: sha(7), reaproveitada: false });
    const { fila, t, storage } = montar({ adicionar });
    fila.sincronizar();
    const [primeiro] = arquivos(1);
    fila.adicionarArquivos([primeiro!]);
    t.envios[0]!.resolve({ mediaId: sha(7), deduplicado: false });
    await flush();
    const item = fila.instantanea().itens[0]!;
    expect(item.estado).toBe("erro");
    expect(item.texto).toBe("Enviado · falta adicionar ao projeto");
    expect(item.mensagem).toContain("revisão mudou");
    expect(item.acoes).toEqual(["adicionar", "remover"]);
    // O manifesto guarda o mediaId, não o arquivo.
    expect(JSON.parse(storage.dados.get(MANIFESTO)!).projetos.alpha[0]).toMatchObject({ estado: "enviado", mediaId: sha(7) });
    fila.tentarDeNovo(item.chave);
    await flush();
    expect(adicionar).toHaveBeenCalledTimes(2);
    expect(adicionar).toHaveBeenLastCalledWith(sha(7));
    expect(t.enviar).toHaveBeenCalledTimes(1);
    expect(estados(fila)).toEqual(["pronto"]);
  });

  it("depois da recarga o item enviado volta sem arquivo e adiciona sem ele", async () => {
    const adicionar = vi.fn(async (mediaId: string) => ({ sha256: mediaId, reaproveitada: false }));
    const storage = storageEmMemoria();
    gravarManifesto(storage, "alpha", [{
      chave: "b.mp4\u000010\u00001", nome: "b.mp4", tamanho: 10, ultimaModificacao: 1, estado: "enviado", mediaId: sha(9),
    }]);
    const { fila, t } = montar({ storage, adicionar });
    fila.restaurar();
    const item = fila.instantanea().itens[0]!;
    expect(item.estado).toBe("sem-arquivo");
    expect(item.texto).toBe("Enviado · falta adicionar ao projeto");
    expect(item.acoes).toEqual(["adicionar", "remover"]);
    fila.tentarDeNovo(item.chave);
    await flush();
    expect(adicionar).toHaveBeenCalledWith(sha(9));
    expect(t.enviar).not.toHaveBeenCalled();
    expect(estados(fila)).toEqual(["pronto"]);
  });

  it("enviado ao acervo cuja fonte já está no projeto volta como pronto", () => {
    const storage = storageEmMemoria();
    gravarManifesto(storage, "alpha", [{
      chave: "c", nome: "c.mp4", tamanho: 10, ultimaModificacao: 1, estado: "enviado", mediaId: sha(5),
    }]);
    const { fila } = montar({ storage, shas: new Set([sha(5)]) });
    fila.restaurar();
    expect(estados(fila)).toEqual(["pronto"]);
  });

  it("remover cancela o parcial no servidor, nos dois modos, inclusive no item em voo", () => {
    const equipe = montar();
    equipe.fila.sincronizar();
    equipe.fila.adicionarArquivos(arquivos(1));
    equipe.fila.remover(equipe.fila.instantanea().itens[0]!.chave);
    expect(equipe.config.cancelar).toHaveBeenCalledTimes(1);
    expect(equipe.fila.instantanea().itens).toHaveLength(0);

    const local = montar({ modo: "local" });
    local.fila.sincronizar();
    local.fila.adicionarArquivos(arquivos(1));
    const item = local.fila.instantanea().itens[0]!;
    // O POST local agora pode ser abortado: o item em voo oferece "remover".
    expect(item.acoes).toEqual(["remover"]);
    local.fila.remover(item.chave);
    expect(local.fila.instantanea().itens).toHaveLength(0);
    expect(local.config.cancelar).toHaveBeenCalledTimes(1);
  });
});

describe("manifesto decupa.materiais.v1", () => {
  const entrada = (n: number, estado: "pendente" | "concluido" | "enviado" = "concluido") => ({
    chave: "k" + n, nome: `f${n}.mp4`, tamanho: 10, ultimaModificacao: n, estado,
    ...(estado === "concluido" ? { sha256: sha(n) } : {}), ...(estado === "enviado" ? { mediaId: sha(n) } : {}),
  });

  it("JSON corrompido ou storage que lança vira vazio, sem quebrar", () => {
    expect(lerManifesto(storageEmMemoria("{não é json")).size).toBe(0);
    expect(lerManifesto(storageEmMemoria('{"projetos":[1,2]}')).size).toBe(0);
    expect(lerManifesto({ getItem: () => { throw new Error("bloqueado"); } } as never).size).toBe(0);
    expect(lerManifesto(undefined).size).toBe(0);
    // A fila sobe normalmente em cima de um manifesto corrompido.
    const { fila } = montar({ storage: storageEmMemoria("{lixo") });
    expect(() => fila.restaurar()).not.toThrow();
    expect(fila.instantanea().itens).toEqual([]);
  });

  it("entradas inválidas são descartadas e as boas ficam", () => {
    const raw = JSON.stringify({
      projetos: {
        alpha: [
          entrada(1),
          { ...entrada(2), sha256: "curto" },
          { ...entrada(3, "enviado"), mediaId: "x" },
          { ...entrada(4), estado: "outro" },
          { ...entrada(5), tamanho: -1 },
          { ...entrada(6), chave: "" },
          null,
          "texto",
          entrada(7, "pendente"),
        ],
        vazio: [{ lixo: true }],
      },
    });
    const lido = lerManifesto(storageEmMemoria(raw));
    expect(lido.get("alpha")!.map((item: { chave: string }) => item.chave)).toEqual(["k1", "k7"]);
    expect(lido.has("vazio")).toBe(false);
  });

  it("a gravação relê o storage e preserva outro projeto", () => {
    const storage = storageEmMemoria();
    gravarManifesto(storage, "alpha", [entrada(1)]);
    // Outra aba grava `beta` entre duas gravações de `alpha`.
    gravarManifesto(storage, "beta", [entrada(2)]);
    gravarManifesto(storage, "alpha", [entrada(1), entrada(3)]);
    const lido = lerManifesto(storage);
    expect(lido.get("alpha")).toHaveLength(2);
    expect(lido.get("beta")).toHaveLength(1);
    // Zerar um projeto não apaga o outro.
    gravarManifesto(storage, "alpha", []);
    expect([...lerManifesto(storage).keys()]).toEqual(["beta"]);
    gravarManifesto(storage, "beta", []);
    expect(storage.dados.has(MANIFESTO)).toBe(false);
  });

  it("falha do storage na gravação não chega à fila", () => {
    const storage = {
      getItem: () => null,
      setItem: () => { throw new Error("cheio"); },
      removeItem: () => {},
    };
    const { fila } = montar({ storage });
    fila.sincronizar();
    expect(() => fila.adicionarArquivos(arquivos(1))).not.toThrow();
    expect(fila.instantanea().itens).toHaveLength(1);
  });

  it("aparar tira os concluídos mais antigos primeiro (teto MAX_ITENS)", () => {
    expect(MAX_ITENS).toBe(200);
    const concluidos = Array.from({ length: 150 }, (_, i) => entrada(i + 1));
    const pendentes = Array.from({ length: 100 }, (_, i) => entrada(1000 + i, "pendente"));
    const resultado = aparar([...concluidos, ...pendentes]);
    expect(resultado).toHaveLength(MAX_ITENS);
    // Saíram os 50 concluídos mais antigos; os pendentes ficaram todos.
    expect(resultado.filter((item) => item.estado === "pendente")).toHaveLength(100);
    expect(resultado[0]!.chave).toBe("k51");
    expect(aparar([entrada(1), entrada(2), entrada(3)], 2).map((item: { chave: string }) => item.chave)).toEqual(["k2", "k3"]);
    // Sem concluídos, sobram os mais recentes.
    expect(aparar([entrada(1, "pendente"), entrada(2, "pendente"), entrada(3, "pendente")], 2).map((item: { chave: string }) => item.chave)).toEqual(["k2", "k3"]);
  });

  it("a gravação aplica o teto por projeto", () => {
    const storage = storageEmMemoria();
    gravarManifesto(storage, "alpha", Array.from({ length: 230 }, (_, i) => entrada(i + 1)));
    expect(lerManifesto(storage).get("alpha")).toHaveLength(MAX_ITENS);
  });

  it("remover apaga a entrada e limparConcluidos tira os concluídos do manifesto", async () => {
    const { fila, t, storage } = montar();
    fila.sincronizar();
    fila.adicionarArquivos(arquivos(3));
    t.envios[0]!.resolve({ mediaId: sha(1), deduplicado: false });
    await flush();
    expect(lerManifesto(storage).get("alpha")).toHaveLength(3);
    fila.limparConcluidos();
    expect(estados(fila)).toEqual(["enviando", "aguardando"]);
    expect(lerManifesto(storage).get("alpha")).toHaveLength(2);
    fila.remover(fila.instantanea().itens[1]!.chave);
    expect(lerManifesto(storage).get("alpha")).toHaveLength(1);
    expect(fila.instantanea().podeLimpar).toBe(false);
  });

  it("nada é gravado antes da restauração: o manifesto salvo sobrevive a arquivos adicionados antes do projeto", () => {
    const storage = storageEmMemoria();
    gravarManifesto(storage, "alpha", [entrada(1), entrada(2, "pendente")]);
    const salvo = storage.dados.get(MANIFESTO);
    storage.setItem.mockClear();
    const { fila, setFontes } = montar({ storage, shas: null });
    fila.adicionarArquivos(arquivos(3));
    fila.limparConcluidos();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.dados.get(MANIFESTO)).toBe(salvo);
    // Com o projeto, o salvo volta e os novos se somam a ele.
    setFontes(new Set([sha(1)]));
    fila.sincronizar();
    const chaves = lerManifesto(storage).get("alpha")!.map((item: { chave: string }) => item.chave);
    expect(chaves).toContain("k1");
    expect(chaves).toContain("k2");
    expect(chaves).toHaveLength(5);
  });

  it("arquivo inválido (tamanho 0, image/*) vira erro, não é enviado nem gravado", () => {
    const { fila, t, storage } = montar();
    fila.sincronizar();
    const novos = fila.adicionarArquivos([arquivo("vazio.mp4", 0), arquivo("foto.png", 5, "image/png"), arquivo("bom.mp4")]);
    expect(novos).toBe(1);
    const itens = fila.instantanea().itens;
    expect(itens.map((item) => item.estado)).toEqual(["erro", "erro", "enviando"]);
    expect(itens[0]!.mensagem).toBe("Arquivo vazio: escolha um vídeo ou um áudio.");
    expect(itens[1]!.mensagem).toBe("Não é vídeo nem áudio: escolha outro arquivo.");
    expect(itens[0]!.acoes).toEqual(["remover"]);
    expect(t.enviar).toHaveBeenCalledTimes(1);
    expect(t.envios[0]!.item.nome).toBe("bom.mp4");
    const gravados = lerManifesto(storage).get("alpha")!;
    expect(gravados.map((item: { nome: string }) => item.nome)).toEqual(["bom.mp4"]);
    // Tentar de novo num inválido não faz nada.
    fila.tentarDeNovo(itens[0]!.chave);
    expect(t.enviar).toHaveBeenCalledTimes(1);
  });

  it("motivoInvalido e mensagemDeErro cobrem os códigos conhecidos", () => {
    expect(motivoInvalido({ size: 1, type: "video/mp4" })).toBeNull();
    expect(motivoInvalido({ size: 1, type: "text/plain" })).toMatch(/Não é vídeo/);
    expect(mensagemDeErro({ status: 507 }, "equipe")).toMatch(/espaço/);
    expect(mensagemDeErro({ status: 404 }, "equipe")).toMatch(/expirou/);
    expect(mensagemDeErro({ status: 404 }, "local")).toBe("Não foi possível enviar este arquivo.");
    expect(mensagemDeErro({ status: 409 }, "local")).toMatch(/projeto mudou/);
    // Só o TypeError do fetch é queda de conexão; erro sem status usa a message.
    expect(mensagemDeErro(new TypeError("Failed to fetch"), "local")).toMatch(/recomeça do início/);
    expect(mensagemDeErro(new TypeError("Failed to fetch"), "equipe")).toMatch(/de onde parou/);
    expect(mensagemDeErro(new Error("o servidor encerrou"), "local")).toBe("o servidor encerrou");
    expect(mensagemDeErro({}, "local")).toBe("Não foi possível enviar este arquivo.");
    expect(mensagemDeErro(Object.assign(new Error("x"), { status: 409, dono: { nome: "Ana" } }), "equipe")).toBe(RESERVA_PERDIDA);
    expect(textoDoItem({ estado: "pronto", reuso: "projeto" }, { pausado: false, modo: "equipe" })).toBe("Já estava no projeto");
    expect(acoesDoItem({ estado: "enviando" })).toEqual(["remover"]);
  });
});

const pausarComMotivo = (fila: Fila, motivo: string) => fila.pausar({ motivo });
const pausaDoCliente = () => Object.assign(new Error("envio pausado"), { name: "UploadPausedError" });

describe("Reserva perdida, pausa atrasada e impressão repetida", () => {
  it("project/media com dono para a fila com o item pausado e o retomar só associa", async () => {
    const adicionar = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("reservado"), { status: 409, dono: { nome: "Ana" } }))
      .mockResolvedValueOnce({ sha256: sha(1), reaproveitada: false });
    const { fila, t } = montar({ adicionar });
    fila.sincronizar();
    fila.adicionarArquivos(arquivos(2));
    t.envios[0]!.resolve({ mediaId: sha(1), deduplicado: false });
    await flush();
    const visao = vista(fila);
    expect(visao.itens.map((item) => item.estado)).toEqual(["pausado", "aguardando"]);
    expect(visao.itens[0]!.mensagem).toBe(RESERVA_PERDIDA);
    expect(visao.pausado).toBe(true);
    expect(visao.resumo).toContain(RESERVA_PERDIDA);
    expect(t.enviar).toHaveBeenCalledTimes(1);
    fila.retomar();
    await flush();
    expect(adicionar).toHaveBeenCalledTimes(2);
    expect(adicionar).toHaveBeenLastCalledWith(sha(1));
    // Só associou: o primeiro não foi enviado de novo; o segundo é o que sobe agora.
    expect(t.enviar).toHaveBeenCalledTimes(2);
    expect(t.envios[1]!.item.nome).toBe("clipe-02.mp4");
    expect(estados(fila)).toEqual(["pronto", "enviando"]);
  });

  it("queda de conexão na associação também para a fila (TypeError)", async () => {
    const adicionar = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const { fila, t } = montar({ adicionar });
    fila.sincronizar();
    fila.adicionarArquivos(arquivos(2));
    t.envios[0]!.resolve({ mediaId: sha(1), deduplicado: false });
    await flush();
    expect(estados(fila)).toEqual(["pausado", "aguardando"]);
    expect(vista(fila).pausado).toBe(true);
  });

  it("pausar com motivo chama o pausar do transporte e a fila mostra o motivo", async () => {
    const { fila, t, config } = montar();
    fila.sincronizar();
    fila.adicionarArquivos(arquivos(2));
    pausarComMotivo(fila, RESERVA_PERDIDA);
    expect(config.pausar).toHaveBeenCalledTimes(1);
    t.envios[0]!.reject(pausaDoCliente());
    await flush();
    const visao = vista(fila) as ReturnType<typeof vista> & { motivoDaPausa: string };
    expect(visao.motivoDaPausa).toBe(RESERVA_PERDIDA);
    expect(visao.resumo).toContain(RESERVA_PERDIDA);
    expect(estados(fila)).toEqual(["pausado", "aguardando"]);
    expect(t.enviar).toHaveBeenCalledTimes(1);
    // Retomar limpa o motivo.
    fila.retomar();
    expect((vista(fila) as { motivoDaPausa: string | null }).motivoDaPausa).toBeNull();
  });

  it("pausar sem nada pendente é no-op e a escolha seguinte começa direto", () => {
    const { fila, t, config } = montar();
    fila.sincronizar();
    pausarComMotivo(fila, RESERVA_PERDIDA);
    expect(config.pausar).not.toHaveBeenCalled();
    expect(vista(fila).pausado).toBe(false);
    fila.adicionarArquivos(arquivos(1));
    expect(t.enviar).toHaveBeenCalledTimes(1);
    expect(estados(fila)).toEqual(["enviando"]);
  });

  it("UploadPausedError atrasado: pausar e retomar antes da rejeição devolve o item a aguardando e ele é reenviado primeiro", async () => {
    const { fila, t } = montar();
    fila.sincronizar();
    fila.adicionarArquivos(arquivos(3));
    fila.pausar();
    fila.retomar();
    // A rejeição só chega agora, assíncrona, como no POST de criação do cliente real.
    expect(estados(fila)).toEqual(["enviando", "aguardando", "aguardando"]);
    t.envios[0]!.reject(pausaDoCliente());
    await flush();
    expect(t.enviar).toHaveBeenCalledTimes(2);
    expect(t.envios[1]!.item.nome).toBe("clipe-01.mp4");
    expect(estados(fila)).toEqual(["enviando", "aguardando", "aguardando"]);
    expect(vista(fila).pausado).toBe(false);
    t.envios[1]!.resolve({ mediaId: sha(1), deduplicado: false });
    await flush();
    // Os outros não passaram na frente e nada ficou preso.
    expect(t.envios[2]!.item.nome).toBe("clipe-02.mp4");
    t.envios[2]!.resolve({ mediaId: sha(2), deduplicado: false });
    await flush();
    t.envios[3]!.resolve({ mediaId: sha(3), deduplicado: false });
    await flush();
    expect(estados(fila)).toEqual(["pronto", "pronto", "pronto"]);
  });

  it("com a fila ainda pausada, o UploadPausedError deixa o item pausado", async () => {
    const { fila, t } = montar();
    fila.sincronizar();
    fila.adicionarArquivos(arquivos(1));
    fila.pausar();
    t.envios[0]!.reject(pausaDoCliente());
    await flush();
    expect(estados(fila)).toEqual(["pausado"]);
  });

  it("mesma impressão na mesma escolha: duas linhas, a segunda em erro, um envio só", () => {
    const { fila, t, storage } = montar();
    fila.sincronizar();
    const a = arquivo("C0001.MP4", 10, "video/mp4", 5);
    const b = arquivo("C0001.MP4", 10, "video/mp4", 5);
    const novos = fila.adicionarArquivos([a, b]);
    const itens = fila.instantanea().itens;
    expect(novos).toBe(1);
    expect(itens.map((item) => item.estado)).toEqual(["enviando", "erro"]);
    expect(itens[1]!.mensagem).toBe(IMPRESSAO_REPETIDA);
    expect(itens[1]!.acoes).toEqual(["remover"]);
    expect(t.enviar).toHaveBeenCalledTimes(1);
    // A linha repetida não entra no manifesto.
    expect(lerManifesto(storage).get("alpha")).toHaveLength(1);
  });

  it("remover a linha repetida não chama cancelar e não mexe no original", () => {
    const { fila, t, config } = montar();
    fila.sincronizar();
    fila.adicionarArquivos([arquivo("C0001.MP4", 10, "video/mp4", 5), arquivo("C0001.MP4", 10, "video/mp4", 5)]);
    fila.remover(fila.instantanea().itens[1]!.chave);
    expect(config.cancelar).not.toHaveBeenCalled();
    expect(estados(fila)).toEqual(["enviando"]);
    expect(t.enviar).toHaveBeenCalledTimes(1);
  });

  it("mesma impressão de um item ainda aguardando de uma escolha anterior também é recusada", () => {
    const { fila, t } = montar();
    fila.sincronizar();
    fila.adicionarArquivos([arquivo("a.mp4", 10), arquivo("b.mp4", 11)]);
    expect(estados(fila)).toEqual(["enviando", "aguardando"]);
    const novos = fila.adicionarArquivos([arquivo("b.mp4", 11), arquivo("a.mp4", 10)]);
    expect(novos).toBe(0);
    const itens = fila.instantanea().itens;
    expect(itens.map((item) => item.estado)).toEqual(["enviando", "aguardando", "erro", "erro"]);
    expect(itens[2]!.mensagem).toBe(IMPRESSAO_REPETIDA);
    expect(itens[3]!.mensagem).toBe(IMPRESSAO_REPETIDA);
    expect(t.enviar).toHaveBeenCalledTimes(1);
  });

  it("concluído reconhecido na nova escolha diz que só a impressão casou", async () => {
    const { fila, t } = montar({ shas: new Set([sha(1)]) });
    fila.sincronizar();
    fila.adicionarArquivos([arquivo("a.mp4", 10)]);
    t.envios[0]!.resolve({ mediaId: sha(1), deduplicado: false });
    await flush();
    fila.adicionarArquivos([arquivo("a.mp4", 10)]);
    const item = fila.instantanea().itens[0]!;
    expect(item.reconhecido).toBe(true);
    expect(item.mensagem).toBe(IMPRESSAO_CONCLUIDA);
    expect(t.enviar).toHaveBeenCalledTimes(1);
  });

  it("erro sem status que não é de rede marca o item e a fila segue", async () => {
    const { fila, t } = montar();
    fila.sincronizar();
    fila.adicionarArquivos(arquivos(2));
    t.envios[0]!.reject(new Error("o servidor encerrou o envio sem mediaId"));
    await flush();
    const visao = vista(fila);
    expect(visao.itens[0]!.estado).toBe("erro");
    expect(visao.itens[0]!.mensagem).toBe("o servidor encerrou o envio sem mediaId");
    expect(visao.pausado).toBe(false);
    expect(visao.itens[1]!.estado).toBe("enviando");
    expect(t.enviar).toHaveBeenCalledTimes(2);
  });
});
