import { readFile } from "node:fs/promises";
import { Script } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { keyProviderState, withVisualNotice } from "./provider-visual.ts";
import { textProviderState } from "./settings-text.ts";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
function documentStub() {
  const elements = new Map<string, any>();
  const getElementById = (id: string) => {
    if (!elements.has(id)) elements.set(id, { value: "", checked: false, textContent: "", required: false, disabled: false, querySelector: () => ({ disabled: false }) });
    return elements.get(id)!;
  };
  return { getElementById };
}
async function settingsScript() {
  const html = await readFile(new URL("./settings.html", import.meta.url), "utf8");
  return html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
}
function completeSettingsState(stored: import("@decupa/triage").Credentials) {
  return { ...keyProviderState({}, stored), text: textProviderState({}, stored) };
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

it("tela de configurações salva cada seção sem reenviar a outra chave (OpenAI e Jev via jevForm)", async () => {
  const script = await settingsScript(), document = documentStub();
  const bodies: any[] = [], state = keyProviderState({}, { preset: "zai", openaiApiKey: "hidden", typesafeApiKey: "hidden", typesafe: true });
  const fetch = async (_url: string, opts?: RequestInit) => { if (opts?.method === "POST") bodies.push(JSON.parse(String(opts.body))); return new Response(JSON.stringify(state)); };
  new Script(script).runInNewContext({ document, fetch });
  await new Promise(resolve => setImmediate(resolve));
  document.getElementById("openaiKey").value = "luna-new"; document.getElementById("jevKey").value = "jev-new";
  await document.getElementById("visual").onsubmit({ preventDefault() {}, target: document.getElementById("visual") });
  await document.getElementById("jevForm").onsubmit({ preventDefault() {}, target: document.getElementById("jevForm") });
  expect(bodies).toEqual([{ section: "visual", openaiApiKey: "luna-new", visualProvider: "openai" }, { section: "jev", typesafeApiKey: "jev-new", typesafe: true }]);
  expect(document.getElementById("state").textContent).toContain("GPT-6 Luna configurado");
  expect(document.getElementById("jevState").textContent).toContain("Jev configurado");
  for (const id of ["removeVisual", "removeJev"]) await document.getElementById(id).onclick();
  expect(bodies.slice(2)).toEqual([{ section: "visual", removeKey: true }, { section: "jev", removeKey: true }]);
});

it("salvar a seção visual preserva os campos e a chave em memória da seção de texto", async () => {
  const script = await settingsScript(), document = documentStub();
  const state = completeSettingsState({ preset: "zai", apiKey: "hidden", model: "glm-5", baseUrl: "", openaiApiKey: "hidden", typesafe: true });
  const fetch = async (_url: string) => {
    return new Response(JSON.stringify(state));
  };
  new Script(script).runInNewContext({ document, fetch });
  await new Promise(resolve => setImmediate(resolve));
  Object.assign(document.getElementById("preset"), { value: "custom" });
  Object.assign(document.getElementById("model"), { value: "draft model" });
  Object.assign(document.getElementById("endpoint"), { value: "https://draft.example/v1" });
  Object.assign(document.getElementById("textKey"), { value: "draft-key-in-memory" });
  await document.getElementById("visual").onsubmit({ preventDefault() {}, target: document.getElementById("visual") });
  expect({
    preset: document.getElementById("preset").value,
    model: document.getElementById("model").value,
    endpoint: document.getElementById("endpoint").value,
    key: document.getElementById("textKey").value,
  }).toEqual({ preset: "custom", model: "draft model", endpoint: "https://draft.example/v1", key: "draft-key-in-memory" });
});

it.each(["text", "jev"] as const)("salvar %s não altera rascunhos das outras seções", async (saving) => {
  const script = await settingsScript(), document = documentStub();
  let stored: import("@decupa/triage").Credentials = { preset: "zai", model: "glm-5", openaiApiKey: "hidden", typesafeApiKey: "hidden", typesafe: true };
  const fetch = async (_url: string, opts?: RequestInit) => {
    if (opts?.method === "POST") {
      const { section: _section, ...fields } = JSON.parse(String(opts.body));
      stored = { ...stored, ...fields };
    }
    return new Response(JSON.stringify(completeSettingsState(stored)));
  };
  new Script(script).runInNewContext({ document, fetch });
  await new Promise(resolve => setImmediate(resolve));
  Object.assign(document.getElementById("preset"), { value: "custom" });
  Object.assign(document.getElementById("model"), { value: "draft text model" });
  Object.assign(document.getElementById("endpoint"), { value: "https://draft.example/v1" });
  Object.assign(document.getElementById("textKey"), { value: "text-key-in-memory" });
  Object.assign(document.getElementById("openaiKey"), { value: "visual-key-in-memory" });
  Object.assign(document.getElementById("textImages"), { checked: true });
  Object.assign(document.getElementById("assemblyText"), { value: "openai" });
  Object.assign(document.getElementById("jevKey"), { value: "jev-key-in-memory" });
  Object.assign(document.getElementById("noJev"), { checked: true });
  const target = saving === "text" ? "textForm" : "jevForm";
  await document.getElementById(target).onsubmit({ preventDefault() {}, target: document.getElementById(target) });
  expect({
    text: ["preset", "model", "endpoint", "textKey"].map(id => document.getElementById(id).value),
    visual: [document.getElementById("openaiKey").value, document.getElementById("textImages").checked, document.getElementById("assemblyText").value],
    jev: [document.getElementById("jevKey").value, document.getElementById("noJev").checked],
  }).toEqual({
    text: saving === "text" ? ["custom", "draft text model", "https://draft.example/v1", ""] : ["custom", "draft text model", "https://draft.example/v1", "text-key-in-memory"],
    visual: ["visual-key-in-memory", true, "openai"],
    jev: saving === "jev" ? ["", true] : ["jev-key-in-memory", true],
  });
});

it("edições feitas enquanto o POST está pendente sobrevivem à resposta da seção salva", async () => {
  const script = await settingsScript(), document = documentStub();
  const initial = completeSettingsState({ preset: "zai", model: "glm-5", openaiApiKey: "hidden", typesafeApiKey: "hidden", typesafe: true });
  let release!: (response: Response) => void;
  const fetch = async (_url: string, opts?: RequestInit) => opts?.method === "POST"
    ? await new Promise<Response>(resolve => { release = resolve; })
    : new Response(JSON.stringify(initial));
  new Script(script).runInNewContext({ document, fetch });
  await new Promise(resolve => setImmediate(resolve));
  document.getElementById("openaiKey").value = "submitted-key";
  const pending = document.getElementById("visual").onsubmit({ preventDefault() {}, target: document.getElementById("visual") });
  document.getElementById("openaiKey").value = "newer-key";
  document.getElementById("textKey").value = "newer-text-key";
  document.getElementById("model").value = "newer-model";
  release(new Response(JSON.stringify(completeSettingsState({ preset: "zai", model: "glm-5", openaiApiKey: "saved-key", typesafe: true }))));
  await pending;
  expect({ openai: document.getElementById("openaiKey").value, textKey: document.getElementById("textKey").value, model: document.getElementById("model").value })
    .toEqual({ openai: "newer-key", textKey: "newer-text-key", model: "newer-model" });
});

it("rascunhos de credenciais não chamam localStorage nem sessionStorage", async () => {
  const script = await settingsScript(), document = documentStub();
  const storageCalls: string[] = [];
  const storage = (name: string) => new Proxy({}, { get: (_target, method) => (..._args: unknown[]) => { storageCalls.push(`${name}.${String(method)}`); } });
  const fetch = async () => new Response(JSON.stringify(completeSettingsState({ preset: "zai", typesafe: true })));
  new Script(script).runInNewContext({ document, fetch, localStorage: storage("localStorage"), sessionStorage: storage("sessionStorage") });
  await new Promise(resolve => setImmediate(resolve));
  document.getElementById("textKey").value = "draft-secret";
  document.getElementById("jevKey").value = "draft-secret";
  expect(storageCalls).toEqual([]);
});

it("select do texto da Montagem reflete o estado e envia a escolha junto da visão", async () => {
  const script = await settingsScript(), document = documentStub();
  const bodies: any[] = [];
  const state = keyProviderState({}, { preset: "zai", openaiApiKey: "hidden", assemblyTextProvider: "openai" });
  const fetch = async (_url: string, opts?: RequestInit) => { if (opts?.method === "POST") bodies.push(JSON.parse(String(opts.body))); return new Response(JSON.stringify(state)); };
  new Script(script).runInNewContext({ document, fetch });
  await new Promise(resolve => setImmediate(resolve));
  expect(document.getElementById("assemblyText").value).toBe("openai");
  expect(document.getElementById("assemblyTextState").textContent).toContain("GPT-6.1 Sol");
  document.getElementById("assemblyText").value = "text";
  document.getElementById("openaiKey").value = "luna-new";
  await document.getElementById("visual").onsubmit({ preventDefault() {}, target: document.getElementById("visual") });
  expect(bodies).toEqual([{ section: "visual", openaiApiKey: "luna-new", visualProvider: "openai", assemblyTextProvider: "text" }]);
});

it("select do texto da Montagem cai para o rótulo 'provedor de texto' quando a chave da OpenAI falta", async () => {
  const script = await settingsScript(), document = documentStub();
  const state = keyProviderState({}, { preset: "zai", assemblyTextProvider: "openai" });
  const fetch = async () => new Response(JSON.stringify(state));
  new Script(script).runInNewContext({ document, fetch });
  await new Promise(resolve => setImmediate(resolve));
  expect(document.getElementById("assemblyText").value).toBe("openai");
  expect(document.getElementById("assemblyTextState").textContent).toContain("falta a chave OpenAI");
});

it("escolher Sol, remover a chave e salvar só a visão omite a escolha conservada", async () => {
  const script = await settingsScript(), document = documentStub();
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
  new Script(script).runInNewContext({ document, fetch });
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

it("credencial antiga não marca Não usar: a tela permite ativar o Jev sem reenviar a chave (jevForm)", async () => {
  const script = await settingsScript(), document = documentStub();
  const state = keyProviderState({}, { preset: "zai", visualProvider: "text", typesafeApiKey: "legacy-hidden-key" });
  const bodies: unknown[] = [];
  const fetch = async (_url: string, opts?: RequestInit) => { if (opts?.method === "POST") bodies.push(JSON.parse(String(opts.body))); return new Response(JSON.stringify(state)); };
  new Script(script).runInNewContext({ document, fetch });
  await new Promise(resolve => setImmediate(resolve));
  expect(document.getElementById("noJev").checked).toBe(false);
  expect(document.getElementById("jevState").textContent).toContain("ative o Jev");
  expect(document.getElementById("jevKey").value).toBe("");
  await document.getElementById("jevForm").onsubmit({ preventDefault() {}, target: document.getElementById("jevForm") });
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

it("provedor de texto: formulário envia preset/chave/modelo/endpoint sob section 'text'", async () => {
  const script = await settingsScript(), document = documentStub();
  const bodies: any[] = [];
  const state = { ...keyProviderState({}, { preset: "zai", apiKey: "hidden" }), text: textProviderState({}, { preset: "zai", apiKey: "hidden" }) };
  const fetch = async (_url: string, opts?: RequestInit) => { if (opts?.method === "POST") bodies.push(JSON.parse(String(opts.body))); return new Response(JSON.stringify(state)); };
  new Script(script).runInNewContext({ document, fetch });
  await new Promise(resolve => setImmediate(resolve));
  document.getElementById("preset").value = "custom";
  document.getElementById("model").value = "muse";
  document.getElementById("endpoint").value = "https://meta.example/v1/chat/completions";
  document.getElementById("textKey").value = "new-text-key";
  await document.getElementById("textForm").onsubmit({ preventDefault() {}, target: document.getElementById("textForm") });
  expect(bodies).toEqual([{ section: "text", preset: "custom", apiKey: "new-text-key", model: "muse", baseUrl: "https://meta.example/v1/chat/completions" }]);
  expect(document.getElementById("textKey").value).toBe("");
});

it("provedor de texto: formulário usa os campos salvos localmente (saved), não os efetivos do projeto", async () => {
  const script = await settingsScript(), document = documentStub();
  const projectText = { preset: "gemini", apiKey: "hidden", textProviderSource: "project" as const };
  const savedLocal = { preset: "zai", apiKey: "hidden-local" };
  const state = {
    ...keyProviderState({}, { preset: "gemini", apiKey: "hidden" }),
    text: { ...textProviderState({}, projectText as never), saved: textProviderState({}, savedLocal as never) },
  };
  const fetch = async () => new Response(JSON.stringify(state));
  new Script(script).runInNewContext({ document, fetch });
  await new Promise(resolve => setImmediate(resolve));
  // O formulário mostra o preset LOCAL salvo (zai), não o do projeto (gemini); o resumo acima mostra o efetivo do projeto.
  expect(document.getElementById("preset").value).toBe("zai");
  expect(document.getElementById("textState").textContent).toContain("gemini");
});

it("testText e testJev ficam desabilitados na marcação, sem chamada de teste disponível", async () => {
  const html = await readFile(new URL("./settings.html", import.meta.url), "utf8");
  expect(html).toMatch(/<button id="testText" type="button" disabled/);
  expect(html).toMatch(/<button id="testJev" type="button" disabled/);
  expect(html).not.toMatch(/<button id="testVisual" type="button" disabled/);
  expect(html).toContain("Este provedor não oferece teste sem custo");
});

it("testVisual consulta /settings/test com a chave digitada e mostra mensagem e origem", async () => {
  const script = await settingsScript(), document = documentStub();
  const calls: any[] = [];
  const state = keyProviderState({}, { preset: "zai", apiKey: "hidden" });
  const fetch = async (url: string, opts?: RequestInit) => {
    if (url === "/settings/test") { calls.push(JSON.parse(String(opts?.body))); return new Response(JSON.stringify({ available: true, source: "input", message: "Chave funcionando" })); }
    return new Response(JSON.stringify(state));
  };
  new Script(script).runInNewContext({ document, fetch });
  await new Promise(resolve => setImmediate(resolve));
  document.getElementById("openaiKey").value = "typed-fake-key-1234567890";
  await document.getElementById("testVisual").onclick();
  expect(calls).toEqual([{ section: "visual", key: "typed-fake-key-1234567890" }]);
  expect(document.getElementById("message").textContent).toBe("Chave funcionando");
  expect(document.getElementById("visualTestSource").textContent).toContain("chave digitada");
});

it("testVisual sem chave digitada testa a chave em uso (sem campo 'key' no corpo)", async () => {
  const script = await settingsScript(), document = documentStub();
  const calls: any[] = [];
  const state = keyProviderState({}, { preset: "zai", apiKey: "hidden" });
  const fetch = async (url: string, opts?: RequestInit) => {
    if (url === "/settings/test") { calls.push(JSON.parse(String(opts?.body))); return new Response(JSON.stringify({ available: true, source: "environment", message: "Chave funcionando" })); }
    return new Response(JSON.stringify(state));
  };
  new Script(script).runInNewContext({ document, fetch });
  await new Promise(resolve => setImmediate(resolve));
  await document.getElementById("testVisual").onclick();
  expect(calls).toEqual([{ section: "visual" }]);
});

it("trocar só a chave do zai omite preset/modelo/endpoint resolvidos e não fixa seus padrões", async () => {
  const script = await settingsScript(), document = documentStub(), bodies: unknown[] = [];
  const stored = { preset: "zai" as const, apiKey: "old-zai-key" };
  const state = { ...keyProviderState({}, stored), text: textProviderState({}, stored) };
  const fetch = async (_url: string, opts?: RequestInit) => {
    if (opts?.method === "POST") bodies.push(JSON.parse(String(opts.body)));
    return new Response(JSON.stringify(state));
  };
  new Script(script).runInNewContext({ document, fetch, URL });
  await new Promise(resolve => setImmediate(resolve));
  expect(document.getElementById("model").value).toBe("glm-5.3-flash");
  expect(document.getElementById("endpoint").value).toBe("https://api.z.ai/api/coding/paas/v4/chat/completions");
  document.getElementById("textKey").value = "new-zai-key";
  await document.getElementById("textForm").onsubmit({ preventDefault() {}, target: document.getElementById("textForm") });
  expect(bodies).toEqual([{ section: "text", apiKey: "new-zai-key" }]);
});

it.each(["zai", "custom"] as const)("trocar e voltar ao preset salvo %s restaura os campos e não exige chave nova", async preset => {
  const script = await settingsScript(), document = documentStub(), bodies: unknown[] = [];
  const stored = { preset, apiKey: "old-text-key", ...(preset === "custom" ? { model: "muse", baseUrl: "https://meta.example/v1/chat/completions" } : {}) };
  const state = { ...keyProviderState({}, stored), text: textProviderState({}, stored) };
  const fetch = async (_url: string, opts?: RequestInit) => {
    if (opts?.method === "POST") bodies.push(JSON.parse(String(opts.body)));
    return new Response(JSON.stringify(state));
  };
  new Script(script).runInNewContext({ document, fetch, URL });
  await new Promise(resolve => setImmediate(resolve));
  document.getElementById("preset").value = "gemini"; document.getElementById("preset").onchange();
  expect(document.getElementById("textKey").required).toBe(true);
  document.getElementById("preset").value = preset; document.getElementById("preset").onchange();
  expect(document.getElementById("textKey").required).toBe(false);
  expect(document.getElementById("model").value).toBe(preset === "custom" ? "muse" : "glm-5.3-flash");
  expect(document.getElementById("endpoint").value).toBe(preset === "custom" ? "https://meta.example/v1/chat/completions" : "https://api.z.ai/api/coding/paas/v4/chat/completions");
  await document.getElementById("textForm").onsubmit({ preventDefault() {}, target: document.getElementById("textForm") });
  expect(bodies).toEqual([{ section: "text" }]);
});

it("a chave só é obrigatória quando o endpoint final difere: branco no padrão e URL equivalente não exigem", async () => {
  const script = await settingsScript(), document = documentStub();
  const stored = { preset: "zai" as const, apiKey: "old-zai-key" };
  const state = { ...keyProviderState({}, stored), text: textProviderState({}, stored) };
  new Script(script).runInNewContext({ document, fetch: async () => new Response(JSON.stringify(state)), URL });
  await new Promise(resolve => setImmediate(resolve));
  for (const endpoint of ["", "  HTTPS://API.Z.AI/api/coding/paas/v4/chat/completions  "]) {
    document.getElementById("endpoint").value = endpoint; document.getElementById("endpoint").oninput();
    expect(document.getElementById("textKey").required).toBe(false);
  }
  document.getElementById("endpoint").value = "https://other.example/v1/chat/completions"; document.getElementById("endpoint").oninput();
  expect(document.getElementById("textKey").required).toBe(true);
});
