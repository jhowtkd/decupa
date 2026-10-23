import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { analysisClientOptions, OPENAI_ASSEMBLY_TEXT_EFFORT, OPENAI_ASSEMBLY_TEXT_MODEL, payloadProfile, readCredentials, resolveAssemblyTextProvider, resolveVisualProvider, resolveTypeSafe, writeCredentials, type Credentials } from "@decupa/triage";
import { readProviderBody } from "./provider-body.ts";
import { optionalProviderKey, validateTextProvider } from "./provider-validation.ts";
import { saveProviderFields } from "./provider-store.ts";
import { SettingsInputError, textProviderFields, textProviderState } from "./settings-text.ts";
import { testProviderKey, NO_FREE_KEY_TEST } from "./settings-test.ts";
import { withStudioShell, type EditorUi } from "./assembly/editor-ui.ts";

/** Sem a divisão conhecida, CSS da bancada não pode vazar para Configurações. */
export function settingsTokens(css: string): string {
  const boundary = css.indexOf("/* == base == */");
  if (boundary < 0) throw new Error("Tokens de Configurações indisponíveis: falta o marcador de base do CSS.");
  return css.slice(0, boundary);
}

export function validateVisualProvider(value: unknown): Pick<Credentials, "openaiApiKey" | "visualProvider" | "assemblyTextProvider"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Configuração inválida.");
  const v = value as Record<string, unknown>;
  const hasVisual = v.visualProvider !== undefined || v.openaiApiKey !== undefined;
  if (hasVisual && v.visualProvider !== "openai" && v.visualProvider !== "text") throw new Error("Escolha a análise de imagem.");
  if (v.assemblyTextProvider !== undefined && v.assemblyTextProvider !== "openai" && v.assemblyTextProvider !== "text") throw new Error("Escolha o texto da Montagem.");
  if (!hasVisual && v.assemblyTextProvider === undefined) throw new Error("Configuração inválida.");
  const openaiApiKey = optionalProviderKey(v.openaiApiKey);
  return { ...(hasVisual ? { visualProvider: v.visualProvider as Credentials["visualProvider"] } : {}),
    ...(openaiApiKey ? { openaiApiKey } : {}),
    ...(v.assemblyTextProvider !== undefined ? { assemblyTextProvider: v.assemblyTextProvider as Credentials["assemblyTextProvider"] } : {}) };
}

export function validateJevProvider(value: unknown): Pick<Credentials, "typesafeApiKey" | "typesafe"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Configuração inválida.");
  const v = value as Record<string, unknown>;
  if (typeof v.typesafe !== "boolean") throw new Error("Configuração inválida.");
  const typesafeApiKey = optionalProviderKey(v.typesafeApiKey);
  return { typesafe: v.typesafe, ...(typesafeApiKey ? { typesafeApiKey } : {}) };
}

export function visualProviderState(env: Record<string, string | undefined>, stored: Credentials | null) {
  const selection = resolveVisualProvider(env, stored);
  return { ...selection, configured: Boolean(env.OPENAI_API_KEY?.trim() || stored?.openaiApiKey?.trim()) };
}

export function keyProviderState(env: Record<string, string | undefined>, stored: Credentials | null, includeAssemblyTextNotice = true) {
  const visual = visualProviderState(env, stored), jev = resolveTypeSafe(env, stored);
  const assemblyText = assemblyTextProviderState(env, stored);
  const combined = jev.configured ? "Análise de imagem sem Luna. Decisões automáticas desligadas: ative o Jev →" : "Chaves de IA pendentes: Luna, Jev →";
  const notice = visual.notice && jev.notice ? combined : visual.notice ?? jev.notice;
  return { visual, jev, assemblyText, notice: includeAssemblyTextNotice && assemblyText.notice ? notice ? `${notice} ${assemblyText.notice}` : assemblyText.notice : notice };
}

/** O estado usa a mesma escolha que o transporte, sem criar cliente nem chamar IA. */
export function assemblyTextProviderState(env: Record<string, string | undefined>, stored: Credentials | null) {
  const selection = resolveAssemblyTextProvider(env, stored);
  let model: string | null = selection.provider === "openai" ? OPENAI_ASSEMBLY_TEXT_MODEL : null;
  let effort: string | null = selection.provider === "openai" ? OPENAI_ASSEMBLY_TEXT_EFFORT : null;
  if (selection.provider === "text") {
    try {
      const text = analysisClientOptions({ env, stored });
      model = text.model; effort = payloadProfile({ ...text, inputMode: "text" }).effort;
    } catch { /* A primeira abertura ainda pode não ter texto configurado. */ }
  }
  return { ...selection, model, effort };
}

/** Estado das duas seções, sem segredo; remoção nunca afeta os outros campos. */
export async function providerVisual(req: IncomingMessage, res: ServerResponse, opts: {
  dir: string; env: Record<string, string | undefined>; loadStored: () => Promise<Credentials | null>;
  invalidateStored: (dir: string) => void;
  includeAssemblyTextNotice?: boolean;
  onJevDisabled?: () => void | Promise<void>;
  fetchImpl?: typeof fetch;
  loadUser?: () => Promise<Credentials | null>;
  /** Shell da tela; o servidor lê `DECUPA_EDITOR_UI` uma vez e repassa. */
  editorUi?: EditorUi;
}): Promise<boolean> {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  const studio = opts.editorUi === "studio";
  if (req.method === "GET" && path === "/visual-notice.js") {
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
    res.end(await readFile(new URL("./visual-notice.js", import.meta.url), "utf8"));
    return true;
  }
  if (req.method === "GET" && path === "/settings/tokens.css") {
    const css = settingsTokens(await readFile(new URL("./assembly/page.css", import.meta.url), "utf8"));
    res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" });
    res.end(css); return true;
  }
  // Só o studio tem esta CSS: ela vem por cima do estilo inline de settings.html.
  if (studio && req.method === "GET" && path === "/settings/studio.css") {
    res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" });
    res.end(await readFile(new URL("./settings-studio.css", import.meta.url), "utf8")); return true;
  }
  if (path === "/provider/visual" || (path === "/provider/keys" && req.method === "GET" && req.headers.accept?.includes("text/html"))) {
    res.writeHead(307, { location: "/settings", "cache-control": "no-store" }); res.end(); return true;
  }
  if (!["/provider/keys", "/settings", "/settings/state", "/settings/test"].includes(path)) return false;
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  // O script é inline: o studio é o mesmo HTML com a meta e a CSS do studio.
  const settingsPage = async () => {
    const html = await readFile(new URL("./settings.html", import.meta.url), "utf8");
    return studio ? withStudioShell(html, "/settings/studio.css") : html;
  };
  let user: Credentials | null;
  try { user = validateTextProvider(await (opts.loadUser?.() ?? readCredentials(opts.dir))); }
  catch { user = null; }
  const state = async () => {
    if (req.method === "POST") {
      try { user = validateTextProvider(await (opts.loadUser?.() ?? readCredentials(opts.dir))); }
      catch { user = null; }
    }
    const stored = await opts.loadStored();
    return { ...keyProviderState(opts.env, stored, opts.includeAssemblyTextNotice),
      text: { ...textProviderState(opts.env, stored), saved: textProviderState({}, user) },
      keyTests: { text: { available: false, message: NO_FREE_KEY_TEST }, jev: { available: false, message: NO_FREE_KEY_TEST } } };
  };
  if (!user) {
    // R3.1 sem-chave: leitura liberada (tela + estado com configured:false,
    // sem 428 e sem crash). Escrita e teste de chave continuam exigindo o
    // texto — exceto o first-save do próprio texto em POST /settings, que
    // quebra a circularidade (saveProviderFields exige credencial prévia).
    if (req.method === "GET" && (path === "/settings" || path === "/settings/state" || path === "/provider/keys")) {
      if (path === "/settings") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" });
        res.end(await settingsPage());
      } else json(200, await state());
      return true;
    }
    if (req.method === "POST" && path === "/settings") {
      let firstBody: Record<string, unknown>;
      try {
        const parsed = await readProviderBody(req);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Configuração inválida.");
        firstBody = parsed as Record<string, unknown>;
      } catch { json(400, { error: "Não foi possível salvar. Confira os campos e as permissões locais." }); return true; }
      if (firstBody.section !== "text") { json(428, { error: "Configure o provedor de texto primeiro" }); return true; }
      const incomingKey = typeof firstBody.apiKey === "string" ? firstBody.apiKey.trim() : "";
      // Sem credencial prévia não há chave antiga para reaproveitar: o
      // first-save sempre exige a chave nova (placeholder nunca é gravado).
      if (!incomingKey) { json(400, { error: "Informe a chave do novo provedor" }); return true; }
      try {
        const fields = textProviderFields(firstBody, { preset: "zai", apiKey: "primeira-configuracao-pendente" } as Credentials);
        await writeCredentials(opts.dir, fields);
        opts.invalidateStored(opts.dir);
        user = validateTextProvider(await (opts.loadUser?.() ?? readCredentials(opts.dir)));
        json(200, await state());
      } catch (error) { json(400, { error: error instanceof SettingsInputError ? error.message : "Não foi possível salvar. Confira os campos e as permissões locais." }); }
      return true;
    }
    json(428, { error: "Configure o provedor de texto primeiro" });
    return true;
  }
  // As rotas novas são exclusivas da tela; a API antiga conserva os clientes locais.
  if (path.startsWith("/settings") && req.method !== "GET" && !req.headers.origin) {
    json(403, { error: "origem não permitida" }); return true;
  }
  if (path === "/settings/test") {
    if (req.method !== "POST") { json(405, { error: "Método inválido." }); return true; }
    try {
      const body = await readProviderBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Configuração inválida.");
      json(200, await testProviderKey(body as Record<string, unknown>, opts.env, await opts.loadStored(), opts.fetchImpl));
    } catch { json(400, { error: "Não foi possível testar. Confira os campos." }); }
    return true;
  }
  if (req.method === "GET") {
    if (path === "/settings") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" });
      res.end(await settingsPage());
    } else json(200, await state());
  } else if (req.method === "POST" && path !== "/settings/state") {
    try {
      const body = await readProviderBody(req) as Record<string, unknown>;
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Configuração inválida.");
      const section = body.section ?? (body.visualProvider !== undefined ? "visual" : undefined);
      if (body.section === "text" && path === "/settings") {
        const fields: Partial<Credentials> = {};
        await saveProviderFields(opts.dir, fields, undefined, opts.invalidateStored, async previous => {
          Object.assign(fields, textProviderFields(body, previous));
        });
        json(200, await state()); return true;
      }
      const removing = body.removeKey === true;
      const allowed = removing ? ["section", "removeKey"] : section === "visual" ? ["section", "openaiApiKey", "visualProvider", "assemblyTextProvider"] : ["section", "typesafeApiKey", "typesafe"];
      if (!["visual", "jev"].includes(String(section)) || Object.keys(body).some(key => !allowed.includes(key))) throw new Error("Configuração inválida.");
      const fields = removing ? section === "jev" ? { typesafe: false } : {} : section === "visual" ? validateVisualProvider(body) : validateJevProvider(body);
      await saveProviderFields(opts.dir, fields, removing ? [section === "visual" ? "openaiApiKey" : "typesafeApiKey"] : undefined, opts.invalidateStored, async previous => {
        // A checagem fica na mesma fila da escrita: remoção concorrente não autoriza Sol.
        if ("assemblyTextProvider" in fields && fields.assemblyTextProvider === previous.assemblyTextProvider) delete fields.assemblyTextProvider;
        if ("assemblyTextProvider" in fields && fields.assemblyTextProvider === "openai"
          && !(opts.env.OPENAI_API_KEY?.trim() || fields.openaiApiKey || previous.openaiApiKey || (await opts.loadStored())?.openaiApiKey)) throw new Error("Chave OpenAI ausente.");
      });
      const current = await state();
      if (section === "jev" && !current.jev.enabled) await opts.onJevDisabled?.();
      json(200, current);
    } catch (error) { json(400, { error: error instanceof SettingsInputError ? error.message : "Não foi possível salvar. Confira os campos e as permissões locais." }); }
  } else json(405, { error: "Método inválido." });
  return true;
}

/** O aviso é independente das mensagens de trabalho e usa apenas texto fixo. */
export function withVisualNotice(html: string, notice: string | null): string {
  const banner = `<aside id="visual-provider-notice" role="status"${notice ? "" : " hidden"}><a href="/settings#${notice?.includes("Luna") || notice?.includes("Sol") ? "openai" : "jev"}">${notice ?? ""}</a></aside>`;
  const style = `<style>#visual-provider-notice{position:fixed;bottom:16px;left:16px;right:16px;z-index:35;padding:12px 16px;background:var(--panel,#191a1d);color:var(--ink,#f0f0ed);border:1px solid var(--line,#303238);border-radius:6px;font:14px/1.5 system-ui}#visual-provider-notice[hidden]{display:none}#visual-provider-notice a{color:inherit}body:has(#visual-provider-notice:not([hidden])) #toast{bottom:calc(32px + var(--visual-notice-height,64px))}</style>`;
  return html.replace("</head>", style + "</head>").replace(/<body[^>]*>/, "$&" + banner)
    .replace("</body>", '<script type="module" src="/visual-notice.js"></script></body>');
}
