import { readCredentials, writeCredentials, type Credentials } from "@decupa/triage";

const saves = new Map<string, Promise<void>>();

/** A fila relê o arquivo dentro da escrita para seções simultâneas não perderem campos. */
export async function saveProviderFields(dir: string, fields: Partial<Credentials>,
  removeKeys: ("openaiApiKey" | "typesafeApiKey")[] | undefined,
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
