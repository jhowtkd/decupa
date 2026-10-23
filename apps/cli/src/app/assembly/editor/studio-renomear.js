// Renomear a montagem (studio). O servidor não muda: POST project/rename sobe
// a revisão, zera prévia e aprovação e não grava passo de desfazer, então a
// pilha fica vazia até a próxima edição. Por isso o diálogo diz isso antes de
// confirmar, com os valores do projeto aberto, e depois mostra o que mudou.

const NOME_MAXIMO = 200;

/** Nome que o topo mostra (o page.js usa a mesma regra para #projectName). */
export function nomeDaMontagem(project) {
  const nome = project?.assembly?.name;
  return nome && nome !== project.id ? nome : "";
}

/**
 * O que muda com o nome (puro): revisão, prévia, aprovação, desfazer e refazer.
 * @param {number | null} [redoRevision]
 */
export function efeitosDeRenomear(project, undoRevision, redoRevision = null) {
  const atual = project.revision;
  const proxima = atual + 1;
  const aprovada = project.finalApprovedRevision != null && project.finalApprovedRevision === atual;
  const efeitos = ["A montagem passa da v" + atual + " para a v" + proxima + "."];
  if (project.previewRevision != null) {
    efeitos.push("A prévia v" + project.previewRevision + " deixa de valer: uma nova é gerada para a v" + proxima + ".");
  } else if (project.scenes?.length) {
    efeitos.push("A prévia é gerada para a v" + proxima + ".");
  }
  efeitos.push(aprovada
    ? "A aprovação da v" + atual + " é desfeita: assista à nova prévia e aprove de novo antes de entregar."
    : "Nenhuma aprovação vale para a v" + proxima + ": a entrega segue travada até aprovar.");
  efeitos.push(undoRevision != null
    ? "As edições feitas até aqui deixam de poder ser desfeitas; o Desfazer também não volta o nome."
    : "O Desfazer não volta o nome.");
  // O renomear também encerra o ramo do refazer (revisão nova sem passo).
  if (redoRevision != null) efeitos.push("O que foi desfeito deixa de poder ser refeito.");
  return efeitos;
}

/** Nome digitado → erro ou o nome limpo (puro). */
export function validarNome(valor, atual) {
  const nome = String(valor ?? "").trim();
  if (!nome) return { valido: false, mensagem: "Dê um nome à montagem." };
  if (nome.length > NOME_MAXIMO) return { valido: false, mensagem: "O nome pode ter até " + NOME_MAXIMO + " caracteres." };
  if (nome === atual) return { valido: false, mensagem: "Este já é o nome da montagem." };
  return { valido: true, nome };
}

/**
 * Recusa do POST (pura) → texto. Três 409 diferentes: a Reserva passou para
 * outra aba (`dono`), o envio local em curso segura alterações (o call() responde
 * sem ir ao servidor, revisão igual) e a revisão andou (o call() reconcilia).
 */
export function mensagemDeRecusa(status, body, antes, agora) {
  if (status === 409 && body?.dono) return body.error || "Projeto reservado para edição";
  if (status === 409 && agora && antes && agora.revision !== antes.revision) {
    return "A montagem mudou enquanto você renomeava. Confira os avisos e confirme de novo.";
  }
  return body?.error || "Não foi possível renomear.";
}

/** Depois de renomear (puro): o estado que a tela passa a refletir. */
export function resultadoDeRenomear(antes, depois) {
  return [
    "Agora é a v" + depois.revision + (antes ? " (era v" + antes.revision + ")." : "."),
    depois.previewRevision === depois.revision ? "Prévia da v" + depois.revision + " pronta."
      : depois.scenes?.length ? "Prévia desatualizada: a da v" + depois.revision + " está sendo gerada."
      : "Sem prévia: a montagem ainda não tem cenas.",
    "Aprovação: pendente. Assista à prévia e aprove de novo antes de entregar.",
    "Desfazer: as edições anteriores ao novo nome não podem mais ser desfeitas.",
  ];
}

/** Liga o item do menu do projeto a um diálogo com aviso, confirmação e resultado. */
export function mountRenomear({ state, api }) {
  const opener = document.getElementById("renameProject");
  if (!opener) return;
  const dialog = document.createElement("dialog");
  dialog.id = "renameDialog";
  dialog.className = "rename-dialog";
  dialog.setAttribute("aria-labelledby", "renameTitle");
  dialog.innerHTML = '<form method="dialog" id="renameForm" novalidate>'
    + '<h2 id="renameTitle">Renomear montagem</h2>'
    + '<label for="renameInput">Nome</label>'
    + '<input id="renameInput" type="text" maxlength="' + NOME_MAXIMO + '" autocomplete="off" aria-describedby="renameError renameWarning">'
    + '<p id="renameError" class="rename-error" role="alert" hidden></p>'
    + '<div id="renameWarning" class="rename-warning"><p class="rename-lead">Renomear conta como uma edição:</p><ul id="renameEffects"></ul></div>'
    + '<div id="renameResult" class="rename-result" role="status" hidden><p class="rename-lead" id="renameDone"></p><ul id="renameAfter"></ul></div>'
    + '<div class="row dialog-actions"><button type="button" id="renameCancel" class="quiet">Cancelar</button>'
    + '<button type="submit" id="renameConfirm" class="primary">Renomear</button></div>'
    + "</form>";
  document.body.appendChild(dialog);
  const $ = (id) => dialog.querySelector("#" + id);
  const input = $("renameInput");
  const error = $("renameError");
  const warning = $("renameWarning");
  const result = $("renameResult");
  const confirm = $("renameConfirm");
  const cancel = $("renameCancel");
  let busy = false;

  function lista(element, linhas) {
    element.replaceChildren(...linhas.map((texto) => {
      const li = document.createElement("li");
      li.textContent = texto;
      return li;
    }));
  }

  function mostrarErro(mensagem) {
    error.textContent = mensagem || "";
    error.hidden = !mensagem;
    input.setAttribute("aria-invalid", String(Boolean(mensagem)));
  }

  /** Aviso calculado na hora: outra aba ou o polling pode ter mudado a revisão. */
  function pintarAviso() {
    const project = state.get("project");
    if (!project) return;
    lista($("renameEffects"), efeitosDeRenomear(project, state.get("undoRevision"), state.get("redoRevision")));
  }

  function abrir() {
    const project = state.get("project");
    if (!project || dialog.open) return;
    opener.closest("details")?.removeAttribute("open");
    input.value = nomeDaMontagem(project);
    input.disabled = false;
    mostrarErro("");
    warning.hidden = false;
    result.hidden = true;
    confirm.hidden = false;
    confirm.disabled = false;
    cancel.textContent = "Cancelar";
    pintarAviso();
    dialog.showModal();
    input.focus();
    input.select?.();
  }

  async function renomear(event) {
    event.preventDefault();
    if (busy || !result.hidden) return;
    const antes = state.get("project");
    const validado = validarNome(input.value, nomeDaMontagem(antes));
    if (!validado.valido) {
      mostrarErro(validado.mensagem);
      input.focus();
      return;
    }
    busy = true;
    confirm.disabled = true;
    mostrarErro("");
    try {
      const { res, body } = await api.call("project/rename", {
        method: "POST",
        body: JSON.stringify({ nome: validado.nome, baseRevision: antes.revision }),
        label: "Renomeando montagem…",
      });
      if (!res.ok) {
        // O aviso volta com a revisão que o call() reconciliou, se mudou.
        pintarAviso();
        mostrarErro(mensagemDeRecusa(res.status, body, antes, state.get("project")));
        return;
      }
      const depois = state.get("project");
      $("renameDone").textContent = "Montagem renomeada para “" + validado.nome + "”.";
      lista($("renameAfter"), resultadoDeRenomear(antes, depois));
      warning.hidden = true;
      result.hidden = false;
      confirm.hidden = true;
      input.disabled = true;
      cancel.textContent = "Fechar";
      cancel.focus();
    } catch (erro) {
      mostrarErro(erro?.message || String(erro));
    } finally {
      busy = false;
      confirm.disabled = false;
    }
  }

  opener.addEventListener("click", abrir);
  $("renameForm").addEventListener("submit", renomear);
  cancel.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    if (opener.isConnected && !opener.disabled) opener.closest("details")?.querySelector("summary")?.focus();
  });
  // O aviso acompanha o projeto enquanto o diálogo está aberto e ainda não confirmou.
  state.subscribe("project", () => { if (dialog.open && result.hidden) pintarAviso(); });
  state.subscribe("undoRevision", () => { if (dialog.open && result.hidden) pintarAviso(); });
  state.subscribe("redoRevision", () => { if (dialog.open && result.hidden) pintarAviso(); });
}
