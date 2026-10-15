const form = document.querySelector("#loginForm");
const error = document.querySelector("#error");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.hidden = true;
  const data = new FormData(form);
  const response = await fetch(`/login${location.search}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ nome: data.get("nome"), senha: data.get("senha") }),
  });
  if (response.redirected) {
    location.assign(response.url);
    return;
  }
  if (response.ok) { location.assign("/"); return; }
  error.textContent = (await response.json().catch(() => null))?.error || "Não foi possível entrar.";
  error.hidden = false;
});
