import { describe, expect, it } from "vitest";
import {
  corpoDaCriacao, criarGaveta, formatarDuracao, limitesDeMidias, mensagemDeErroDeCriacao,
  mensagemDeErroDeEnvio, textoDoItem, textoDoResumo, validarArquivo, validarNome, validarQuantidadeDeMidias,
} from "./gaveta.js";

/** Cliente de upload falso: a fila segura o `start` até o teste decidir o desfecho. */
class EnvioFalso {
  starts = 0;
  pauses = 0;
  cancels = 0;
  arquivo: { name: string } | null = null;
  onProgress: (valor: { percent: number; state: string }) => void = () => {};
  private pendente: { resolve(valor: unknown): void; reject(erro: unknown): void } | null = null;

  start(arquivo: { name: string }) {
    this.arquivo = arquivo;
    this.starts += 1;
    return new Promise((resolve, reject) => { this.pendente = { resolve, reject }; });
  }

  pause() {
    this.pauses += 1;
    this.interromper();
  }

  cancel() {
    this.cancels += 1;
    this.interromper();
    return Promise.resolve();
  }

  concluir(mediaId: string, deduplicado = false) {
    this.pendente?.resolve({ mediaId, deduplicado });
    this.pendente = null;
  }

  falhar(erro: unknown) {
    this.pendente?.reject(erro);
    this.pendente = null;
  }

  private interromper() {
    this.pendente?.reject(Object.assign(new Error("envio pausado"), { name: "UploadPausedError" }));
    this.pendente = null;
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function arquivo(nome: string, tamanho = 10, tipo = "video/mp4") {
  return { name: nome, size: tamanho, type: tipo, lastModified: 1 };
}

function montarGaveta(enviarCriacao: (corpo: unknown) => Promise<{ url: string }> = async () => ({ url: "/projects/novo-abcd/" })) {
  const envios: EnvioFalso[] = [];
  const criacoes: unknown[] = [];
  const criados: string[] = [];
  const midiasPublicadas: number[] = [];
  const gaveta = criarGaveta({
    criarEnvio: ({ onProgress }: { onProgress: (valor: { percent: number; state: string }) => void }) => {
      const envio = new EnvioFalso();
      envio.onProgress = onProgress;
      envios.push(envio);
      return envio;
    },
    chaveDoArquivo: (arquivoDaGaveta: { name: string; size: number }) => `${arquivoDaGaveta.name}:${arquivoDaGaveta.size}`,
    enviarCriacao: async (corpo: unknown) => {
      criacoes.push(corpo);
      return enviarCriacao(corpo);
    },
    onCriado: (url: string) => { criados.push(url); },
    onChange: () => {},
    onMidiaPublicada: () => { midiasPublicadas.push(1); },
  });
  return { gaveta, envios, criacoes, criados, midiasPublicadas };
}

describe("regras da gaveta", () => {
  it("nome vazio não cria Projeto e vale o nome aparado", () => {
    expect(validarNome("   ")).toEqual({ valido: false, mensagem: "Dê um nome ao Projeto." });
    expect(validarNome("  Podcast Ep. 14 ")).toEqual({ valido: true, nome: "Podcast Ep. 14" });
  });

  it("recusa nome acima de 200 caracteres", () => {
    expect(validarNome("a".repeat(200))).toMatchObject({ valido: true });
    expect(validarNome("a".repeat(201))).toMatchObject({ valido: false });
  });

  it("Limpeza aceita exatamente uma Mídia e Montagem uma ou mais", () => {
    expect(limitesDeMidias("limpeza")).toEqual({ minimo: 1, maximo: 1 });
    expect(limitesDeMidias("montagem")).toEqual({ minimo: 1, maximo: Infinity });
    expect(validarQuantidadeDeMidias("limpeza", 1)).toBeNull();
    expect(validarQuantidadeDeMidias("limpeza", 0)).toBe("Escolha uma Mídia para a Limpeza.");
    expect(validarQuantidadeDeMidias("limpeza", 2)).toBe("Limpeza aceita exatamente uma Mídia. Remova 1 para continuar.");
    expect(validarQuantidadeDeMidias("montagem", 0)).toBe("Escolha pelo menos uma Mídia para a Montagem.");
    expect(validarQuantidadeDeMidias("montagem", 7)).toBeNull();
  });

  it("recusa arquivo vazio, imagem e texto antes de mandar bytes ao servidor", () => {
    expect(validarArquivo({ name: "vazio.mp4", size: 0, type: "video/mp4" })).toBe("Mídia inválida: o arquivo está vazio.");
    expect(validarArquivo({ name: "foto.png", size: 10, type: "image/png" })).toMatch(/^Mídia inválida/);
    expect(validarArquivo({ name: "notas.txt", size: 10, type: "text/plain" })).toMatch(/^Mídia inválida/);
    expect(validarArquivo({ name: "aula.mkv", size: 10, type: "" })).toBeNull();
  });

  it("o corpo da criação leva nome, Fluxo e os ids do acervo", () => {
    expect(corpoDaCriacao({ nome: "Aula", fluxo: "montagem", midias: ["a".repeat(64)] })).toEqual({
      nome: "Aula", fluxo: "montagem", midias: ["a".repeat(64)],
    });
  });

  it("erros HTTP do envio viram mensagens claras", () => {
    expect(mensagemDeErroDeEnvio({ status: 413 })).toMatch(/tamanho máximo/);
    expect(mensagemDeErroDeEnvio({ status: 507 })).toMatch(/Não há espaço/);
    expect(mensagemDeErroDeEnvio({ status: 400 })).toMatch(/^Mídia inválida/);
    expect(mensagemDeErroDeEnvio({ status: 422 })).toMatch(/^Mídia inválida/);
    expect(mensagemDeErroDeEnvio(new TypeError("Failed to fetch"))).toMatch(/Conexão interrompida/);
    expect(mensagemDeErroDeEnvio({ status: 500, message: "falha interna" })).toBe("falha interna");
  });

  it("erros de criação: o 400 mostra o motivo do servidor e os outros têm texto próprio", () => {
    expect(mensagemDeErroDeCriacao(Object.assign(new Error("nome precisa ser um texto não vazio"), { status: 400 })))
      .toBe("nome precisa ser um texto não vazio");
    expect(mensagemDeErroDeCriacao(Object.assign(new Error("x"), { status: 401 }))).toMatch(/sessão expirou/);
    expect(mensagemDeErroDeCriacao(Object.assign(new Error("x"), { status: 503 }))).toMatch(/indisponível/);
    expect(mensagemDeErroDeCriacao(new TypeError("Failed to fetch"))).toMatch(/Sem conexão/);
  });

  it("explica o estado de cada Mídia e o do rodapé", () => {
    expect(textoDoItem({ estado: "enviando", percent: 42.4, origem: "envio" }, false)).toBe("Enviando · 42%");
    expect(textoDoItem({ estado: "aguardando", origem: "envio" }, true)).toBe("Aguardando · fila pausada");
    expect(textoDoItem({ estado: "pronto", origem: "acervo" }, false)).toBe("Do acervo");
    expect(textoDoItem({ estado: "pronto", origem: "envio", deduplicado: true }, false)).toBe("Pronto · Mídia reaproveitada");
    expect(textoDoResumo({
      criando: false, criacaoAgendada: false, emAndamento: true, podeRetomar: false,
      itens: [{ estado: "pronto" }, { estado: "enviando" }],
    })).toBe("1 de 2 Mídias prontas · enviando");
  });

  it("formata a duração do acervo", () => {
    expect(formatarDuracao(0)).toBe("0:00");
    expect(formatarDuracao(75.4)).toBe("1:15");
    expect(formatarDuracao(3725)).toBe("1:02:05");
  });
});

describe("fila de envios da gaveta", () => {
  it("envia uma Mídia por vez e só começa a seguinte quando a anterior termina", async () => {
    const { gaveta, envios, midiasPublicadas } = montarGaveta();
    gaveta.adicionarArquivos([arquivo("a.mp4"), arquivo("b.mp4")]);
    expect(envios[0]!.starts).toBe(1);
    expect(envios[1]!.starts).toBe(0);
    envios[0]!.concluir("a".repeat(64));
    await flush();
    expect(envios[1]!.starts).toBe(1);
    expect(midiasPublicadas).toHaveLength(1);
  });

  it("Limpeza recusa a segunda Mídia e explica o limite", () => {
    const { gaveta, envios } = montarGaveta();
    gaveta.definirFluxo("limpeza");
    gaveta.adicionarArquivos([arquivo("a.mp4"), arquivo("b.mp4")]);
    expect(gaveta.instantanea().itens).toHaveLength(1);
    expect(gaveta.instantanea().erro).toEqual({
      campo: "aviso", mensagem: "Limpeza aceita exatamente uma Mídia. Remova 1 para continuar.",
    });
    expect(envios).toHaveLength(1);
  });

  it("criar com Mídia pronta chama a criação com os ids e entrega a URL do Projeto", async () => {
    const { gaveta, envios, criacoes, criados } = montarGaveta();
    gaveta.definirFluxo("limpeza");
    gaveta.definirNome("  Aula de Física ");
    gaveta.adicionarArquivos([arquivo("aula.mp4")]);
    envios[0]!.concluir("b".repeat(64));
    await flush();
    gaveta.criar();
    await flush();
    expect(criacoes).toEqual([{ nome: "Aula de Física", fluxo: "limpeza", midias: ["b".repeat(64)] }]);
    expect(criados).toEqual(["/projects/novo-abcd/"]);
  });

  it("criar com envio em andamento agenda a criação e a faz sozinha quando as Mídias ficam prontas", async () => {
    const { gaveta, envios, criacoes } = montarGaveta();
    gaveta.definirNome("Podcast");
    gaveta.adicionarArquivos([arquivo("a.mp4")]);
    gaveta.criar();
    expect(gaveta.instantanea().criacaoAgendada).toBe(true);
    expect(criacoes).toHaveLength(0);
    envios[0]!.concluir("c".repeat(64));
    await flush();
    expect(criacoes).toEqual([{ nome: "Podcast", fluxo: "montagem", midias: ["c".repeat(64)] }]);
  });

  it("nome vazio não chama a criação e aponta o campo do nome", async () => {
    const { gaveta, criacoes } = montarGaveta();
    gaveta.adicionarDoAcervo({ id: "d".repeat(64), nome: "aula.mp4" });
    gaveta.criar();
    await flush();
    expect(gaveta.instantanea().erro).toEqual({ campo: "nome", mensagem: "Dê um nome ao Projeto." });
    expect(criacoes).toHaveLength(0);
  });

  it("pausar interrompe o envio e retomar continua o mesmo arquivo", async () => {
    const { gaveta, envios } = montarGaveta();
    gaveta.adicionarArquivos([arquivo("a.mp4")]);
    gaveta.pausar();
    await flush();
    expect(envios[0]!.pauses).toBe(1);
    expect(gaveta.instantanea().itens[0]).toMatchObject({ estado: "pausado" });
    expect(gaveta.instantanea().podeRetomar).toBe(true);
    gaveta.retomar();
    expect(envios[0]!.starts).toBe(2);
    envios[0]!.concluir("e".repeat(64));
    await flush();
    expect(gaveta.instantanea().itens[0]).toMatchObject({ estado: "pronto", mediaId: "e".repeat(64) });
  });

  it("fechar a gaveta durante envio pausa a fila e desiste da criação agendada", async () => {
    const { gaveta, envios, criacoes } = montarGaveta();
    gaveta.definirNome("Podcast");
    gaveta.adicionarArquivos([arquivo("a.mp4")]);
    gaveta.criar();
    gaveta.fechar();
    await flush();
    expect(envios[0]!.pauses).toBe(1);
    expect(gaveta.instantanea()).toMatchObject({ pausado: true, criacaoAgendada: false });
    expect(criacoes).toHaveLength(0);
  });

  it("erro de envio fica visível, bloqueia a criação e volta com Tentar de novo", async () => {
    const { gaveta, envios, criacoes } = montarGaveta();
    gaveta.definirNome("Podcast");
    gaveta.adicionarArquivos([arquivo("a.mp4")]);
    envios[0]!.falhar(Object.assign(new Error("sem espaço"), { status: 507 }));
    await flush();
    const item = gaveta.instantanea().itens[0]!;
    expect(item).toMatchObject({ estado: "erro" });
    expect(gaveta.instantanea().erro?.mensagem).toMatch(/Não há espaço/);
    gaveta.criar();
    expect(criacoes).toHaveLength(0);
    expect(gaveta.instantanea().erro?.mensagem).toMatch(/Um envio falhou/);
    gaveta.tentarDeNovo(item.chave);
    expect(envios[0]!.starts).toBe(2);
    envios[0]!.concluir("f".repeat(64));
    await flush();
    gaveta.criar();
    await flush();
    expect(criacoes).toEqual([{ nome: "Podcast", fluxo: "montagem", midias: ["f".repeat(64)] }]);
  });

  it("remover um envio em andamento cancela o upload e a fila segue", async () => {
    const { gaveta, envios } = montarGaveta();
    gaveta.adicionarArquivos([arquivo("a.mp4"), arquivo("b.mp4")]);
    gaveta.remover(gaveta.instantanea().itens[0]!.chave);
    await flush();
    expect(envios[0]!.cancels).toBe(1);
    expect(envios[1]!.starts).toBe(1);
    expect(gaveta.instantanea().itens.map((item) => item.nome)).toEqual(["b.mp4"]);
  });

  it("a mesma Mídia do acervo não entra duas vezes", () => {
    const { gaveta } = montarGaveta();
    gaveta.adicionarDoAcervo({ id: "1".repeat(64), nome: "aula.mp4" });
    gaveta.adicionarDoAcervo({ id: "1".repeat(64), nome: "aula.mp4" });
    expect(gaveta.instantanea().itens).toHaveLength(1);
    expect(gaveta.instantanea().erro?.mensagem).toBe("Esta Mídia já está no Projeto.");
  });

  it("um envio que devolve Mídia já na lista descarta a repetição", async () => {
    const { gaveta, envios } = montarGaveta();
    gaveta.adicionarArquivos([arquivo("a.mp4"), arquivo("copia.mp4")]);
    envios[0]!.concluir("2".repeat(64));
    await flush();
    envios[1]!.concluir("2".repeat(64));
    await flush();
    expect(gaveta.instantanea().itens).toHaveLength(1);
    expect(gaveta.instantanea().erro?.mensagem).toMatch(/já estava no Projeto/);
  });

  it("recusa de criação pelo servidor mostra o motivo e libera nova tentativa", async () => {
    const { gaveta, criacoes } = montarGaveta(async () => {
      throw Object.assign(new Error("Limpeza precisa de exatamente uma Mídia"), { status: 400 });
    });
    gaveta.definirNome("Podcast");
    gaveta.adicionarDoAcervo({ id: "3".repeat(64), nome: "aula.mp4" });
    gaveta.criar();
    await flush();
    expect(gaveta.instantanea()).toMatchObject({
      criando: false, erro: { campo: "aviso", mensagem: "Limpeza precisa de exatamente uma Mídia" },
    });
    expect(criacoes).toHaveLength(1);
  });
});
