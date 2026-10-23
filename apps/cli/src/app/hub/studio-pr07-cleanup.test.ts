// Limpar arquivos (PR 7): o mesmo cleanup.js roda sobre a legacy e sobre o shell
// do studio. A lista do que sai aparece antes e a remoção só é pedida depois
// das confirmações.
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installDom, type El } from "../assembly/editor/fake-dom.test-helper.ts";

const ler = (arquivo: string) => readFile(new URL(arquivo, import.meta.url), "utf8");
const corpoSemScript = (html: string) => html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>")).replace(/<script\b[\s\S]*?<\/script>/g, "");
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); };

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); });

const VARIANTES = [["legacy", "cleanup.html"], ["studio", "cleanup-studio.html"]] as const;

describe.each(VARIANTES)("%s", (_nome, arquivo) => {
  it("o HTML lista os afetados (#items) antes da confirmação e o #confirm nasce desabilitado", async () => {
    const html = await ler(arquivo);
    for (const depois of ['id="confirmation"', 'id="confirm"']) expect(html.indexOf('id="items"')).toBeLessThan(html.indexOf(depois));
    expect(html).toMatch(/<button id="confirm"[^>]*\sdisabled/);
    expect(html.match(/<script\b[^>]*\ssrc=["']([^"']+)["']/g)).toHaveLength(1);
    expect(html).toContain('src="/hub/cleanup.js"');
  });

  async function monta(warning?: string) {
    const document = installDom(corpoSemScript(await ler(arquivo)));
    const chamadas: Array<{ url: string; method: string; body?: string }> = [];
    const fetchFalso = vi.fn(async (url: string, opts?: { method?: string; body?: string }) => {
      chamadas.push({ url, method: opts?.method ?? "GET", body: opts?.body });
      const json = (value: unknown) => ({ ok: true, json: async () => value });
      if (url === "/api/cleanup/projects") return json([{ id: "alpha", name: "Alpha", state: "entregue", eligible: true, expiresAt: 1_700_000_000_000 }]);
      if (url.endsWith("/plan")) return json({ planId: "plano-1", eligible: true, cleaned: false, recoverableBytes: 2048, expiresAt: 1_700_000_000_000, warning, preserved: [{ path: "acervo/a.mp4", reason: "acervo" }], items: [{ kind: "proxy", path: "exports/1/x.mp4", recoverableBytes: 2048 }] });
      if (url.endsWith("/confirm")) return json({ ok: true });
      throw new Error("rota inesperada " + url);
    });
    vi.stubGlobal("fetch", fetchFalso);
    (document.getElementById("plan") as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
    vi.resetModules();
    // O cleanup.js é script de página, sem tipos de módulo.
    const caminho = "./cleanup.js";
    await import(/* @vite-ignore */ caminho);
    await flush();
    return { document, chamadas };
  }
  const el = (d: ReturnType<typeof installDom>, id: string) => d.getElementById(id) as El;

  it("só habilita o confirmar com a revisão marcada e só então envia o POST /confirm", async () => {
    const { document, chamadas } = await monta();
    document.querySelector("#projects button")!.click();
    await flush();
    expect(el(document, "plan").hidden).toBe(false);
    expect(el(document, "items").children.map((c) => c.textContent).join()).toContain("exports/1/x.mp4");
    expect(el(document, "confirm").disabled).toBe(true);
    // Tentar enviar antes de marcar não pede nada ao servidor.
    el(document, "confirmation").dispatchEvent({ type: "submit" });
    await flush();
    expect(chamadas.some((c) => c.url.endsWith("/confirm"))).toBe(false);
    el(document, "agree").checked = true;
    el(document, "agree").dispatchEvent({ type: "change" });
    expect(el(document, "confirm").disabled).toBe(false);
    expect(chamadas.some((c) => c.url.endsWith("/confirm"))).toBe(false);
    el(document, "confirmation").dispatchEvent({ type: "submit" });
    await flush();
    const post = chamadas.find((c) => c.url.endsWith("/confirm"));
    expect(post).toMatchObject({ method: "POST", url: "/api/cleanup/projects/alpha/confirm" });
    expect(JSON.parse(post!.body!)).toEqual({ planId: "plano-1", confirmed: true, acknowledgeOffline: false });
    // Concluída a limpeza o plano some e o confirmar volta a ficar desabilitado.
    expect(el(document, "plan").hidden).toBe(true);
    expect(el(document, "confirm").disabled).toBe(true);
  });

  it("com aviso de offline o confirmar exige também o #offline", async () => {
    const { document, chamadas } = await monta("Timelines podem ficar offline.");
    document.querySelector("#projects button")!.click();
    await flush();
    expect(el(document, "offlineLabel").hidden).toBe(false);
    expect(el(document, "warning").textContent).toContain("offline");
    el(document, "agree").checked = true;
    el(document, "agree").dispatchEvent({ type: "change" });
    expect(el(document, "confirm").disabled).toBe(true);
    el(document, "confirmation").dispatchEvent({ type: "submit" });
    await flush();
    expect(chamadas.some((c) => c.url.endsWith("/confirm"))).toBe(false);
    el(document, "offline").checked = true;
    el(document, "offline").dispatchEvent({ type: "change" });
    expect(el(document, "confirm").disabled).toBe(false);
    el(document, "confirmation").dispatchEvent({ type: "submit" });
    await flush();
    const post = chamadas.find((c) => c.url.endsWith("/confirm"));
    expect(JSON.parse(post!.body!)).toMatchObject({ confirmed: true, acknowledgeOffline: true });
  });

  it("Cancelar descarta o plano sem pedir remoção", async () => {
    const { document, chamadas } = await monta();
    document.querySelector("#projects button")!.click();
    await flush();
    el(document, "agree").checked = true;
    el(document, "agree").dispatchEvent({ type: "change" });
    el(document, "cancel").click();
    expect(el(document, "plan").hidden).toBe(true);
    expect(el(document, "confirm").disabled).toBe(true);
    expect(chamadas.some((c) => c.url.endsWith("/confirm"))).toBe(false);
  });
});
