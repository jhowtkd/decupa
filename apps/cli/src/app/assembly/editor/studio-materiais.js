// Materiais do studio (DECUPA_EDITOR_UI=studio): a fila de envios no rail.
// O modelo é o studio-fila.js; aqui ficam os transportes de hoje, sem mudar
// protocolo (ResumableMediaUpload + POST project/media no modo equipe, POST
// project/import no local), o desenho da lista e o arraste sobre o rail.
// Nada aqui roda sozinho: só o arquivo escolhido pela pessoa sobe.
import { ResumableMediaUpload, UploadPausedError, uploadFingerprint } from "./media-upload.js";
import { RESERVA_PERDIDA, criarFila } from "./studio-fila.js";
import { projectHeaders, projectPath } from "../project-path.js";

const ROTULO_ACAO = { tentar: "Tentar de novo", adicionar: "Adicionar ao projeto", remover: "Remover" };

function localStore() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function projetoAtual() {
  return document.querySelector('meta[name="decupa-project-dir"]')?.getAttribute("content")
    || globalThis.location?.pathname || "";
}

/** Arquivo que só existe no manifesto: mesma impressão que o media-upload.js calcula. */
function arquivoSalvo(item) {
  return { name: item.nome, size: item.tamanho, lastModified: item.ultimaModificacao };
}

/** Erro de HTTP com o status preservado, como o media-upload.js faz; `dono` marca a Reserva perdida. */
function httpError(status, message, dono = null) {
  return Object.assign(new Error(message), { status }, dono ? { dono } : {});
}

/**
 * Monta a fila no rail de Materiais. `setStage` leva à etapa onde a fila
 * aparece; `onAtividade` diz ao bootstrap o que mostrar no status e se o
 * envio local está em voo (ui.importing segura edições, como na legacy).
 * `onConflitoDeReserva` repassa o 409 com dono do POST local (que não passa
 * pelo api.call) à UI da Reserva, que entra em Modo Leitura na hora.
 * Devolve `adicionar(arquivos)`, a porta de entrada do seletor e do arraste,
 * e `pausarPorReserva()`, que o bootstrap chama ao entrar em Modo Leitura.
 */
export function mountMateriais({
  state, api, setStage = () => {}, teamMode = false, mediaEnabled = false,
  readOnly = () => false, onAtividade = () => {}, onConflitoDeReserva = () => {},
  storage = localStore(), projeto = projetoAtual(),
  criarEnvio = (opcoes) => new ResumableMediaUpload(opcoes),
  fetchImpl = (url, init) => fetch(url, init),
}) {
  const modo = teamMode && mediaEnabled ? "equipe" : "local";
  /** Envio em voo por item: o cliente retomável e a promessa do start (equipe) ou o abort do POST (local). */
  const envios = new Map();

  async function importar(item, tentativa = 0) {
    const arquivo = item.arquivo;
    const revision = state.get("project").revision;
    // A URL vai inteira no template: o rastreador de recursos dos testes HTTP
    // lê `import` seguido de aspas como um import de módulo.
    const url = projectPath(`project/import?baseRevision=${revision}&name=${encodeURIComponent(arquivo.name)}`);
    // Pausar e Remover interrompem o corpo; o servidor apaga o .part do que não chegou inteiro.
    const controle = new AbortController();
    envios.set(item.chave, { abortar: () => controle.abort() });
    let res;
    let body;
    try {
      res = await fetchImpl(url, {
        method: "POST", headers: projectHeaders({ "x-file-size": String(arquivo.size) }), body: arquivo,
        signal: controle.signal,
      });
      body = await res.json().catch(() => ({}));
    } catch (erro) {
      if (controle.signal.aborted) throw new UploadPausedError();
      throw erro;
    } finally {
      envios.delete(item.chave);
    }
    // Reserva perdida: repetir mandaria o arquivo inteiro de novo para outro 409.
    if (res.status === 409 && body.dono) {
      onConflitoDeReserva(body);
      throw httpError(409, body.error || RESERVA_PERDIDA, body.dono);
    }
    // Revisão andou entre um arquivo e outro: reconcilia e tenta uma vez.
    if (res.status === 409 && tentativa === 0) {
      await api.call("project").catch(() => {});
      return importar(item, 1);
    }
    if (!res.ok) throw httpError(res.status, body.error || "erro " + res.status);
    if (body.project) {
      state.set("project", body.project);
      state.set("operation", body.operation || null);
    }
    return { sha256: body.source?.sha256, reaproveitada: body.reused === true };
  }

  const fila = criarFila({
    modo,
    projeto,
    storage,
    chaveDoArquivo: uploadFingerprint,
    fontes: () => {
      const project = state.get("project");
      return project ? new Set(project.assembly.sources.map((source) => source.sha256)) : null;
    },
    enviar: (item, { onProgress }) => {
      if (modo !== "equipe") return importar(item);
      const upload = criarEnvio({ onProgress, storage });
      const inicio = upload.start(item.arquivo);
      envios.set(item.chave, { upload, inicio });
      return inicio.finally(() => envios.delete(item.chave));
    },
    adicionar: async (mediaId) => {
      const { res, body } = await api.call("project/media", {
        method: "POST",
        body: JSON.stringify({ baseRevision: state.get("project").revision, mediaId }),
        label: "Adicionando Mídia…",
      });
      // O api.call já levou o 409 com dono à UI da Reserva; o dono marca o erro para a fila parar.
      if (!res.ok) throw httpError(res.status, body?.error || "erro " + res.status, body?.dono);
      return { sha256: body.source?.sha256 ?? mediaId, reaproveitada: body.reused === true };
    },
    pausar: (item) => {
      const vivo = envios.get(item.chave);
      if (vivo?.upload) vivo.upload.pause();
      else vivo?.abortar();
    },
    cancelar: async (item) => {
      const alvo = item.arquivo ?? arquivoSalvo(item);
      const vivo = envios.get(item.chave);
      if (vivo?.abortar) {
        vivo.abortar();
        return;
      }
      if (vivo?.upload) {
        await vivo.upload.cancel(alvo);
        // O POST de criação pode ainda estar em voo (sem id para apagar): quando o
        // start assentar, o id existe e a sessão e o decupa.uploads.v1 são limpos também.
        await vivo.inicio.catch(() => {});
        if (vivo.upload.uploadId) await vivo.upload.cancel(alvo);
        return;
      }
      if (modo !== "equipe") return;
      // Depois de recarregar não há cliente vivo: o id salvo diz o que apagar no servidor.
      const upload = criarEnvio({ storage });
      upload.uploadId = upload.readSaved(alvo)?.id ?? null;
      await upload.cancel(alvo);
    },
    parcial: (entrada) => {
      if (modo !== "equipe" || !entrada.tamanho) return null;
      const salvo = criarEnvio({ storage }).readSaved(arquivoSalvo(entrada));
      const offset = Number(salvo?.offset) || 0;
      return offset > 0 ? Math.min(100, offset / entrada.tamanho * 100) : null;
    },
    onChange: (visao) => render(visao),
  });

  /* ---- Desenho ---- */

  const section = document.createElement("section");
  section.id = "filaMateriais";
  section.className = "fila";
  section.setAttribute("aria-labelledby", "filaTitulo");
  section.hidden = true;
  section.innerHTML = '<div class="fila-head"><h3 id="filaTitulo" class="ttl">Envios</h3>'
    + '<p id="filaResumo" class="fila-resumo" role="status" aria-live="polite"></p>'
    + '<div class="fila-acoes"><button type="button" id="filaPausar" class="quiet small"></button>'
    + '<button type="button" id="filaEscolher" class="quiet small"></button>'
    + '<button type="button" id="filaLimpar" class="quiet small">Limpar concluídos</button></div></div>'
    + '<ol id="filaLista" class="plain fila-lista"></ol>';
  const materials = document.querySelector("#rail .rail-materials");
  const sources = document.getElementById("sources");
  if (materials && sources?.parentElement === materials) materials.insertBefore(section, sources);
  else document.getElementById("rail")?.append(section);
  const lista = section.querySelector("#filaLista");
  const resumo = section.querySelector("#filaResumo");
  const pausar = section.querySelector("#filaPausar");
  const escolher = section.querySelector("#filaEscolher");
  const limpar = section.querySelector("#filaLimpar");
  const linhas = new Map();
  let ultimaAtividade = { importando: false, rotulo: null };

  function definirTexto(element, texto) {
    // Regravar o mesmo texto reanuncia a região viva a cada progresso.
    if (element.textContent !== texto) element.textContent = texto;
  }

  function linha(item) {
    let li = linhas.get(item.chave);
    if (!li) {
      li = document.createElement("li");
      li.className = "fila-item";
      li.innerHTML = '<div class="fila-item-top"><span class="fila-nome"></span><span class="fila-estado"></span></div>'
        + '<progress max="100"></progress><p class="fila-msg"></p><div class="fila-item-acoes"></div>';
      li.dataset.chave = item.chave;
      linhas.set(item.chave, li);
    }
    li.dataset.estado = item.estado;
    definirTexto(li.querySelector(".fila-nome"), item.nome);
    li.querySelector(".fila-nome").title = item.nome;
    definirTexto(li.querySelector(".fila-estado"), item.texto);
    const barra = li.querySelector("progress");
    const comBarra = item.percent != null && item.estado !== "pronto";
    barra.hidden = !comBarra;
    if (comBarra) barra.value = item.percent;
    barra.setAttribute("aria-label", "Progresso de " + item.nome);
    const msg = li.querySelector(".fila-msg");
    definirTexto(msg, item.mensagem || "");
    msg.hidden = !item.mensagem;
    const acoes = li.querySelector(".fila-item-acoes");
    // Os botões só são refeitos quando as ações mudam: o foco do teclado fica.
    const assinatura = item.acoes.join(",");
    if (acoes.dataset.acoes !== assinatura) {
      const focada = acoes.contains(document.activeElement) ? document.activeElement.dataset.acao : null;
      acoes.dataset.acoes = assinatura;
      acoes.replaceChildren(...item.acoes.map((acao) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "quiet small";
        button.dataset.acao = acao;
        button.dataset.chave = item.chave;
        button.textContent = ROTULO_ACAO[acao];
        const sr = document.createElement("span");
        sr.className = "sr";
        sr.textContent = " " + item.nome;
        button.append(sr);
        return button;
      }));
      if (focada) (acoes.querySelector('[data-acao="' + focada + '"]') || escolher).focus();
      else if (acoes.childElementCount === 0 && li.contains(document.activeElement)) escolher.focus();
    }
    return li;
  }

  function render(visao) {
    section.hidden = visao.itens.length === 0;
    // Projeto ainda vazio com arquivos na fila: o studio.css troca o guia de importar pela fila.
    if (visao.itens.length) document.body.dataset.fila = "ativa";
    else delete document.body.dataset.fila;
    definirTexto(resumo, visao.resumo);
    pausar.hidden = !(visao.podePausar || visao.podeRetomar);
    definirTexto(pausar, visao.podeRetomar ? "Retomar envio" : "Pausar envio");
    definirTexto(escolher, visao.precisaArquivo ? "Selecionar os arquivos de novo" : "Adicionar arquivos");
    limpar.hidden = !visao.podeLimpar;
    const vivos = new Set(visao.itens.map((item) => item.chave));
    for (const [chave, li] of linhas) {
      if (vivos.has(chave)) continue;
      if (li.contains(document.activeElement)) escolher.focus();
      li.remove();
      linhas.delete(chave);
    }
    // appendChild move o nó que já existe: a ordem segue a da fila sem recriar linhas.
    let anterior = null;
    for (const item of visao.itens) {
      const li = linha(item);
      const esperado = anterior ? anterior.nextSibling : lista.firstChild;
      if (li !== esperado) lista.insertBefore(li, esperado);
      anterior = li;
    }
    const emVoo = fila.emAndamento();
    atualizarAvisoDeSaida(emVoo);
    const ativo = visao.itens.find((item) => item.estado === "enviando" || item.estado === "adicionando");
    const posicao = ativo ? visao.itens.indexOf(ativo) + 1 : 0;
    const atividade = {
      importando: modo === "local" && ativo?.estado === "enviando",
      rotulo: ativo ? "Enviando " + posicao + "/" + visao.itens.length + " · " + ativo.nome + "…" : null,
    };
    // Só avisa o bootstrap quando muda: o progresso não pisa no rótulo de outra ação.
    if (atividade.importando !== ultimaAtividade.importando || atividade.rotulo !== ultimaAtividade.rotulo) {
      ultimaAtividade = atividade;
      onAtividade(atividade);
    }
  }

  function avisarAoSair(event) {
    event.preventDefault();
    event.returnValue = "";
  }

  function atualizarAvisoDeSaida(emVoo) {
    // Recarregar no meio do envio não perde o que concluiu, mas interrompe o arquivo em voo.
    if (emVoo) window.addEventListener("beforeunload", avisarAoSair);
    else window.removeEventListener("beforeunload", avisarAoSair);
  }

  /* ---- Eventos ---- */

  lista.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-acao]");
    if (!button) return;
    if (button.dataset.acao === "remover") fila.remover(button.dataset.chave);
    else fila.tentarDeNovo(button.dataset.chave);
  });
  pausar.addEventListener("click", () => {
    if (fila.instantanea().podeRetomar) fila.retomar();
    else fila.pausar();
  });
  escolher.addEventListener("click", () => document.getElementById("filePicker")?.click());
  limpar.addEventListener("click", () => fila.limparConcluidos());

  // Em Materiais o texto (onde a legacy recebe arrastes) fica fora da vista: o rail recebe.
  const rail = document.getElementById("rail");
  rail?.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types?.includes?.("Files")) return;
    event.preventDefault();
    rail.classList.add("over");
  });
  rail?.addEventListener("dragleave", (event) => {
    if (!rail.contains(event.relatedTarget)) rail.classList.remove("over");
  });
  rail?.addEventListener("drop", (event) => {
    rail.classList.remove("over");
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    adicionar([...event.dataTransfer.files]);
  });

  state.subscribe("project", () => fila.sincronizar());
  fila.sincronizar();

  /** Porta de entrada do seletor e do arraste no studio. */
  function adicionar(arquivos) {
    if (readOnly() || !arquivos.length) return;
    if (!state.get("project")) {
      api.notifyError("Aguarde o projeto carregar antes de enviar arquivos.");
      return;
    }
    fila.adicionarArquivos(arquivos);
    // A fila mora em Materiais: o diálogo de Mídia sai da frente e a etapa vai até ela.
    const dialog = document.getElementById("mediaDialog");
    if (dialog?.open) dialog.close();
    setStage("materiais");
  }

  /** Modo Leitura: a fila para (no modo equipe, a parte em voo também) e diz por quê. */
  function pausarPorReserva() {
    fila.pausar({ motivo: RESERVA_PERDIDA });
  }

  return { adicionar, pausarPorReserva, fila };
}
