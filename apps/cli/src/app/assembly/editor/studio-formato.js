// Formato da montagem no studio. Cada proporção mostra a resolução de saída
// (o canvas que o render e a entrega usam), mantém o lado menor do quadro
// atual e o fps: o POST project/settings leva o fps de agora. O render não
// reenquadra (cada plano entra inteiro, com faixas escuras), e a legenda do
// monitor não vai para o MP4; o diálogo diz as duas coisas antes de aplicar.
// É o único diálogo de formato do studio: "Formato…" na faixa e, na Entrega,
// quem chamar abrirFormato() (o #formatDialog antigo fica para a legacy).
import { PROPORCOES, formatChip, fpsLabel } from "./format.js";
import { LEGENDA_FORA_DO_MP4 } from "./studio-legendas.js";

/** Medida par, como o servidor exige. */
const par = (n) => Math.max(2, 2 * Math.round(n / 2));

/** Resolução de saída de uma proporção (pura): o lado menor do quadro atual fica, e as medidas ficam pares. */
export function resolucaoDe(proporcao, assembly) {
  const menor = Math.min(assembly.width, assembly.height);
  if (proporcao.w >= proporcao.h) return { width: par((menor * proporcao.w) / proporcao.h), height: par(menor) };
  return { width: par(menor), height: par((menor * proporcao.h) / proporcao.w) };
}

/** Opções de proporção do diálogo (pura), com a resolução de saída e a atual marcada. */
export function opcoesDeFormato(assembly) {
  return PROPORCOES.map((proporcao) => {
    const { width, height } = resolucaoDe(proporcao, assembly);
    return { ...proporcao, width, height, atual: width === assembly.width && height === assembly.height };
  });
}

/** Texto (a) do plano, com o fps que fica (puro). */
export function avisoDeReenquadrar(assembly) {
  return "Mudar a proporção não reenquadra: cada plano entra inteiro no quadro novo, com faixas escuras onde sobrar espaço. "
    + "O fps (" + fpsLabel(assembly.fps).replace(" fps", "") + ") continua o mesmo.";
}

/** "30000/1001" ou "29,97" → {num, den} inteiros, ou null (puro). */
export function lerFps(texto) {
  const bruto = String(texto ?? "").trim().replace(",", ".");
  const partes = bruto.split("/");
  if (partes.length === 2) {
    const num = Number(partes[0]);
    const den = Number(partes[1]);
    return Number.isSafeInteger(num) && Number.isSafeInteger(den) && num > 0 && den > 0 ? { num, den } : null;
  }
  const valor = Number(bruto);
  if (!(valor > 0) || !Number.isFinite(valor)) return null;
  return Number.isInteger(valor) ? { num: valor, den: 1 } : { num: Math.round(valor * 1000), den: 1000 };
}

/**
 * Corpo do POST project/settings para a escolha (puro), ou o erro a mostrar.
 * Proporção: resolução da opção e o fps atual. Fonte: o servidor adota o
 * tamanho e o fps dela. Personalizado: os campos como estão.
 */
export function pedidoDeFormato(escolha, project, campos = {}) {
  const assembly = project.assembly;
  const baseRevision = project.revision;
  const proporcao = PROPORCOES.find((item) => item.id === escolha);
  if (proporcao) {
    const { width, height } = resolucaoDe(proporcao, assembly);
    if (width === assembly.width && height === assembly.height) return { erro: "Este já é o formato da montagem." };
    return { body: { baseRevision, width, height, fps: { num: assembly.fps.num, den: assembly.fps.den } } };
  }
  if (escolha === "fonte") {
    if (!campos.sourceId) return { erro: "Escolha a fonte." };
    return { body: { baseRevision, sourceId: campos.sourceId } };
  }
  if (escolha === "personalizado") {
    const width = Number(campos.width);
    const height = Number(campos.height);
    if (!Number.isSafeInteger(width) || width <= 0 || width % 2 !== 0
      || !Number.isSafeInteger(height) || height <= 0 || height % 2 !== 0) {
      return { erro: "Largura e altura precisam ser números pares." };
    }
    const fps = lerFps(campos.fps);
    if (!fps) return { erro: "Fps inválido: use 25 ou 30000/1001." };
    return { body: { baseRevision, width, height, fps } };
  }
  return { erro: "Escolha um formato." };
}

let abrirAtual = null;

/** Abre o diálogo de formato do studio (depois de mountFormato). */
export function abrirFormato() {
  abrirAtual?.();
}

/** Monta o diálogo; qualquer botão [data-acao="formato"] o abre. */
export function mountFormato({ state, api }) {
  const dialog = document.createElement("dialog");
  dialog.id = "formatoDialog";
  dialog.className = "formato-dialog";
  dialog.setAttribute("aria-labelledby", "formatoTitulo");
  dialog.innerHTML = '<form method="dialog" id="formatoForm" novalidate>'
    + '<h2 id="formatoTitulo">Formato da montagem</h2>'
    + '<p class="formato-agora">Agora: <span class="mono" id="formatoAgora"></span></p>'
    + '<fieldset class="formato-opcoes"><legend class="ttl">Proporção e resolução de saída</legend>'
    + '<div id="formatoProporcoes" class="formato-grade"></div>'
    + '<label class="formato-linha"><input type="radio" name="formatoEscolha" value="fonte"> Usar o formato de '
    + '<select id="formatoFonte" aria-label="Fonte do formato"></select></label>'
    + '<p id="formatoFonteAviso" class="formato-aviso" hidden></p>'
    + '<label class="formato-linha"><input type="radio" name="formatoEscolha" value="personalizado"> Personalizado</label>'
    + '<div id="formatoCampos" class="formato-campos" hidden>'
    + '<label>Largura <input id="formatoLargura" type="number" min="2" step="2"></label>'
    + '<label>Altura <input id="formatoAltura" type="number" min="2" step="2"></label>'
    + '<label>Fps <input id="formatoFps" type="text" placeholder="25 ou 30000/1001"></label></div>'
    + "</fieldset>"
    + '<p id="formatoReenquadra" class="formato-nota"></p>'
    + '<p class="formato-nota">' + LEGENDA_FORA_DO_MP4 + "</p>"
    + '<p class="formato-nota">Aplicar cria uma versão nova da montagem: a prévia e a aprovação atuais ficam desatualizadas.</p>'
    + '<p id="formatoErro" class="formato-erro" role="alert" hidden></p>'
    + '<div class="row dialog-actions"><button type="button" id="formatoCancelar" class="quiet">Cancelar</button>'
    + '<button type="submit" id="formatoAplicar" class="primary">Aplicar formato</button></div>'
    + "</form>";
  document.body.appendChild(dialog);
  const $ = (id) => dialog.querySelector("#" + id);
  const escolhas = () => [...dialog.querySelectorAll('input[name="formatoEscolha"]')];
  const escolhida = () => escolhas().find((input) => input.checked)?.value ?? "";
  let busy = false;
  let devolverFoco = null;

  function mostrarErro(mensagem) {
    $("formatoErro").textContent = mensagem || "";
    $("formatoErro").hidden = !mensagem;
  }

  /** Campos que só valem para a escolha feita, e o aviso da fonte. */
  function pintarEscolha() {
    const p = state.get("project");
    if (!p) return;
    const escolha = escolhida();
    $("formatoCampos").hidden = escolha !== "personalizado";
    const fonte = p?.assembly.sources.find((item) => item.id === $("formatoFonte").value);
    const aviso = $("formatoFonteAviso");
    aviso.hidden = escolha !== "fonte" || !fonte;
    if (fonte) {
      aviso.textContent = "Adota o tamanho e o fps de " + fonte.name + (fonte.fps ? " (" + fpsLabel(fonte.fps) + ")" : "")
        + ", não só a proporção.";
    }
    const atual = escolha && opcoesDeFormato(p.assembly).find((item) => item.id === escolha)?.atual;
    $("formatoAplicar").disabled = busy || !escolha || Boolean(atual);
  }

  function preencher(p) {
    const assembly = p.assembly;
    $("formatoAgora").textContent = formatChip(assembly);
    $("formatoReenquadra").textContent = avisoDeReenquadrar(assembly);
    $("formatoProporcoes").innerHTML = opcoesDeFormato(assembly).map((item) => '<label class="formato-opcao'
      + (item.atual ? " is-atual" : "") + '"><input type="radio" name="formatoEscolha" value="' + item.id + '"'
      + (item.atual ? " checked" : "") + '><span class="formato-nome">' + item.id + '</span><span class="mono">'
      + item.width + "×" + item.height + '</span><span class="formato-uso">' + item.uso + (item.atual ? " · atual" : "")
      + "</span></label>").join("");
    const atual = escolhas().find((input) => input.value === opcoesDeFormato(assembly).find((item) => item.atual)?.id);
    for (const input of escolhas()) input.checked = input === atual;
    const select = $("formatoFonte");
    select.replaceChildren(...assembly.sources.filter((item) => item.hasVideo).map((item) => new Option(item.name, item.id)));
    select.disabled = select.childElementCount === 0;
    $("formatoLargura").value = assembly.width;
    $("formatoAltura").value = assembly.height;
    $("formatoFps").value = assembly.fps.num + "/" + assembly.fps.den;
    mostrarErro("");
    pintarEscolha();
  }

  function abrir() {
    const p = state.get("project");
    if (!p || dialog.open) return;
    devolverFoco = document.activeElement;
    preencher(p);
    dialog.showModal();
    (escolhas().find((input) => input.checked) || escolhas()[0])?.focus();
  }
  abrirAtual = abrir;

  async function aplicar(event) {
    event.preventDefault();
    if (busy) return;
    const p = state.get("project");
    if (!p) return;
    const pedido = pedidoDeFormato(escolhida(), p, {
      sourceId: $("formatoFonte").value,
      width: $("formatoLargura").value,
      height: $("formatoAltura").value,
      fps: $("formatoFps").value,
    });
    if (pedido.erro) {
      mostrarErro(pedido.erro);
      return;
    }
    busy = true;
    $("formatoAplicar").disabled = true;
    try {
      const { res, body } = await api.call("project/settings", {
        method: "POST",
        body: JSON.stringify(pedido.body),
        label: "Alterando formato…",
      });
      if (res.ok) dialog.close();
      else mostrarErro(body?.error || "Não foi possível alterar o formato.");
    } catch (erro) {
      mostrarErro(erro?.message || String(erro));
    } finally {
      busy = false;
      if (dialog.open) pintarEscolha();
    }
  }

  dialog.addEventListener("change", (event) => {
    // Mexer num campo escolhe a linha dele.
    if (event.target.id === "formatoFonte") escolhas().find((input) => input.value === "fonte").checked = true;
    if (["formatoLargura", "formatoAltura", "formatoFps"].includes(event.target.id)) {
      escolhas().find((input) => input.value === "personalizado").checked = true;
    }
    // Mudar a escolha apaga o erro da tentativa anterior; o erro do POST fica até lá.
    mostrarErro("");
    pintarEscolha();
  });
  $("formatoForm").addEventListener("submit", aplicar);
  $("formatoCancelar").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    // A faixa redesenha com o formato novo: o botão de antes pode ter saído.
    const alvo = devolverFoco?.isConnected ? devolverFoco : document.querySelector('[data-acao="formato"]');
    if (alvo && !alvo.disabled) alvo.focus();
    devolverFoco = null;
  });
  document.addEventListener("click", (event) => {
    if (event.target.closest?.('[data-acao="formato"]')) abrir();
  });
  return { abrir };
}
