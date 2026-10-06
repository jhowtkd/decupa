import {
  analysisClientOptions, OpenAiCompatClient, createVisualClient, payloadProfileKey, resolveVisualProvider,
  type Credentials, type VisualSelection,
} from "@decupa/triage";
import type { VisualClient } from "./assembly/model.ts";
import { sanitizeProviderKey } from "./assembly/visual-identity.ts";

type TransportOptions = {
  stored?: Credentials | null; env?: Record<string, string | undefined>; fetchImpl?: typeof fetch;
  proposeSend?: VisualClient["send"]; describeClient?: VisualClient;
  loadStored?: () => Promise<Credentials | null>;
};

function visualSnapshot(opts: TransportOptions, env: Record<string, string | undefined>) {
  const selection = resolveVisualProvider(env, opts.stored);
  let visualClient: VisualClient;
  try { visualClient = createVisualClient({ stored: opts.stored, env, selection, fetchImpl: opts.fetchImpl }); }
  catch (error) { visualClient = { send: async () => { throw error; } }; }
  return { selection, visualClient: opts.describeClient ?? visualClient, legacyVisualCompatible: selection.provider === "text" };
}

/** Só resolve configuração, sem rede. O erro de chave fica no transporte da tarefa. */
export function resolveAppTransports(opts: TransportOptions) {
  const env = { ...(opts.env ?? process.env) };
  const visualProvider = resolveVisualProvider(env, opts.stored); // Valor inválido falha na subida, mesmo antes de autorizar envio.
  let textKey = "unconfigured";
  let legacyModelKey: string | undefined;
  let textSend: VisualClient["send"];
  try {
    const resolved = analysisClientOptions({ stored: opts.stored, env, fetchImpl: opts.fetchImpl });
    const text = new OpenAiCompatClient(resolved);
    textKey = JSON.stringify([resolved.model, sanitizeProviderKey(resolved.baseUrl), payloadProfileKey({ ...resolved, inputMode: "text" })]);
    // recipe-v1 usava este objeto e esta ordem de campos na chave do diretório.
    legacyModelKey = JSON.stringify({ model: resolved.model, providerKey: resolved.baseUrl });
    textSend = (content, signal) => text.send(content, signal);
  } catch (error) {
    let text: OpenAiCompatClient | undefined;
    textSend = async (content, signal) => {
      // A primeira configuração pela tela ainda funciona sem reiniciar. Só
      // a credencial recém-gravada é relida; o ambiente segue o da subida.
      if (!text) {
        const stored = await opts.loadStored?.();
        if (!stored) throw error;
        text = new OpenAiCompatClient(analysisClientOptions({ stored, env, fetchImpl: opts.fetchImpl }));
      }
      return text.send(content, signal);
    };
  }
  let visualClient: VisualClient;
  try { visualClient = createVisualClient({ stored: opts.stored, env, fetchImpl: opts.fetchImpl }); }
  catch (error) {
    let configured: VisualClient | undefined;
    visualClient = { send: async (content, signal, onAttempt) => {
      // Luna nunca cai para a credencial geral, inclusive após o formulário.
      if (visualProvider.provider === "openai") throw error;
      if (!configured) {
        const stored = await opts.loadStored?.();
        if (!stored) throw error;
        configured = createVisualClient({ stored, env, fetchImpl: opts.fetchImpl });
        Object.assign(visualClient, configured);
      }
      return configured.send(content, signal, onAttempt);
    } };
  }
  // A análise captura este objeto uma vez, antes de extrair frames ou ler cache.
  // A próxima análise relê somente o arquivo; uma em curso conserva seu cliente.
  const load = async () => opts.loadStored ? await opts.loadStored() : opts.stored;
  const resolveVisual = async () => visualSnapshot({ ...opts, stored: await load() }, env);
  const resolveAnalysis = async (): Promise<{ selection: VisualSelection; visualClient: VisualClient; legacyVisualCompatible: boolean;
    send: VisualClient["send"]; modelKey: string; legacyModelKey?: string }> => {
    const stored = await load();
    const visual = visualSnapshot({ ...opts, stored }, env);
    const text = resolveAppTransports({ ...opts, stored, env, loadStored: undefined });
    return { ...visual, send: text.textSend, modelKey: text.textKey, legacyModelKey: text.legacyModelKey };
  };
  return { textSend: opts.proposeSend ?? textSend, textKey, legacyModelKey, legacyVisualCompatible: visualProvider.provider === "text", visualClient: opts.describeClient ?? visualClient, resolveVisual, resolveAnalysis };
}
