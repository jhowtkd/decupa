import {
  analysisClientOptions, OpenAiCompatClient, createVisualClient, payloadProfileKey, resolveVisualProvider,
  type Credentials,
} from "@decupa/triage";
import type { VisualClient } from "./assembly/model.ts";
import { sanitizeProviderKey } from "./assembly/visual-identity.ts";

/** Só resolve configuração, sem rede. O erro de chave fica no transporte da tarefa. */
export function resolveAppTransports(opts: {
  stored?: Credentials | null; env?: Record<string, string | undefined>; fetchImpl?: typeof fetch;
  proposeSend?: VisualClient["send"]; describeClient?: VisualClient;
  loadStored?: () => Promise<Credentials | null>;
}) {
  const env = { ...(opts.env ?? process.env) };
  const visualProvider = resolveVisualProvider(env); // Valor inválido falha na subida, mesmo antes de autorizar envio.
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
      if (resolveVisualProvider(env)) throw error;
      if (!configured) {
        const stored = await opts.loadStored?.();
        if (!stored) throw error;
        configured = createVisualClient({ stored, env, fetchImpl: opts.fetchImpl });
        Object.assign(visualClient, configured);
      }
      return configured.send(content, signal, onAttempt);
    } };
  }
  return { textSend: opts.proposeSend ?? textSend, textKey, legacyModelKey, legacyVisualCompatible: visualProvider === null, visualClient: opts.describeClient ?? visualClient };
}
