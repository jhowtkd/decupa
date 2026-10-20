const $ = (id) => document.getElementById(id);
const bytes = (value) => {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const unit = Math.min(units.length - 1, Math.floor(Math.log(Math.max(1, value)) / Math.log(1024)));
  return `${(value / 1024 ** unit).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} ${units[unit]}`;
};
const date = (value) => new Date(value).toLocaleString("pt-BR");
let selected;
let sending = false;
async function request(url, options) {
  const response = await fetch(url, options); const value = await response.json();
  if (!response.ok) throw new Error(value.error || "Não foi possível conferir as referências.");
  return value;
}
function textElement(tag, text) { const element = document.createElement(tag); element.textContent = text; return element; }
function controls() { $("confirm").disabled = sending || !selected?.eligible || !$("agree").checked || (Boolean(selected.warning) && !$("offline").checked); }
function clearPlan() { selected = undefined; $("plan").hidden = true; $("agree").checked = false; $("offline").checked = false; controls(); }
async function load() {
  const projects = await request("/api/cleanup/projects"); $("projects").replaceChildren();
  for (const project of projects) {
    const row = document.createElement("article"); row.className = "project";
    const copy = document.createElement("div"); copy.append(textElement("h2", project.name));
    copy.append(textElement("p", project.problem ? `Limpeza bloqueada: ${project.problem}` : `${project.state}${project.expiresAt ? ` · Prazo: ${date(project.expiresAt)}` : " · Aguardando entrega confirmada"}`));
    const button = textElement("button", project.eligible ? "Revisar limpeza" : "Ver arquivos protegidos"); button.type = "button";
    button.disabled = Boolean(project.problem); button.addEventListener("click", () => showPlan(project).catch(showError));
    row.append(copy, button); $("projects").append(row);
  }
  $("status").textContent = projects.length ? "Confira o prazo e revise os arquivos antes de confirmar." : "Nenhum Projeto de montagem nesta Raiz.";
}
async function showPlan(project) {
  clearPlan(); const plan = await request(`/api/cleanup/projects/${encodeURIComponent(project.id)}/plan`); selected = { ...plan, id: project.id };
  $("planTitle").textContent = `Revisar limpeza · ${project.name}`;
  $("summary").textContent = `${plan.cleaned ? "Arquivos já limpos" : plan.eligible ? "Elegível" : "Protegido neste momento"}${plan.expiresAt ? ` · Prazo: ${date(plan.expiresAt)}` : ""} · ${plan.items.length} arquivo(s) · ${bytes(plan.recoverableBytes)} recuperáveis. Hardlinks e arquivos compartilhados são contados uma vez.`;
  $("items").replaceChildren(...plan.items.map(item => textElement("li", `${item.kind} · ${item.path} · ${bytes(item.recoverableBytes)} recuperáveis`)));
  if (!plan.items.length) $("items").append(textElement("li", "Nenhum arquivo removível."));
  $("preserved").replaceChildren(...plan.preserved.map(item => textElement("li", `${item.path} — ${item.reason}`)));
  $("preservedTitle").textContent = `${plan.preserved.length} arquivo(s) preservado(s)`;
  $("warning").hidden = !plan.warning; $("warning").textContent = plan.warning ?? ""; $("offlineLabel").hidden = !plan.warning;
  $("confirmation").hidden = !plan.eligible; $("plan").hidden = false; controls(); $("plan").scrollIntoView({ behavior: "smooth", block: "start" });
}
function showError(error) { $("status").textContent = error.message; }
$("agree").addEventListener("change", controls); $("offline").addEventListener("change", controls); $("cancel").addEventListener("click", clearPlan);
$("confirmation").addEventListener("submit", async event => {
  event.preventDefault(); if ($("confirm").disabled || !selected) return;
  const plan = selected; sending = true; controls(); $("cancel").disabled = true;
  try {
    await request(`/api/cleanup/projects/${encodeURIComponent(plan.id)}/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ planId: plan.planId, confirmed: $("agree").checked, acknowledgeOffline: $("offline").checked }) });
    clearPlan(); await load(); $("status").textContent = "Limpeza concluída. O acervo e os arquivos compartilhados foram preservados.";
  } catch (error) { clearPlan(); showError(error); }
  finally { sending = false; $("cancel").disabled = false; controls(); }
});
void load().catch(showError);
