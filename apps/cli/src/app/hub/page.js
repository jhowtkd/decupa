import { DriveMediaImport, ResumableMediaUpload, uploadFingerprint } from "./media-upload.js";
import { criarGaveta, formatarDuracao, textoDoResumo } from "./gaveta.js";

const state = { projects: [], timer: null, loadToken: 0, acervo: [], acervoToken: 0 };
const projectsElement = document.getElementById("projects");
const statusElement = document.getElementById("status");
const emptyElement = document.getElementById("empty");
const nameFilter = document.getElementById("nameFilter");
const flowFilter = document.getElementById("flowFilter");
const dialog = document.getElementById("newProjectDialog");
const form = document.getElementById("newProjectForm");
const formError = document.getElementById("formError");
const nameInput = document.getElementById("projectName");
const nameError = document.getElementById("projectNameError");
const flowInputs = document.querySelectorAll('input[name="fluxo"]');
const fileInput = document.getElementById("mediaFiles");
const driveImport = document.getElementById("driveImport");
const driveUrl = document.getElementById("driveUrl");
const driveAdd = document.getElementById("driveAdd");
const midiasRule = document.getElementById("midiasRule");
const libraryStatus = document.getElementById("libraryStatus");
const libraryElement = document.getElementById("library");
const queueElement = document.getElementById("mediaQueue");
const mediaEmpty = document.getElementById("mediaEmpty");
const pauseButton = document.getElementById("pauseUploads");
const uploadStatus = document.getElementById("uploadStatus");
const createButton = document.getElementById("createProject");
// Sem o acervo configurado, o servidor responde 404 aos envios: a gaveta avisa
// antes de o usuário escolher um arquivo que não teria para onde ir.
const mediaEnabled = document.querySelector('meta[name="decupa-media-enabled"]')?.getAttribute("content") === "true";
const driveEnabled = document.querySelector('meta[name="decupa-drive-enabled"]')?.getAttribute("content") === "true";

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function projectHref(id) {
  return new URL(["projects", encodeURIComponent(id)].join("/") + "/", window.location.origin).pathname;
}

function rootPath(...parts) {
  return new URL(parts.join("/"), window.location.origin).pathname;
}

function age(timestamp) {
  return Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
}

function reservationLabel(reservation) {
  if (!reservation) return "Livre";
  return `Editando: ${reservation.nome} · há ${age(reservation.ultimoSinal)} s`;
}

function changedLabel(timestamp) {
  return new Date(timestamp).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

function visibleProjects() {
  const query = nameFilter.value.trim().toLocaleLowerCase();
  const flow = flowFilter.value;
  return state.projects.filter((project) => {
    const sameName = !query || project.nome.toLocaleLowerCase().includes(query);
    return sameName && (flow === "todos" || project.fluxo === flow);
  });
}

function render() {
  const projects = visibleProjects();
  projectsElement.innerHTML = projects.map((project) => {
    const flowLabel = project.fluxo === "montagem" ? "Montagem" : "Limpeza";
    const problem = project.problema ? `<div class="problem">Problema: ${escapeHtml(project.problema)}</div>` : "";
    return `<a class="project-card" href="${projectHref(project.id)}">
      <div class="card-top"><span class="badge ${project.fluxo === "limpeza" ? "clean" : ""}">${flowLabel}</span>
        <span class="${project.reserva ? "reservation" : "free"}">${escapeHtml(reservationLabel(project.reserva))}</span></div>
      <div class="card-title">${escapeHtml(project.nome)}</div>
      <div class="card-bottom"><span>Última alteração</span><time datetime="${new Date(project.atualizadoEm).toISOString()}">${changedLabel(project.atualizadoEm)}</time></div>
      ${problem}
    </a>`;
  }).join("");
  const isEmpty = projects.length === 0;
  emptyElement.hidden = !isEmpty;
  // O erro da última carga fica visível até uma carga dar certo.
  if (statusElement.classList.contains("error")) return;
  if (state.projects.length > 0 && isEmpty) statusElement.textContent = "Nenhum Projeto corresponde aos filtros.";
  else statusElement.textContent = state.projects.length === 1 ? "1 Projeto" : `${state.projects.length} Projetos`;
}

async function load() {
  // Uma sondagem lenta não pode sobrescrever a lista de uma mais nova.
  const token = ++state.loadToken;
  try {
    const response = await fetch(rootPath("api", "projects"), { cache: "no-store" });
    if (!response.ok) throw new Error("Não foi possível carregar os Projetos.");
    const projects = await response.json();
    if (token !== state.loadToken) return;
    if (!Array.isArray(projects)) throw new Error("Resposta inválida do servidor.");
    state.projects = projects;
    statusElement.classList.remove("error");
    render();
  } catch (error) {
    if (token !== state.loadToken) return;
    statusElement.classList.add("error");
    statusElement.textContent = error instanceof Error ? error.message : "Não foi possível carregar os Projetos.";
  }
}

function startPolling() {
  if (state.timer === null && !document.hidden) state.timer = window.setInterval(() => { void load(); }, 10_000);
}

function stopPolling() {
  if (state.timer !== null) { window.clearInterval(state.timer); state.timer = null; }
}

/* ---- Gaveta Novo Projeto ---- */

// A lista da gaveta é refeita a cada progresso: o foco volta para o mesmo botão
// pelo `data-foco`, ou cai na entrada de arquivos se o botão deixou de existir.
function focoDentro(container) {
  if (!container.contains(document.activeElement)) return null;
  return document.activeElement.dataset.foco ?? "";
}

function restaurarFoco(container, foco) {
  if (foco === null) return;
  const alvo = [...container.querySelectorAll("[data-foco]")].find((element) => element.dataset.foco === foco);
  (alvo ?? fileInput).focus();
}

function definirTexto(element, texto) {
  // Regravar o mesmo texto reanuncia o alerta no leitor de tela a cada progresso.
  if (element.textContent !== texto) element.textContent = texto;
}

function renderQueue(visao) {
  const foco = focoDentro(queueElement);
  queueElement.innerHTML = visao.itens.map((item) => {
    const chave = escapeHtml(item.chave);
    const nome = escapeHtml(item.nome);
    const mostraProgresso = (item.origem === "envio" || item.origem === "drive")
      && (item.estado === "enviando" || item.estado === "pausado" || item.estado === "aguardando");
    return `<li class="media-item">
      <div class="media-item-top"><span class="media-item-name">${nome}</span><span class="media-item-state">${escapeHtml(item.texto)}</span></div>
      ${mostraProgresso ? `<progress max="100" value="${Math.round(item.percent)}" aria-label="Progresso de ${nome}"></progress>` : ""}
      ${item.mensagem ? `<p class="form-error">${escapeHtml(item.mensagem)}</p>` : ""}
      <div class="media-item-actions">
        ${item.estado === "erro" ? `<button type="button" data-acao="tentar" data-chave="${chave}" data-foco="tentar:${chave}">Tentar de novo</button>` : ""}
        <button type="button" data-acao="remover" data-chave="${chave}" data-foco="remover:${chave}">Remover<span class="sr-only"> ${nome}</span></button>
      </div>
    </li>`;
  }).join("");
  restaurarFoco(queueElement, foco);
}

function renderLibrary(visao) {
  const foco = focoDentro(libraryElement);
  const noProjeto = new Set(visao.midiaIds);
  libraryElement.innerHTML = state.acervo.map((midia) => {
    const id = escapeHtml(midia.id);
    const nome = escapeHtml(midia.nome);
    const rotulo = noProjeto.has(midia.id) ? "Já no Projeto" : "Adicionar";
    return `<li>
      <span class="library-name">${nome}</span>
      <span class="library-meta">${escapeHtml(formatarDuracao(midia.duracao))}</span>
      <button type="button" data-acao="adicionar" data-midia="${id}" data-foco="adicionar:${id}">${rotulo}<span class="sr-only"> ${nome}</span></button>
    </li>`;
  }).join("");
  restaurarFoco(libraryElement, foco);
}

function renderGaveta(visao) {
  // O aviso de saída só vale enquanto há bytes indo para o servidor.
  atualizarAvisoDeSaida(visao.emAndamento);
  const erroDoNome = visao.erro?.campo === "nome" ? visao.erro.mensagem : "";
  definirTexto(nameError, erroDoNome);
  nameError.hidden = !erroDoNome;
  nameInput.setAttribute("aria-invalid", String(Boolean(erroDoNome)));
  const erroGeral = visao.erro?.campo === "aviso" ? visao.erro.mensagem : "";
  definirTexto(formError, erroGeral);
  formError.hidden = !erroGeral;
  fileInput.multiple = visao.fluxo === "montagem";
  midiasRule.textContent = visao.fluxo === "limpeza" ? "Exatamente uma Mídia." : "Uma ou mais Mídias.";
  renderQueue(visao);
  renderLibrary(visao);
  mediaEmpty.hidden = visao.itens.length > 0;
  definirTexto(uploadStatus, textoDoResumo(visao));
  pauseButton.hidden = !(visao.emAndamento || visao.podeRetomar);
  pauseButton.textContent = visao.emAndamento ? "Pausar envio" : "Retomar envio";
  createButton.disabled = visao.criando || !mediaEnabled;
  createButton.textContent = visao.criando ? "Criando…" : "Criar Projeto";
}

function avisarAoSair(event) {
  event.preventDefault();
  event.returnValue = "";
}

function atualizarAvisoDeSaida(emAndamento) {
  if (emAndamento) window.addEventListener("beforeunload", avisarAoSair);
  else window.removeEventListener("beforeunload", avisarAoSair);
}

async function enviarCriacao(corpo) {
  const response = await fetch(rootPath("project", "new"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body.url !== "string") {
    throw Object.assign(new Error(body.error || ""), { status: response.ok ? 500 : response.status });
  }
  return body;
}

async function carregarAcervo() {
  if (!mediaEnabled) return;
  const token = ++state.acervoToken;
  try {
    const response = await fetch(rootPath("api", "media"), { cache: "no-store" });
    const media = await response.json().catch(() => null);
    if (!response.ok || !Array.isArray(media)) throw new Error("Não foi possível carregar o acervo.");
    if (token !== state.acervoToken) return;
    state.acervo = media;
    libraryStatus.textContent = media.length ? "" : "O acervo ainda não tem Mídias.";
    renderLibrary(gaveta.instantanea());
  } catch (error) {
    if (token !== state.acervoToken) return;
    libraryStatus.textContent = error instanceof Error ? error.message : "Não foi possível carregar o acervo.";
  }
}

const gaveta = criarGaveta({
  criarEnvio: ({ onProgress }) => new ResumableMediaUpload({ onProgress }),
  criarImportacaoDrive: ({ onProgress }) => new DriveMediaImport({ onProgress }),
  chaveDoArquivo: uploadFingerprint,
  enviarCriacao,
  onCriado: (url) => window.location.assign(url),
  onChange: renderGaveta,
  onMidiaPublicada: () => { void carregarAcervo(); },
});

function openDialog() {
  if (!dialog.open) dialog.showModal();
  const visao = gaveta.instantanea();
  nameInput.value = visao.nome;
  for (const input of flowInputs) input.checked = input.value === visao.fluxo;
  renderGaveta(visao);
  nameInput.focus();
  void carregarAcervo();
}

// Fechar com envio em andamento pede confirmação; a fila pausa ao fechar (ver `fechar` em gaveta.js).
function pedirFechamento() {
  const emAndamento = gaveta.instantanea().emAndamento;
  if (emAndamento && !window.confirm("Há um envio em andamento. Ao fechar, ele é pausado e pode ser retomado depois.")) return;
  dialog.close();
}

document.getElementById("newProject").addEventListener("click", openDialog);
document.getElementById("emptyNewProject").addEventListener("click", openDialog);
document.getElementById("closeDialog").addEventListener("click", pedirFechamento);
document.getElementById("cancelDialog").addEventListener("click", pedirFechamento);
// Esc chega como `cancel`: com envio em andamento, passa pelo aviso antes de fechar.
dialog.addEventListener("cancel", (event) => {
  if (!gaveta.instantanea().emAndamento) return;
  event.preventDefault();
  pedirFechamento();
});
dialog.addEventListener("close", () => gaveta.fechar());
for (const input of flowInputs) {
  input.addEventListener("change", () => {
    if (input.checked) gaveta.definirFluxo(input.value);
  });
}
nameInput.addEventListener("input", () => gaveta.definirNome(nameInput.value));
fileInput.addEventListener("change", () => {
  const arquivos = [...fileInput.files];
  // Zerar a entrada deixa escolher o mesmo arquivo de novo depois de removê-lo.
  fileInput.value = "";
  gaveta.adicionarArquivos(arquivos);
});
driveImport.hidden = !(mediaEnabled && driveEnabled);
driveAdd.addEventListener("click", () => {
  gaveta.adicionarDriveUrl(driveUrl.value);
  if (!gaveta.instantanea().erro) driveUrl.value = "";
});
driveUrl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    driveAdd.click();
  }
});
queueElement.addEventListener("click", (event) => {
  const botao = event.target.closest("button[data-acao]");
  if (botao?.dataset.acao === "remover") gaveta.remover(botao.dataset.chave);
  if (botao?.dataset.acao === "tentar") gaveta.tentarDeNovo(botao.dataset.chave);
});
libraryElement.addEventListener("click", (event) => {
  const botao = event.target.closest("button[data-acao='adicionar']");
  const midia = state.acervo.find((item) => item.id === botao?.dataset.midia);
  if (midia) gaveta.adicionarDoAcervo(midia);
});
pauseButton.addEventListener("click", () => {
  if (gaveta.instantanea().emAndamento) gaveta.pausar();
  else gaveta.retomar();
});
form.addEventListener("submit", (event) => {
  event.preventDefault();
  gaveta.criar();
  if (gaveta.instantanea().erro?.campo === "nome") nameInput.focus();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopPolling();
  else { void load(); startPolling(); }
});
nameFilter.addEventListener("input", render);
flowFilter.addEventListener("change", render);

fileInput.disabled = !mediaEnabled;
if (!mediaEnabled) libraryStatus.textContent = "O acervo de Mídias não está configurado neste servidor.";
void load();
startPolling();
