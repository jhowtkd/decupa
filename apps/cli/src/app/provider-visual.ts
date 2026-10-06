import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { analysisClientOptions, OPENAI_ASSEMBLY_TEXT_EFFORT, OPENAI_ASSEMBLY_TEXT_MODEL, payloadProfile, readCredentials, resolveAssemblyTextProvider, resolveVisualProvider, resolveTypeSafe, writeCredentials, type Credentials } from "@decupa/triage";
import { readProviderBody } from "./provider-body.ts";
import { optionalProviderKey, validateTextProvider } from "./provider-validation.ts";
const saves = new Map<string, Promise<void>>();

async function saveFields(dir: string, fields: Partial<Credentials>, removeKeys: ("openaiApiKey" | "typesafeApiKey")[] | undefined,
  invalidate: (dir: string) => void, check?: (previous: Credentials) => Promise<void>): Promise<void> {
  const task = (saves.get(dir) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const previous = await readCredentials(dir);
    if (!previous) throw new Error("Configure primeiro o provedor de texto.");
    await check?.(previous);
    await writeCredentials(dir, { ...previous, ...fields }, { removeKeys });
    invalidate(dir);
  });
  saves.set(dir, task);
  try { await task; } finally { if (saves.get(dir) === task) saves.delete(dir); }
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
}): Promise<boolean> {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (req.method === "GET" && path === "/visual-notice.js") {
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
    res.end(await readFile(new URL("./visual-notice.js", import.meta.url), "utf8"));
    return true;
  }
  if (path === "/provider/visual") {
    res.writeHead(307, { location: "/provider/keys", "cache-control": "no-store" }); res.end(); return true;
  }
  if (path !== "/provider/keys") return false;
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  try { validateTextProvider(await readCredentials(opts.dir)); }
  catch { json(428, { error: "Configure o provedor de texto primeiro" }); return true; }
  if (req.method === "GET") {
    if (req.headers.accept?.includes("text/html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" });
      res.end(await readFile(new URL("./provider-keys.html", import.meta.url), "utf8"));
    } else json(200, keyProviderState(opts.env, await opts.loadStored(), opts.includeAssemblyTextNotice));
  } else if (req.method === "POST") {
    try {
      const body = await readProviderBody(req) as Record<string, unknown>;
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Configuração inválida.");
      const section = body.section ?? (body.visualProvider !== undefined ? "visual" : undefined);
      const removing = body.removeKey === true;
      const allowed = removing ? ["section", "removeKey"] : section === "visual" ? ["section", "openaiApiKey", "visualProvider", "assemblyTextProvider"] : ["section", "typesafeApiKey", "typesafe"];
      if (!["visual", "jev"].includes(String(section)) || Object.keys(body).some(key => !allowed.includes(key))) throw new Error("Configuração inválida.");
      const fields = removing ? section === "jev" ? { typesafe: false } : {} : section === "visual" ? validateVisualProvider(body) : validateJevProvider(body);
      await saveFields(opts.dir, fields, removing ? [section === "visual" ? "openaiApiKey" : "typesafeApiKey"] : undefined, opts.invalidateStored, async previous => {
        // A checagem fica na mesma fila da escrita: remoção concorrente não autoriza Sol.
        if ("assemblyTextProvider" in fields && fields.assemblyTextProvider === previous.assemblyTextProvider) delete fields.assemblyTextProvider;
        if ("assemblyTextProvider" in fields && fields.assemblyTextProvider === "openai"
          && !(opts.env.OPENAI_API_KEY?.trim() || fields.openaiApiKey || previous.openaiApiKey || (await opts.loadStored())?.openaiApiKey)) throw new Error("Chave OpenAI ausente.");
      });
      const state = keyProviderState(opts.env, await opts.loadStored(), opts.includeAssemblyTextNotice);
      if (section === "jev" && !state.jev.enabled) await opts.onJevDisabled?.();
      json(200, state);
    } catch { json(400, { error: "Não foi possível salvar. Confira os campos e as permissões locais." }); }
  } else json(405, { error: "Método inválido." });
  return true;
}

/** O aviso é independente das mensagens de trabalho e usa apenas texto fixo. */
export function withVisualNotice(html: string, notice: string | null): string {
  const banner = `<aside id="visual-provider-notice" role="status"${notice ? "" : " hidden"}><a href="/provider/keys">${notice ?? ""}</a></aside>`;
  const style = `<style>#visual-provider-notice{position:fixed;bottom:16px;left:16px;right:16px;z-index:35;padding:12px 16px;background:var(--panel,#191a1d);color:var(--ink,#f0f0ed);border:1px solid var(--line,#303238);border-radius:6px;font:14px/1.5 system-ui}#visual-provider-notice[hidden]{display:none}#visual-provider-notice a{color:inherit}body:has(#visual-provider-notice:not([hidden])) #toast{bottom:calc(32px + var(--visual-notice-height,64px))}</style>`;
  return html.replace("</head>", style + "</head>").replace(/<body[^>]*>/, "$&" + banner)
    .replace("</body>", '<script type="module" src="/visual-notice.js"></script></body>');
}
