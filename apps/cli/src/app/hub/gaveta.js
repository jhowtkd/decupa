// Regras da gaveta Novo Projeto. Este módulo não toca o DOM: a página do hub
// desenha o que `criarGaveta` devolve e repassa os eventos. Assim a fila de
// envios, a retomada e as mensagens de erro são testadas no Node.

const NOME_MAXIMO = 200;

/** O nome vem do usuário: vazio ou só espaços não cria Projeto. */
export function validarNome(valor) {
  const nome = String(valor ?? "").trim();
  if (!nome) return { valido: false, mensagem: "Dê um nome ao Projeto." };
  if (nome.length > NOME_MAXIMO) return { valido: false, mensagem: `O nome pode ter até ${NOME_MAXIMO} caracteres.` };
  return { valido: true, nome };
}

/** Limpeza recebe exatamente uma Mídia; Montagem, uma ou mais. */
export function limitesDeMidias(fluxo) {
  return fluxo === "limpeza" ? { minimo: 1, maximo: 1 } : { minimo: 1, maximo: Infinity };
}

export function validarQuantidadeDeMidias(fluxo, quantidade) {
  const { minimo, maximo } = limitesDeMidias(fluxo);
  if (quantidade < minimo) {
    return fluxo === "limpeza"
      ? "Escolha uma Mídia para a Limpeza."
      : "Escolha pelo menos uma Mídia para a Montagem.";
  }
  if (quantidade > maximo) return `Limpeza aceita exatamente uma Mídia. Remova ${quantidade - maximo} para continuar.`;
  return null;
}

/** Recusa só o que nem precisa ir ao servidor: arquivo vazio, texto ou imagem.
 *  O resto quem decide é o servidor, que lê o arquivo de verdade (422). */
export function validarArquivo(arquivo) {
  if (!arquivo?.size) return "Mídia inválida: o arquivo está vazio.";
  if (/^(image|text)\//.test(arquivo.type || "")) return "Mídia inválida: escolha um vídeo ou um áudio.";
  return null;
}

/** Corpo de `POST /project/new`: o Fluxo e os ids do acervo que o Projeto já leva. */
export function corpoDaCriacao({ nome, fluxo, midias }) {
  return { nome, fluxo, midias: [...midias] };
}

/** O link do Drive só precisa vir preenchido: quem valida de verdade é o servidor. */
export function validarDriveUrl(valor) {
  const url = String(valor ?? "").trim();
  if (!url) return { valido: false, mensagem: "Cole o link do arquivo no Google Drive." };
  return { valido: true, url };
}

/** Erro de envio → texto. Sem status, a requisição nem chegou: a conexão caiu e
 *  a retomada volta do offset salvo no navegador. No Drive, quem baixa é a VPS:
 *  as mensagens falam de importação e reaproveitam o texto do servidor. */
export function mensagemDeErroDeEnvio(erro, origem = "envio") {
  const status = erro?.status;
  if (origem === "drive") {
    if (status === undefined) return "Conexão com a VPS interrompida. Tente de novo para acompanhar a importação.";
    if (status === 503) return "A importação do Drive não está configurada na VPS.";
    if (status === 404) return "Arquivo não encontrado no Drive ou sem link público.";
    if (status === 403) return "O Google recusou o acesso (cota ou permissão). Tente mais tarde.";
    if (status === 413) return "Esta Mídia passa do tamanho máximo permitido.";
    if (status === 507) return "Não há espaço suficiente no volume de Mídias. Libere espaço e tente de novo.";
    return erro?.message || "Não foi possível importar do Drive.";
  }
  if (status === undefined) return "Conexão interrompida. Tente de novo para retomar o envio.";
  if (status === 413) return "Esta Mídia passa do tamanho máximo permitido.";
  if (status === 507) return "Não há espaço suficiente no volume de Mídias. Libere espaço e tente de novo.";
  if (status === 400 || status === 422) return "Mídia inválida: escolha outro arquivo de vídeo ou áudio.";
  if (status === 404) return "O envio expirou no servidor. Tente de novo para enviar do começo.";
  return erro?.message || "Não foi possível enviar esta Mídia.";
}

/** Erro de `POST /project/new` → texto. O 400 já vem em português e diz o que faltou. */
export function mensagemDeErroDeCriacao(erro) {
  const status = erro?.status;
  if (status === undefined) return "Sem conexão com o servidor. Tente criar o Projeto de novo.";
  if (status === 400) return erro.message || "Confira o nome, o Fluxo e as Mídias.";
  if (status === 401) return "Sua sessão expirou. Entre de novo para criar o Projeto.";
  if (status === 404) return "Uma das Mídias não está mais no acervo. Remova-a e escolha outra.";
  if (status === 503) return "O acervo de Mídias está indisponível agora. Tente de novo em instantes.";
  return "Não foi possível criar o Projeto. Tente de novo.";
}

/** Texto de estado de uma Mídia na fila. */
const ENVIO_PAUSADO = "O envio está pausado. Retome o envio ou remova as Mídias pendentes para criar o Projeto.";

export function textoDoItem(item, pausado) {
  if (item.estado === "aguardando") return pausado ? "Aguardando · fila pausada" : "Aguardando";
  if (item.estado === "enviando") {
    if (item.origem === "drive") return `Importando · ${Math.round(item.percent || 0)}%`;
    if (item.fase === "importing") return "Importando";
    return item.fase === "verifying" ? "Verificando" : `Enviando · ${Math.round(item.percent || 0)}%`;
  }
  if (item.estado === "pausado") return "Pausado";
  if (item.estado === "erro") return "Falhou";
  if (item.origem === "acervo") return "Do acervo";
  return item.deduplicado ? "Pronto · Mídia reaproveitada" : "Pronto";
}

/** Frase do rodapé: o que a gaveta está fazendo agora. */
export function textoDoResumo(visao) {
  if (visao.criando) return "Criando o Projeto…";
  if (visao.criacaoAgendada) return "O Projeto será criado quando os envios terminarem.";
  if (visao.itens.length === 0) return "";
  const prontas = visao.itens.filter((item) => item.estado === "pronto").length;
  const total = visao.itens.length;
  const contagem = `${prontas} de ${total} ${total === 1 ? "Mídia pronta" : "Mídias prontas"}`;
  if (visao.emAndamento) return `${contagem} · enviando`;
  return visao.podeRetomar ? `${contagem} · envio pausado` : contagem;
}

/** Duração do acervo em segundos → m:ss, ou h:mm:ss a partir de uma hora. */
export function formatarDuracao(segundos) {
  const total = Math.max(0, Math.round(Number(segundos) || 0));
  const horas = Math.floor(total / 3600);
  const minutos = Math.floor((total % 3600) / 60);
  const segundosDoMinuto = String(total % 60).padStart(2, "0");
  return horas > 0
    ? `${horas}:${String(minutos).padStart(2, "0")}:${segundosDoMinuto}`
    : `${minutos}:${segundosDoMinuto}`;
}

/**
 * Estado da gaveta: nome, Fluxo e a fila de Mídias. Os envios andam um por vez,
 * na ordem em que foram escolhidos: a Mídia seguinte só começa quando a anterior
 * termina, para o progresso mostrar uma coisa de cada vez. `criarEnvio` recebe
 * `{ onProgress }` e devolve um cliente de upload retomável; `enviarCriacao`
 * faz o `POST /project/new` com as Mídias prontas.
 */
/**
 * @param {object} config
 * @param {any} config.criarEnvio
 * @param {any} [config.criarImportacaoDrive]
 * @param {any} [config.expandirPasta]
 * @param {any} config.chaveDoArquivo
 * @param {any} config.enviarCriacao
 * @param {any} config.onCriado
 * @param {any} config.onChange
 * @param {any} [config.onMidiaPublicada]
 */
export function criarGaveta({
  criarEnvio, criarImportacaoDrive, expandirPasta = async () => ({ tipo: "arquivo" }),
  chaveDoArquivo, enviarCriacao, onCriado, onChange, onMidiaPublicada = () => {},
}) {
  let nome = "";
  let fluxo = "montagem";
  let itens = [];
  let sequencia = 0;
  let ativo = null;
  let pausado = false;
  let criacaoAgendada = false;
  let criando = false;
  let erro = null;

  function novoItem(campos) {
    sequencia += 1;
    return {
      chave: `m${sequencia}`, nome: "", origem: "envio", estado: "aguardando",
      arquivo: null, alvo: null, assinatura: null, envio: null, mediaId: null, deduplicado: false,
      fase: null, mensagem: null, percent: 0, removido: false, ...campos,
    };
  }

  function encontrar(chave) {
    return itens.find((item) => item.chave === chave);
  }

  function emAndamento() {
    return itens.some((item) => item.estado === "enviando");
  }

  function instantanea() {
    return {
      nome,
      fluxo,
      pausado,
      emAndamento: emAndamento(),
      podeRetomar: pausado && itens.some((item) => item.estado === "aguardando" || item.estado === "pausado"),
      criando,
      criacaoAgendada,
      erro,
      midiaIds: itens.map((item) => item.mediaId).filter(Boolean),
      itens: itens.map((item) => ({
        chave: item.chave, nome: item.nome, origem: item.origem, estado: item.estado, mediaId: item.mediaId,
        percent: item.percent, mensagem: item.mensagem, texto: textoDoItem(item, pausado),
      })),
    };
  }

  function notificar() {
    onChange(instantanea());
  }

  function definirErro(campo, mensagem) {
    erro = mensagem ? { campo, mensagem } : null;
    notificar();
  }

  function progredir(item, valor) {
    if (item.removido) return;
    item.percent = Math.round(Number(valor.percent) || 0);
    item.fase = valor.state;
    // O nome do Drive só chega depois do POST: o item entra com o link.
    if (typeof valor.nome === "string" && valor.nome !== "") item.nome = valor.nome;
    notificar();
  }

  function iniciar(item) {
    ativo = item;
    Object.assign(item, { estado: "enviando", mensagem: null, fase: null });
    let envio;
    try {
      envio = Promise.resolve(item.envio.start(item.alvo ?? item.arquivo));
    } catch (error) {
      envio = Promise.reject(error);
    }
    envio.then(
      (resultado) => concluir(item, resultado),
      (error) => falhar(item, error),
    );
  }

  function concluir(item, resultado) {
    if (item.removido) return;
    if (ativo === item) ativo = null;
    const repetida = itens.some((outro) => outro !== item && outro.mediaId === resultado.mediaId);
    if (repetida) {
      // O acervo é por conteúdo: o mesmo arquivo com outro nome devolve o mesmo id.
      // Manter as duas entradas faria o Fluxo Limpeza recusar uma Mídia só.
      itens = itens.filter((outro) => outro !== item);
      erro = { campo: "aviso", mensagem: "Esta Mídia já estava no Projeto; o envio repetido foi descartado." };
    } else {
      Object.assign(item, { estado: "pronto", mediaId: resultado.mediaId, deduplicado: Boolean(resultado.deduplicado), percent: 100 });
      onMidiaPublicada();
    }
    proximo();
    notificar();
  }

  function falhar(item, error) {
    if (item.removido) return;
    if (ativo === item) ativo = null;
    if (error?.name === "UploadPausedError") {
      item.estado = "pausado";
    } else {
      item.estado = "erro";
      item.mensagem = mensagemDeErroDeEnvio(error, item.origem);
      erro = { campo: "aviso", mensagem: item.mensagem };
    }
    proximo();
    notificar();
  }

  // Único ponto que inicia envios: respeita a pausa e a fila de um por vez.
  function proximo() {
    if (!pausado && !ativo) {
      const seguinte = itens.find((item) => item.estado === "aguardando" || item.estado === "pausado");
      if (seguinte) iniciar(seguinte);
    }
    verificarCriacao();
  }

  function verificarCriacao() {
    if (!criacaoAgendada) return;
    const quantidade = validarQuantidadeDeMidias(fluxo, itens.length);
    if (quantidade) {
      criacaoAgendada = false;
      erro = { campo: "aviso", mensagem: quantidade };
      return;
    }
    if (itens.some((item) => item.estado === "erro")) {
      criacaoAgendada = false;
      erro = { campo: "aviso", mensagem: "Um envio falhou. Tente de novo ou remova a Mídia para criar o Projeto." };
      return;
    }
    if (itens.every((item) => item.estado === "pronto")) void criarAgora();
  }

  async function criarAgora() {
    criacaoAgendada = false;
    const validado = validarNome(nome);
    if (!validado.valido) {
      definirErro("nome", validado.mensagem);
      return;
    }
    criando = true;
    erro = null;
    notificar();
    try {
      const resposta = await enviarCriacao(corpoDaCriacao({
        nome: validado.nome, fluxo, midias: itens.map((item) => item.mediaId),
      }));
      onCriado(resposta.url);
    } catch (error) {
      criando = false;
      definirErro("aviso", mensagemDeErroDeCriacao(error));
    }
  }

  function adicionarArquivos(arquivos) {
    erro = null;
    for (const arquivo of arquivos) {
      const motivo = validarArquivo(arquivo);
      if (motivo) {
        erro = { campo: "aviso", mensagem: motivo };
        continue;
      }
      const assinatura = chaveDoArquivo(arquivo);
      if (itens.some((item) => item.assinatura === assinatura)) {
        erro = { campo: "aviso", mensagem: "Esta Mídia já está na lista." };
        continue;
      }
      const quantidade = validarQuantidadeDeMidias(fluxo, itens.length + 1);
      if (quantidade) {
        erro = { campo: "aviso", mensagem: quantidade };
        continue;
      }
      const item = novoItem({ nome: arquivo.name, arquivo, assinatura });
      item.envio = criarEnvio({ onProgress: (valor) => progredir(item, valor) });
      itens.push(item);
    }
    proximo();
    notificar();
  }

  async function adicionarDriveUrl(valor) {
    erro = null;
    const validado = validarDriveUrl(valor);
    if (!validado.valido) {
      erro = { campo: "aviso", mensagem: validado.mensagem };
      notificar();
      return;
    }
    if (!criarImportacaoDrive) {
      erro = { campo: "aviso", mensagem: "A importação do Drive não está disponível." };
      notificar();
      return;
    }
    let expansao;
    try {
      expansao = await expandirPasta(validado.url);
    } catch (error) {
      erro = { campo: "aviso", mensagem: mensagemDeErroDeEnvio(error, "drive") };
      notificar();
      return;
    }
    const alvos = expansao?.tipo === "pasta" && Array.isArray(expansao.items)
      ? expansao.items
        .filter((item) => item && typeof item.fileId === "string" && item.fileId !== "")
        .map((item) => ({
          url: `https://drive.google.com/file/d/${item.fileId}/view`,
          nome: typeof item.nome === "string" && item.nome !== "" ? item.nome : null,
        }))
      : [{ url: validado.url, nome: null }];
    if (alvos.length === 0) {
      erro = { campo: "aviso", mensagem: "Nenhum vídeo ou áudio na pasta do Drive." };
      notificar();
      return;
    }
    const ignorados = expansao?.tipo === "pasta" ? Number(expansao.ignorados) || 0 : 0;
    let adicionados = 0;
    for (const alvo of alvos) {
      const assinatura = `drive\0${alvo.url}`;
      if (itens.some((item) => item.assinatura === assinatura)) continue;
      const quantidade = validarQuantidadeDeMidias(fluxo, itens.length + 1);
      if (quantidade) {
        erro = { campo: "aviso", mensagem: quantidade };
        break;
      }
      const item = novoItem({ nome: alvo.nome ?? alvo.url, origem: "drive", alvo: alvo.url, assinatura });
      item.envio = criarImportacaoDrive({ onProgress: (valor) => progredir(item, valor) });
      itens.push(item);
      adicionados += 1;
    }
    if (adicionados === 0 && !erro) {
      erro = { campo: "aviso", mensagem: alvos.length > 1 ? "Estas Mídias já estão na lista." : "Esta Mídia já está na lista." };
    } else if (ignorados > 0 && !erro) {
      erro = {
        campo: "aviso",
        mensagem: `${ignorados} ${ignorados === 1 ? "item ignorado" : "itens ignorados"}: não são vídeo ou áudio.`,
      };
    }
    proximo();
    notificar();
  }

  function adicionarDoAcervo(midia) {
    erro = null;
    if (itens.some((item) => item.mediaId === midia.id)) {
      definirErro("aviso", "Esta Mídia já está no Projeto.");
      return;
    }
    const quantidade = validarQuantidadeDeMidias(fluxo, itens.length + 1);
    if (quantidade) {
      definirErro("aviso", quantidade);
      return;
    }
    itens.push(novoItem({ nome: midia.nome, origem: "acervo", estado: "pronto", mediaId: midia.id, percent: 100 }));
    proximo();
    notificar();
  }

  function remover(chave) {
    const item = encontrar(chave);
    if (!item) return;
    item.removido = true;
    if (ativo === item) ativo = null;
    // Cancela no servidor o envio parcial; uma Mídia já pronta fica no acervo.
    if (item.envio && item.estado !== "pronto") void Promise.resolve(item.envio.cancel(item.alvo ?? item.arquivo)).catch(() => {});
    itens = itens.filter((outro) => outro !== item);
    erro = null;
    proximo();
    notificar();
  }

  function tentarDeNovo(chave) {
    const item = encontrar(chave);
    if (!item || item.estado !== "erro") return;
    Object.assign(item, { estado: "aguardando", mensagem: null });
    erro = null;
    proximo();
    notificar();
  }

  function pausar() {
    pausado = true;
    // Pausar depois de pedir a criação desiste dela, pelo mesmo motivo de `criar`.
    if (criacaoAgendada) {
      criacaoAgendada = false;
      erro = { campo: "aviso", mensagem: ENVIO_PAUSADO };
    }
    ativo?.envio.pause();
    notificar();
  }

  function retomar() {
    pausado = false;
    proximo();
    notificar();
  }

  function criar() {
    if (criando) return;
    const validado = validarNome(nome);
    if (!validado.valido) {
      definirErro("nome", validado.mensagem);
      return;
    }
    const quantidade = validarQuantidadeDeMidias(fluxo, itens.length);
    if (quantidade) {
      definirErro("aviso", quantidade);
      return;
    }
    if (itens.some((item) => item.estado === "erro")) {
      definirErro("aviso", "Um envio falhou. Tente de novo ou remova a Mídia para criar o Projeto.");
      return;
    }
    // Pausado não termina sozinho: agendar prometeria um Projeto que nunca chega.
    if (pausado && itens.some((item) => item.estado === "aguardando" || item.estado === "pausado")) {
      definirErro("aviso", ENVIO_PAUSADO);
      return;
    }
    erro = null;
    // Com envios ainda correndo, a criação espera as Mídias: o usuário não precisa voltar.
    criacaoAgendada = true;
    verificarCriacao();
    notificar();
  }

  // Fechar a gaveta pausa os envios (a retomada volta do offset salvo) e
  // desiste de uma criação agendada: o usuário não quer um Projeto que ele já fechou.
  function fechar() {
    criacaoAgendada = false;
    if (itens.some((item) => item.estado === "enviando" || item.estado === "aguardando")) pausar();
    else notificar();
  }

  function definirNome(valor) {
    nome = String(valor ?? "");
    if (erro?.campo === "nome") erro = null;
    notificar();
  }

  function definirFluxo(valor) {
    fluxo = valor === "limpeza" ? "limpeza" : "montagem";
    notificar();
  }

  return {
    instantanea,
    definirNome,
    definirFluxo,
    adicionarArquivos,
    adicionarDriveUrl,
    adicionarDoAcervo,
    remover,
    tentarDeNovo,
    pausar,
    retomar,
    criar,
    fechar,
  };
}
