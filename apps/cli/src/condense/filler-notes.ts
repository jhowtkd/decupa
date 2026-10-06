import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  fillerNoteKey, matchingFillerNote, publishFillerNotes, scoreAmbiguous,
  type FillerNote, type FillerObserveClient, type FillerObserveItem,
} from "@decupa/triage";

/** Notas são observação: publicar nunca modifica seleção nem inicia outro plano. */
export function cleanupFillerNotes(opts: { workDir: string; model: string; client?: FillerObserveClient;
  signal: AbortSignal; publish: (notes: FillerNote[]) => void; warn: (message: string) => void;
  pending?: (value: boolean) => void }) {
  let key: string | null = null, controller: AbortController | null = null;
  let task: Promise<void> = Promise.resolve();
  let saved: unknown[] | null = null;
  const cache = new Map<string, FillerNote>();
  const update = (items: FillerObserveItem[], catalog = items): void => {
    const itemKeys = items.map(item => fillerNoteKey(item, opts.model));
    const catalogKeys = new Set(catalog.map(item => fillerNoteKey(item, opts.model)));
    const nextKey = JSON.stringify([itemKeys, [...catalogKeys].sort()]);
    if (key === nextKey) return;
    key = nextKey; controller?.abort(); controller = new AbortController();
    const current = controller, signal = AbortSignal.any([opts.signal, current.signal]);
    opts.warn("");
    for (const cachedKey of cache.keys()) if (!catalogKeys.has(cachedKey)) cache.delete(cachedKey);
    opts.publish(itemKeys.flatMap(k => cache.has(k) ? [cache.get(k)!] : []));
    // Sem configuração não existe tentativa. Uma sessão nova poderá pontuar normalmente.
    if (!opts.client) { opts.pending?.(false); return; }
    opts.pending?.(items.some((_, i) => !cache.has(itemKeys[i]!)));
    // A escrita da tarefa antiga termina antes da nova: uma nota cancelada não vence o rename.
    task = task.catch(() => {}).then(async () => {
      signal.throwIfAborted();
      if (saved === null) {
        saved = await readFile(join(opts.workDir, "fillers-notes.json"), "utf8").then(text => {
          try { const raw = JSON.parse(text); return Array.isArray(raw?.notes) ? raw.notes : []; }
          catch { return []; }
        }, () => []);
      }
      signal.throwIfAborted();
      const previous = saved ?? [];
      for (const cachedKey of cache.keys()) if (!catalogKeys.has(cachedKey)) cache.delete(cachedKey);
      for (const item of catalog) {
        const note = previous.map(raw => matchingFillerNote(raw, item, opts.model)).find(n => n?.score !== null && n?.score !== undefined && !n.decisionFailure);
        if (note) cache.set(note.key, note);
      }
      const missing = items.filter((_, i) => !cache.has(itemKeys[i]!));
      opts.publish(itemKeys.flatMap(k => cache.has(k) ? [cache.get(k)!] : []));
      const result = missing.length ? await scoreAmbiguous(opts.client, missing, { signal, model: opts.model }) : { notes: [], excess: 0 };
      signal.throwIfAborted();
      for (const note of result.notes) if (note.score !== null && !note.decisionFailure) cache.set(note.key, note);
      // Falhas são apenas a observação desta tentativa: nunca viram cache durável.
      const durable = [...cache.values()];
      if (durable.length || previous.length) await publishFillerNotes(opts.workDir, durable, signal);
      saved = durable;
      signal.throwIfAborted();
      if (current !== controller) return;
      const attempts = new Map(result.notes.map(n => [n.key, n]));
      opts.publish(itemKeys.flatMap(k => cache.has(k) ? [cache.get(k)!] : attempts.has(k) ? [attempts.get(k)!] : []));
      if (result.excess) opts.warn(`${result.excess} cacoetes ambíguos excedem o teto de 100 notas do Jev`);
    }).catch(error => { if (!signal.aborted) opts.warn(`não consegui publicar notas de cacoetes: ${error instanceof Error ? error.message : String(error)}`); })
      .finally(() => { if (current === controller) opts.pending?.(false); });
  };
  return { update, close: () => { controller?.abort(); return task; } };
}
