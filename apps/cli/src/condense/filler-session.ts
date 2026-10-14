import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { publishAtomic } from "@decupa/cache";
import { mergeFillerDecisions, type FillerDecisions } from "./fillers.ts";
import { keepPath } from "../app/session.ts";

export type CleanupState = { generation: number; keepList: string; fillers: FillerDecisions };
const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
async function read(path: string): Promise<string | null> { return readFile(path, "utf8").catch(e => { if (absent(e)) return null; throw e; }); }
async function restore(path: string, value: string | null): Promise<void> {
  if (value !== null) await publishAtomic(path, value);
  else await unlink(path).catch(e => { if (!absent(e)) throw e; });
}

/** O diário desfaz uma troca interrompida entre os dois renames na retomada. */
export async function recoverFillerSession(dir: string): Promise<void> {
  const path = join(dir, ".fillers-session-pending.json"), raw = await read(path);
  if (raw === null) return;
  const previous = JSON.parse(raw) as { keep: string | null; fillers: string | null };
  if ((previous.keep !== null && typeof previous.keep !== "string") || (previous.fillers !== null && typeof previous.fillers !== "string")) throw Error("diário da sessão de cacoetes inválido");
  await restore(keepPath(dir), previous.keep);
  await restore(join(dir, "fillers.json"), previous.fillers);
  await unlink(path);
}

export async function persistFillerSession(dir: string, state: CleanupState, transcriptSha256: string, signal?: AbortSignal,
  opts?: { preserveFillers?: boolean }): Promise<void> {
  signal?.throwIfAborted();
  // Recuperação que falhou não pode virar o novo "anterior" e perder o diário original.
  await recoverFillerSession(dir);
  signal?.throwIfAborted();
  const keep = keepPath(dir), fillers = join(dir, "fillers.json"), journal = join(dir, ".fillers-session-pending.json");
  const previous = { keep: await read(keep), fillers: await read(fillers) };
  await publishAtomic(journal, JSON.stringify(previous), { durable: true });
  try {
    await publishAtomic(keep, `${state.keepList.trim()}\n`, { durable: true });
    // No fallback não há catálogo para validar decisões; conserva o arquivo sem regravá-lo.
    if (!opts?.preserveFillers) await publishAtomic(fillers, `${JSON.stringify({ transcriptSha256, ...state.fillers }, null, 2)}\n`, { durable: true });
    signal?.throwIfAborted();
    await unlink(journal);
  } catch (error) {
    await recoverFillerSession(dir);
    throw error;
  }
}

/** Cada mutação funde o estado antes do primeiro await; os esperadores seguem o vencedor. */
export class CleanupPlanQueue {
  desired: CleanupState;
  private flight: Promise<void> | null = null;
  private readonly execute: (state: CleanupState, current: () => boolean) => Promise<void>;
  get planning(): boolean { return this.flight !== null; }
  constructor(initial: CleanupState, execute: (state: CleanupState, current: () => boolean) => Promise<void>) {
    this.desired = structuredClone(initial); this.execute = execute;
  }
  update(patch: { keepList?: string; fillers?: Partial<FillerDecisions> }): Promise<void> {
    this.desired = { generation: this.desired.generation + 1,
      keepList: patch.keepList ?? this.desired.keepList,
      fillers: patch.fillers ? mergeFillerDecisions(this.desired.fillers, patch.fillers) : this.desired.fillers };
    if (!this.flight) {
      // A microtarefa permite coalescer cliques sem atraso artificial do motor.
      const flight = Promise.resolve().then(async () => {
        for (;;) {
          const state = structuredClone(this.desired);
          try { await this.execute(state, () => state.generation === this.desired.generation); }
          catch (error) {
            if (state.generation === this.desired.generation) { this.flight = null; throw error; }
          }
          if (state.generation === this.desired.generation) { this.flight = null; return; }
        }
      }).finally(() => { if (this.flight === flight) this.flight = null; });
      this.flight = flight;
    }
    return this.flight;
  }
}
