function stackToast(banner) {
  // Mede as quebras de linha reais, inclusive quando a janela é estreita.
  document.documentElement.style.setProperty("--visual-notice-height", `${banner.hidden ? 0 : banner.getBoundingClientRect().height}px`);
}
export async function refreshVisualNotice() {
  const banner = document.getElementById("visual-provider-notice");
  if (!banner) return;
  try {
    const response = await fetch("/provider/keys", { headers: { accept: "application/json" } });
    if (!response.ok) return;
    const state = await response.json();
    banner.querySelector("a").textContent = state.notice ?? "";
    banner.hidden = !state.notice;
    stackToast(banner);
  } catch { /* O aviso inicial do servidor continua válido durante desconexão. */ }
}
void refreshVisualNotice();
window.addEventListener("focus", refreshVisualNotice);
const banner = document.getElementById("visual-provider-notice");
if (banner && typeof ResizeObserver !== "undefined") new ResizeObserver(() => stackToast(banner)).observe(banner);
