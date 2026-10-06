import { readFile } from "node:fs/promises";
import { Script } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { keyProviderState, withVisualNotice } from "./provider-visual.ts";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
function documentStub() {
  const elements = new Map<string, any>();
  const getElementById = (id: string) => {
    if (!elements.has(id)) elements.set(id, { value: "", checked: false, textContent: "", querySelector: () => ({ disabled: false }) });
    return elements.get(id)!;
  };
  return { getElementById };
}

it("primeira tela envia as chaves opcionais e as escolhas reais do formulário", async () => {
  const html = await readFile(new URL("./provider-setup.html", import.meta.url), "utf8"), document = documentStub();
  let reloads = 0; const bodies: any[] = [];
  const fetch = async (_url: string, opts: RequestInit) => { bodies.push(JSON.parse(String(opts.body))); return new Response('{"configured":true}'); };
  new Script(html.match(/<script>([\s\S]*?)<\/script>/)![1]!).runInNewContext({ document, fetch, location: { reload: () => reloads++ } });
  for (const [id, value] of Object.entries({ preset: "custom", key: "muse", model: "muse", endpoint: "https://meta.example/v1", openaiKey: "luna", jevKey: "jev" })) document.getElementById(id).value = value;
  await document.getElementById("setup").onsubmit({ preventDefault() {} });
  expect(bodies[0]).toMatchObject({ apiKey: "muse", openaiApiKey: "luna", visualProvider: "openai", typesafeApiKey: "jev", typesafe: true });
  expect(document.getElementById("openaiKey").value).toBe(""); expect(document.getElementById("jevKey").value).toBe(""); expect(reloads).toBe(1);
  document.getElementById("textImages").checked = true; document.getElementById("noJev").checked = true;
  await document.getElementById("setup").onsubmit({ preventDefault() {} });
  expect(bodies[1]).toMatchObject({ visualProvider: "text", typesafe: false });
});

it("primeira tela em branco omite consentimento e chave Jev", async () => {
  const html = await readFile(new URL("./provider-setup.html", import.meta.url), "utf8"), document = documentStub();
  const bodies: any[] = [];
  const fetch = async (_url: string, opts: RequestInit) => { bodies.push(JSON.parse(String(opts.body))); return new Response('{"configured":true}'); };
  new Script(html.match(/<script>([\s\S]*?)<\/script>/)![1]!).runInNewContext({ document, fetch, location: { reload() {} } });
  await document.getElementById("setup").onsubmit({ preventDefault() {} });
  expect(bodies[0]).not.toHaveProperty("typesafe"); expect(bodies[0]).not.toHaveProperty("typesafeApiKey");
  document.getElementById("noJev").checked = true;
  await document.getElementById("setup").onsubmit({ preventDefault() {} });
  expect(bodies[1]).toHaveProperty("typesafe", false);
});

it("página de chaves salva cada seção sem reenviar a outra chave", async () => {
  const html = await readFile(new URL("./provider-keys.html", import.meta.url), "utf8"), document = documentStub();
  const bodies: any[] = [], state = keyProviderState({}, { preset: "zai", openaiApiKey: "hidden", typesafeApiKey: "hidden", typesafe: true });
  const fetch = async (_url: string, opts?: RequestInit) => { if (opts?.method === "POST") bodies.push(JSON.parse(String(opts.body))); return new Response(JSON.stringify(state)); };
  new Script(html.match(/<script>([\s\S]*?)<\/script>/)![1]!).runInNewContext({ document, fetch });
  await new Promise(resolve => setImmediate(resolve));
  document.getElementById("openaiKey").value = "luna-new"; document.getElementById("jevKey").value = "jev-new";
  for (const section of ["visual", "jev"]) await document.getElementById(section).onsubmit({ preventDefault() {}, target: document.getElementById(section) });
  expect(bodies).toEqual([{ section: "visual", openaiApiKey: "luna-new", visualProvider: "openai" }, { section: "jev", typesafeApiKey: "jev-new", typesafe: true }]);
  expect(document.getElementById("state").textContent).toContain("GPT-6 Luna configurado");
  expect(document.getElementById("jevState").textContent).toContain("Jev configurado");
  for (const id of ["removeVisual", "removeJev"]) await document.getElementById(id).onclick();
  expect(bodies.slice(2)).toEqual([{ section: "visual", removeKey: true }, { section: "jev", removeKey: true }]);
});

it("select do texto da Montagem reflete o estado e envia a escolha junto da visão", async () => {
  const html = await readFile(new URL("./provider-keys.html", import.meta.url), "utf8"), document = documentStub();
  const bodies: any[] = [];
  const state = keyProviderState({}, { preset: "zai", openaiApiKey: "hidden", assemblyTextProvider: "openai" });
  const fetch = async (_url: string, opts?: RequestInit) => { if (opts?.method === "POST") bodies.push(JSON.parse(String(opts.body))); return new Response(JSON.stringify(state)); };
  new Script(html.match(/<script>([\s\S]*?)<\/script>/)![1]!).runInNewContext({ document, fetch });
  await new Promise(resolve => setImmediate(resolve));
  expect(document.getElementById("assemblyText").value).toBe("openai");
  expect(document.getElementById("assemblyTextState").textContent).toContain("GPT-6.1 Sol");
  document.getElementById("assemblyText").value = "text";
  document.getElementById("openaiKey").value = "luna-new";
  await document.getElementById("visual").onsubmit({ preventDefault() {}, target: document.getElementById("visual") });
  expect(bodies).toEqual([{ section: "visual", openaiApiKey: "luna-new", visualProvider: "openai", assemblyTextProvider: "text" }]);
});

it("select do texto da Montagem cai para o rótulo 'provedor de texto' quando a chave da OpenAI falta", async () => {
  const html = await readFile(new URL("./provider-keys.html", import.meta.url), "utf8"), document = documentStub();
  const state = keyProviderState({}, { preset: "zai", assemblyTextProvider: "openai" });
  const fetch = async () => new Response(JSON.stringify(state));
  new Script(html.match(/<script>([\s\S]*?)<\/script>/)![1]!).runInNewContext({ document, fetch });
  await new Promise(resolve => setImmediate(resolve));
  expect(document.getElementById("assemblyText").value).toBe("openai");
  expect(document.getElementById("assemblyTextState").textContent).toContain("falta a chave OpenAI");
});

it("escolher Sol, remover a chave e salvar só a visão omite a escolha conservada", async () => {
  const html = await readFile(new URL("./provider-keys.html", import.meta.url), "utf8"), document = documentStub();
  let stored: import("@decupa/triage").Credentials = { preset: "zai", typesafe: false };
  const bodies: any[] = [];
  const fetch = async (_url: string, opts?: RequestInit) => {
    if (opts?.method === "POST") {
      const body = JSON.parse(String(opts.body)); bodies.push(body);
      if (body.removeKey) delete stored.openaiApiKey;
      else {
        stored = { ...stored, visualProvider: body.visualProvider };
        if (body.openaiApiKey) stored.openaiApiKey = body.openaiApiKey;
        if (body.assemblyTextProvider) stored.assemblyTextProvider = body.assemblyTextProvider;
      }
    }
    return new Response(JSON.stringify(keyProviderState({}, stored)));
  };
  new Script(html.match(/<script>([\s\S]*?)<\/script>/)![1]!).runInNewContext({ document, fetch });
  await new Promise(resolve => setImmediate(resolve));
  const submit = () => document.getElementById("visual").onsubmit({ preventDefault() {}, target: document.getElementById("visual") });
  document.getElementById("assemblyText").value = "openai";
  document.getElementById("openaiKey").value = "fake-key-1234567890123";
  await submit(); expect(bodies[0]).toHaveProperty("assemblyTextProvider", "openai");
  await document.getElementById("removeVisual").onclick();
  expect(document.getElementById("assemblyText").value).toBe("openai");
  expect(document.getElementById("assemblyTextState").textContent).toContain("falta a chave OpenAI");
  document.getElementById("textImages").checked = true;
  await submit();
  expect(bodies[2]).toEqual({ section: "visual", openaiApiKey: "", visualProvider: "text" });
  expect(stored).toMatchObject({ visualProvider: "text", assemblyTextProvider: "openai" });
  expect(document.getElementById("message").textContent).toContain("Configuração salva");
});

it("banner atualiza o aviso e some após a configuração", async () => {
  let height = 96;
  const setProperty = vi.fn(), link = { textContent: "" }, banner = { hidden: false, querySelector: () => link, getBoundingClientRect: () => ({ height }) };
  let state = keyProviderState({}, null);
  vi.stubGlobal("document", { getElementById: () => banner, documentElement: { style: { setProperty } } }); vi.stubGlobal("window", { addEventListener: vi.fn() });
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(state)));
  const { refreshVisualNotice } = await import("./visual-notice.js"); await refreshVisualNotice();
  expect(link.textContent).toBe("Chaves de IA pendentes: Luna, Jev →"); expect(banner.hidden).toBe(false);
  expect(setProperty).toHaveBeenLastCalledWith("--visual-notice-height", "96px");
  height = 144; await refreshVisualNotice();
  expect(setProperty).toHaveBeenLastCalledWith("--visual-notice-height", "144px");
  state = keyProviderState({}, { preset: "zai", visualProvider: "text", typesafe: false }); await refreshVisualNotice();
  expect(banner.hidden).toBe(true); expect(link.textContent).toBe("");
  expect(setProperty).toHaveBeenLastCalledWith("--visual-notice-height", "0px");
});

it("credencial antiga não marca Não usar: a tela permite ativar o Jev sem reenviar a chave", async () => {
  const html = await readFile(new URL("./provider-keys.html", import.meta.url), "utf8"), document = documentStub();
  const state = keyProviderState({}, { preset: "zai", visualProvider: "text", typesafeApiKey: "legacy-hidden-key" });
  const bodies: unknown[] = [];
  const fetch = async (_url: string, opts?: RequestInit) => { if (opts?.method === "POST") bodies.push(JSON.parse(String(opts.body))); return new Response(JSON.stringify(state)); };
  new Script(html.match(/<script>([\s\S]*?)<\/script>/)![1]!).runInNewContext({ document, fetch });
  await new Promise(resolve => setImmediate(resolve));
  expect(document.getElementById("noJev").checked).toBe(false);
  expect(document.getElementById("jevState").textContent).toContain("ative o Jev");
  expect(document.getElementById("jevKey").value).toBe("");
  await document.getElementById("jev").onsubmit({ preventDefault() {}, target: document.getElementById("jev") });
  expect(bodies).toEqual([{ section: "jev", typesafeApiKey: "", typesafe: true }]);
});

it("Limpeza empilha o toast acima da altura medida do aviso, sem mudar a posição quando oculto", async () => {
  const page = await readFile(new URL("./page.html", import.meta.url), "utf8");
  const html = withVisualNotice(page, "Chaves de IA pendentes: Luna, Jev →");
  expect(html).toMatch(/#toast\s*\{[^}]*z-index:\s*40/s);
  expect(html).toMatch(/#visual-provider-notice\{[^}]*z-index:35/);
  expect(html).toContain("body:has(#visual-provider-notice:not([hidden])) #toast{bottom:calc(32px + var(--visual-notice-height,64px))}");
  expect(withVisualNotice(page, null)).toContain('id="visual-provider-notice" role="status" hidden');
});
