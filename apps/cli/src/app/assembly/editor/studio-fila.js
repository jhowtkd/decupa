// Fila de Materiais do studio (DECUPA_EDITOR_UI=studio). Este módulo não toca
// o DOM: studio-materiais.js desenha o que `criarFila` devolve e entrega os
// transportes de hoje (ResumableMediaUpload + project/media no modo equipe,
// POST project/import no local). Todo arquivo escolhido entra na fila na hora,
// com o estado real; o envio anda um por vez, na ordem da escolha.
//
// O `File` não sobrevive a uma recarga. O manifesto (decupa.materiais.v1, por
// projeto) guarda o que a fila precisa para, depois de recarregar, mostrar o
// que concluiu, o que ficou parcial e o que nunca começou, e para reconhecer
// na nova seleção o que já está no projeto. Ele não substitui o
// decupa.uploads.v1 do media-upload.js, que segue dono da retomada dos bytes.

export const MANIFESTO = "decupa.materiais.v1";
/** Teto de entradas por projeto: concluídos mais antigos saem primeiro. */
export const MAX_ITENS = 200;
const MAX_PROJETOS = 30;
const SHA = /^[0-9a-f]{64}$/;
const ESTADOS_GRAVADOS = new Set(["pendente", "enviado", "concluido"]);

function entradaValida(entrada) {
  if (!entrada || typeof entrada !== "object") return null;
  const { chave, nome, tamanho, ultimaModificacao, estado, sha256, mediaId } = entrada;
  if (typeof chave !== "string" || !chave || typeof nome !== "string") return null;
  if (!Number.isFinite(tamanho) || tamanho < 0 || !ESTADOS_GRAVADOS.has(estado)) return null;
  if (estado === "concluido" && !(typeof sha256 === "string" && SHA.test(sha256))) return null;
  if (estado === "enviado" && !(typeof mediaId === "string" && SHA.test(mediaId))) return null;
  return {
    chave, nome, tamanho, ultimaModificacao: Number.isFinite(ultimaModificacao) ? ultimaModificacao : 0, estado,
    ...(estado === "concluido" ? { sha256 } : {}), ...(estado === "enviado" ? { mediaId } : {}),
  };
}

/** Manifesto (puro sobre o storage): ausente, ilegível ou corrompido vira vazio. */
export function lerManifesto(storage) {
  let data = null;
  try {
    const raw = storage?.getItem(MANIFESTO);
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }
  const projetos = new Map();
  if (data?.projetos && typeof data.projetos === "object" && !Array.isArray(data.projetos)) {
    for (const [projeto, itens] of Object.entries(data.projetos)) {
      if (!Array.isArray(itens)) continue;
      const validos = itens.map(entradaValida).filter(Boolean);
      if (validos.length) projetos.set(projeto, validos);
    }
  }
  return projetos;
}

/** Concluídos mais antigos saem primeiro; só então, se ainda passar, os pendentes mais antigos. */
export function aparar(itens, maximo = MAX_ITENS) {
  let lista = [...itens];
  while (lista.length > maximo) {
    const concluido = lista.findIndex((item) => item.estado === "concluido");
    if (concluido < 0) break;
    lista.splice(concluido, 1);
  }
  return lista.length > maximo ? lista.slice(-maximo) : lista;
}

/**
 * Grava as entradas de um projeto só. Relê o storage antes, então outra aba
 * que gravou outro projeto não é apagada. Falha do storage não chega à fila.
 */
export function gravarManifesto(storage, projeto, itens) {
  const projetos = lerManifesto(storage);
  projetos.delete(projeto);
  const proprios = aparar(itens.map(entradaValida).filter(Boolean));
  if (proprios.length) projetos.set(projeto, proprios);
  const recentes = [...projetos].slice(-MAX_PROJETOS);
  try {
    if (recentes.length) storage?.setItem(MANIFESTO, JSON.stringify({ projetos: Object.fromEntries(recentes) }));
    else storage?.removeItem(MANIFESTO);
  } catch {
    // Sem storage a fila segue; só não lembra depois de recarregar.
  }
}

/** Erro de envio → texto. Sem status, a requisição nem chegou: a conexão caiu. */
export function mensagemDeErro(erro, modo) {
  const status = erro?.status;
  if (status === undefined) {
    return modo === "equipe"
      ? "Conexão interrompida. Retome o envio para continuar de onde parou."
      : "Conexão interrompida. Retome o envio; este arquivo recomeça do início.";
  }
  if (status === 413) return "Este arquivo passa do tamanho máximo permitido.";
  if (status === 507) return "Não há espaço suficiente para guardar este arquivo. Libere espaço e tente de novo.";
  if (status === 404 && modo === "equipe") return "O envio expirou no servidor. Tente de novo para enviar do começo.";
  if (status === 409) return "O projeto mudou durante o envio. Tente de novo.";
  return erro?.message || "Não foi possível enviar este arquivo.";
}

/** Recusa só o que nem precisa ir ao servidor: arquivo vazio, texto ou imagem. */
export function motivoInvalido(arquivo) {
  if (!arquivo?.size) return "Arquivo vazio: escolha um vídeo ou um áudio.";
  if (/^(image|text)\//.test(arquivo.type || "")) return "Não é vídeo nem áudio: escolha outro arquivo.";
  return null;
}

function pct(valor) {
  return Math.max(0, Math.min(100, Math.round(Number(valor) || 0)));
}

/** Texto de estado de um item da fila. */
export function textoDoItem(item, { pausado, modo }) {
  switch (item.estado) {
    case "aguardando": return pausado ? "Aguardando · envio pausado" : "Aguardando envio";
    case "enviando":
      if (modo !== "equipe") return "Enviando…";
      if (item.fase === "importing") return "Importando para o acervo";
      if (item.fase === "verifying") return "Verificando";
      return "Enviando · " + pct(item.percent) + "%";
    case "adicionando": return "Adicionando ao projeto…";
    case "pausado": return item.percent != null ? "Pausado · " + pct(item.percent) + "%" : "Pausado";
    case "erro": return item.mediaId ? "Enviado · falta adicionar ao projeto" : "Falhou";
    case "sem-arquivo":
      if (item.mediaId) return "Enviado · falta adicionar ao projeto";
      return item.percent != null ? "Interrompido · " + pct(item.percent) + "% enviado" : "Não enviado";
    default:
      if (item.reconhecido) return "Já no projeto · não reenviado";
      if (item.reuso === "projeto") return "Já estava no projeto";
      return item.reuso === "acervo" ? "No projeto · Mídia reaproveitada" : "No projeto";
  }
}

/** Ações que cada item oferece agora (o que a tela desenha como botão). */
export function acoesDoItem(item, { modo }) {
  if (item.estado === "pronto" || item.estado === "adicionando") return [];
  // O POST do modo local não tem como ser interrompido: o arquivo em voo termina.
  if (item.estado === "enviando") return modo === "equipe" ? ["remover"] : [];
  const acoes = [];
  if (item.mediaId && (item.estado === "erro" || item.estado === "sem-arquivo")) acoes.push("adicionar");
  else if (item.estado === "erro" && item.arquivo && !item.invalido) acoes.push("tentar");
  acoes.push("remover");
  return acoes;
}

/** Frase de resumo: quantos estão no projeto, o que corre e o que espera o arquivo. */
export function textoDoResumo(visao) {
  const { total, prontos, semArquivo, erros } = visao.contagem;
  if (!total) return "";
  const partes = [prontos + " de " + total + " no projeto"];
  const ativo = visao.itens.find((item) => item.estado === "enviando" || item.estado === "adicionando");
  if (ativo) partes.push("enviando " + ativo.nome);
  else if (visao.pausado && visao.contagem.pendentes) partes.push("envio pausado");
  if (semArquivo) partes.push(semArquivo + (semArquivo === 1 ? " espera o arquivo" : " esperam o arquivo"));
  if (erros) partes.push(erros + " com falha");
  return partes.join(" · ");
}

/**
 * Estado da fila. Os transportes chegam prontos:
 * - `enviar(item, { onProgress })`: no modo equipe devolve `{ mediaId, deduplicado }`
 *   (o cliente retomável de hoje); no local, `{ sha256, reaproveitada }` já com a
 *   fonte no projeto. Pausa no modo equipe chega como erro `UploadPausedError`.
 * - `adicionar(mediaId)`: só no modo equipe, `POST project/media` → `{ sha256, reaproveitada }`.
 * - `pausar(item)` / `cancelar(item)`: param o envio do item e apagam o parcial no servidor.
 * - `parcial(entrada)`: percentual já enviado de um pendente (decupa.uploads.v1) ou null.
 * - `fontes()`: sha256 das fontes do projeto agora (Set), ou null antes do primeiro projeto.
 * @param {object} config
 * @param {"equipe"|"local"} config.modo
 * @param {(file: any) => string} config.chaveDoArquivo
 * @param {any} config.enviar
 * @param {any} [config.adicionar]
 * @param {any} [config.pausar]
 * @param {any} [config.cancelar]
 * @param {any} [config.parcial]
 * @param {() => Set<string> | null} config.fontes
 * @param {any} [config.storage]
 * @param {string} config.projeto
 * @param {(visao: any) => void} [config.onChange]
 */
export function criarFila({
  modo, chaveDoArquivo, enviar, adicionar = async () => { throw new Error("sem acervo"); },
  pausar: pausarEnvio = () => {}, cancelar = async () => {}, parcial = () => null,
  fontes, storage, projeto, onChange = () => {},
}) {
  let itens = [];
  let ativo = null;
  let pausado = false;
  let restaurada = false;
  let gravado = "";

  const noProjeto = (sha256) => Boolean(sha256) && fontes()?.has(sha256) === true;

  function novoItem(arquivo, chave) {
    return {
      chave, nome: arquivo.name, tamanho: arquivo.size, ultimaModificacao: arquivo.lastModified || 0,
      arquivo, estado: "aguardando", fase: null, percent: null, mensagem: null,
      mediaId: null, sha256: null, reuso: null, reconhecido: false, invalido: false, removido: false,
    };
  }

  function contagem() {
    const conta = (estado) => itens.filter((item) => item.estado === estado).length;
    const prontos = conta("pronto");
    return {
      total: itens.length, prontos, semArquivo: conta("sem-arquivo"), erros: conta("erro"),
      pendentes: itens.length - prontos - conta("sem-arquivo") - conta("erro"),
    };
  }

  function instantanea() {
    const visao = {
      modo, pausado, ativo: Boolean(ativo),
      contagem: contagem(),
      podeLimpar: itens.some((item) => item.estado === "pronto"),
      precisaArquivo: itens.some((item) => item.estado === "sem-arquivo" && !item.mediaId),
      itens: itens.map((item) => ({
        chave: item.chave, nome: item.nome, estado: item.estado, fase: item.fase,
        percent: item.percent, mensagem: item.mensagem, reconhecido: item.reconhecido,
        texto: textoDoItem(item, { pausado, modo }),
        acoes: acoesDoItem(item, { modo }),
      })),
    };
    const pendentes = itens.some((item) => item.estado === "aguardando" || item.estado === "pausado");
    visao.podePausar = !pausado && (Boolean(ativo) || pendentes);
    visao.podeRetomar = pausado && pendentes;
    visao.resumo = textoDoResumo(visao);
    return visao;
  }

  function entradas() {
    return itens.filter((item) => !item.invalido).map((item) => ({
      chave: item.chave, nome: item.nome, tamanho: item.tamanho, ultimaModificacao: item.ultimaModificacao,
      estado: item.estado === "pronto" ? "concluido" : item.mediaId ? "enviado" : "pendente",
      ...(item.estado === "pronto" ? { sha256: item.sha256 } : {}),
      ...(item.estado !== "pronto" && item.mediaId ? { mediaId: item.mediaId } : {}),
    }));
  }

  function persistir() {
    // Antes da restauração a fila não conhece o manifesto: gravar agora o apagaria.
    if (!restaurada) return;
    const lista = entradas();
    const serial = JSON.stringify(lista);
    if (serial === gravado) return;
    gravado = serial;
    gravarManifesto(storage, projeto, lista);
  }

  function notificar() {
    persistir();
    onChange(instantanea());
  }

  function progredir(item, valor) {
    if (item.removido || ativo !== item) return;
    item.percent = pct(valor.percent);
    item.fase = valor.state ?? null;
    onChange(instantanea());
  }

  // Único ponto que inicia envios: respeita a pausa, a fila de um por vez e
  // espera o primeiro projeto (o envio precisa da revisão e das fontes).
  function proximo() {
    if (pausado || ativo || !restaurada) return;
    const seguinte = itens.find((item) => item.estado === "aguardando");
    if (seguinte) void iniciar(seguinte);
  }

  async function iniciar(item) {
    ativo = item;
    Object.assign(item, { mensagem: null, fase: null });
    // Enviado ao acervo e ainda fora do projeto: só falta associar, sem bytes.
    if (item.mediaId) {
      await associar(item);
      return;
    }
    item.estado = "enviando";
    if (item.percent == null && modo === "equipe") item.percent = 0;
    notificar();
    let resultado;
    try {
      resultado = await enviar(item, { onProgress: (valor) => progredir(item, valor) });
    } catch (erro) {
      falhar(item, erro);
      return;
    }
    if (item.removido) return;
    if (modo === "equipe") {
      item.mediaId = resultado.mediaId;
      item.reuso = resultado.deduplicado ? "acervo" : null;
      // O arquivo já está no acervo: um retry só repete a associação.
      item.arquivo = null;
      await associar(item);
      return;
    }
    concluir(item, resultado);
  }

  async function associar(item) {
    item.estado = "adicionando";
    notificar();
    let resultado;
    try {
      resultado = await adicionar(item.mediaId);
    } catch (erro) {
      if (item.removido) return;
      if (ativo === item) ativo = null;
      item.estado = "erro";
      item.mensagem = "O arquivo já está no acervo, mas não entrou no projeto: "
        + (erro?.message || String(erro)) + ". Adicione de novo; nada é reenviado.";
      notificar();
      proximo();
      return;
    }
    concluir(item, resultado);
  }

  function concluir(item, resultado) {
    if (item.removido) return;
    if (ativo === item) ativo = null;
    Object.assign(item, {
      estado: "pronto", sha256: resultado.sha256, percent: 100, fase: null, mensagem: null,
      mediaId: null, arquivo: null, reconhecido: false,
      reuso: resultado.reaproveitada ? "projeto" : item.reuso,
    });
    notificar();
    proximo();
  }

  function falhar(item, erro) {
    if (item.removido) return;
    if (ativo === item) ativo = null;
    item.fase = null;
    if (erro?.name === "UploadPausedError") {
      item.estado = "pausado";
    } else if (erro?.status === undefined) {
      // Conexão caiu: os próximos cairiam também. A fila para e espera o Retomar.
      item.estado = "pausado";
      item.mensagem = mensagemDeErro(erro, modo);
      pausado = true;
      if (modo !== "equipe") item.percent = null;
    } else {
      item.estado = "erro";
      item.mensagem = mensagemDeErro(erro, modo);
    }
    notificar();
    proximo();
  }

  /**
   * Arquivos escolhidos (seletor ou arraste). Todos entram na lista já; o que
   * já está no projeto pela mesma impressão é reconhecido e não sobe de novo.
   * Devolve quantos vão de fato para o envio.
   */
  function adicionarArquivos(arquivos) {
    let novos = 0;
    for (const arquivo of arquivos) {
      const chave = chaveDoArquivo(arquivo);
      const existente = itens.find((item) => item.chave === chave);
      if (existente) {
        if (existente.estado === "pronto") {
          if (noProjeto(existente.sha256)) {
            existente.reconhecido = true;
            continue;
          }
          // A fonte saiu do projeto: volta a ser um arquivo como outro qualquer.
          Object.assign(existente, novoItem(arquivo, chave));
          novos += 1;
          continue;
        }
        if (existente.estado === "sem-arquivo" || existente.estado === "erro" || existente.estado === "pausado") {
          if (existente.invalido) continue;
          existente.arquivo = arquivo;
          // Enviado ao acervo só precisa associar; o resto volta para a vez dele.
          if (existente.estado !== "pausado" || pausado === false) {
            Object.assign(existente, { estado: "aguardando", mensagem: null });
          }
          novos += 1;
        }
        continue;
      }
      const item = novoItem(arquivo, chave);
      const motivo = motivoInvalido(arquivo);
      if (motivo) Object.assign(item, { estado: "erro", mensagem: motivo, invalido: true });
      else novos += 1;
      itens.push(item);
    }
    notificar();
    proximo();
    return novos;
  }

  /**
   * Primeira resposta do projeto: o manifesto vira fila. Concluído só vale se
   * o sha256 ainda for fonte do projeto; o resto espera o arquivo (o parcial
   * mostra quanto já subiu e retoma pelo decupa.uploads.v1).
   */
  function restaurar() {
    if (restaurada || fontes() == null) return;
    restaurada = true;
    const salvos = lerManifesto(storage).get(projeto) || [];
    for (const salvo of salvos) {
      if (itens.some((item) => item.chave === salvo.chave)) continue;
      const base = novoItem({ name: salvo.nome, size: salvo.tamanho, lastModified: salvo.ultimaModificacao }, salvo.chave);
      base.arquivo = null;
      if (salvo.estado === "concluido") {
        if (!noProjeto(salvo.sha256)) continue;
        itens.push({ ...base, estado: "pronto", sha256: salvo.sha256, percent: 100 });
      } else if (salvo.estado === "enviado") {
        if (noProjeto(salvo.mediaId)) itens.push({ ...base, estado: "pronto", sha256: salvo.mediaId, percent: 100 });
        else itens.push({ ...base, estado: "sem-arquivo", mediaId: salvo.mediaId, percent: 100 });
      } else {
        const ja = parcial(salvo);
        itens.push({ ...base, estado: "sem-arquivo", percent: ja == null ? null : pct(ja) });
      }
    }
    // Concluídos cuja fonte saiu do projeto deixam o manifesto aqui.
    notificar();
    proximo();
  }

  /** Projeto novo da resposta ou do polling: concluído cuja fonte saiu deixa a fila. */
  function sincronizar() {
    if (fontes() == null) return;
    if (!restaurada) {
      restaurar();
      return;
    }
    const antes = itens.length;
    itens = itens.filter((item) => item.estado !== "pronto" || noProjeto(item.sha256));
    if (itens.length !== antes) notificar();
  }

  function pausar() {
    if (pausado) return;
    pausado = true;
    // No modo local o arquivo em voo termina; a fila para depois dele.
    if (ativo && ativo.estado === "enviando" && modo === "equipe") pausarEnvio(ativo);
    notificar();
  }

  function retomar() {
    pausado = false;
    for (const item of itens) {
      if (item.estado === "pausado" && item.arquivo) Object.assign(item, { estado: "aguardando", mensagem: null });
    }
    notificar();
    proximo();
  }

  function remover(chave) {
    const item = itens.find((outro) => outro.chave === chave);
    if (!item || item.estado === "adicionando" || (item.estado === "enviando" && modo !== "equipe")) return;
    item.removido = true;
    if (ativo === item) ativo = null;
    // Cancela no servidor o envio parcial; o que já está no acervo ou no projeto fica.
    if (modo === "equipe" && !item.mediaId && item.estado !== "pronto") {
      void Promise.resolve(cancelar(item)).catch(() => {});
    }
    itens = itens.filter((outro) => outro !== item);
    notificar();
    proximo();
  }

  /** Tentar de novo (erro com arquivo) ou adicionar ao projeto (já no acervo). */
  function tentarDeNovo(chave) {
    const item = itens.find((outro) => outro.chave === chave);
    if (!item || item.invalido) return;
    if (item.estado !== "erro" && !(item.estado === "sem-arquivo" && item.mediaId)) return;
    if (!item.arquivo && !item.mediaId) return;
    Object.assign(item, { estado: "aguardando", mensagem: null });
    notificar();
    proximo();
  }

  /** Concluídos saem da lista e do manifesto; uma nova seleção deles volta a enviar. */
  function limparConcluidos() {
    itens = itens.filter((item) => item.estado !== "pronto");
    notificar();
  }

  return {
    instantanea,
    adicionarArquivos,
    restaurar,
    sincronizar,
    pausar,
    retomar,
    remover,
    tentarDeNovo,
    limparConcluidos,
    /** Há bytes indo ou por ir agora (aviso de saída, Reserva no modo local). */
    emAndamento: () => Boolean(ativo),
  };
}
