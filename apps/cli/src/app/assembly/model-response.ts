/** Aceita cercas/prosa em volta de um único objeto, sem reparar seu conteúdo. */
export function parseModelJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("resposta sem objeto JSON completo");
  return JSON.parse(text.slice(start, end + 1));
}

/** Uma correção de resposta inválida; falhas de transporte seguem para o chamador. */
export async function requestValidated<T>(
  content: unknown[],
  send: (content: unknown[], signal?: AbortSignal) => Promise<string>,
  parse: (text: string) => T,
  signal: AbortSignal,
): Promise<T> {
  const text = await send(content, signal);
  signal.throwIfAborted();
  try {
    return parse(text);
  } catch (error) {
    const repaired = await send([...content, { type: "text", text:
      "A resposta anterior não passou na validação: " + (error instanceof Error ? error.message : String(error))
      + ". Corrija usando os mesmos dados. Retorne apenas JSON válido, sem comentários ou texto fora do objeto, "
      + "com tempos numéricos e strings corretamente escapadas. Não invente observações, IDs nem intervalos. "
      + "Resposta anterior: " + text,
    }], signal);
    signal.throwIfAborted();
    return parse(repaired);
  }
}
