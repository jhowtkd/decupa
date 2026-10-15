const state = { projects: [], timer: null, loadToken: 0 };
const projectsElement = document.getElementById("projects");
const statusElement = document.getElementById("status");
const emptyElement = document.getElementById("empty");
const nameFilter = document.getElementById("nameFilter");
const flowFilter = document.getElementById("flowFilter");
const dialog = document.getElementById("newProjectDialog");
const form = document.getElementById("newProjectForm");
const formError = document.getElementById("formError");

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

function openDialog() {
  formError.hidden = true;
  dialog.showModal();
  document.getElementById("projectName").focus();
}

document.getElementById("newProject").addEventListener("click", openDialog);
document.getElementById("emptyNewProject").addEventListener("click", openDialog);
document.getElementById("closeDialog").addEventListener("click", () => dialog.close());
document.getElementById("cancelDialog").addEventListener("click", () => dialog.close());
nameFilter.addEventListener("input", render);
flowFilter.addEventListener("change", render);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopPolling();
  else { void load(); startPolling(); }
});
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  formError.hidden = true;
  const data = new FormData(form);
  const response = await fetch(rootPath("project", "new"), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ nome: data.get("nome"), fluxo: data.get("fluxo") }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    formError.textContent = body.error || "Não foi possível criar o Projeto.";
    formError.hidden = false;
    return;
  }
  window.location.assign(body.url);
});

void load();
startPolling();
