import { mapDisk, PROCESS_SESSION } from "./storage-lock.ts";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const SPACE_MARGIN_BYTES = 15 * 1024 ** 3;
export class SpaceCapacityError extends Error {
  readonly status = 507;
  readonly requiredBytes: number;
  readonly availableBytes: number;
  constructor(requiredBytes: number, availableBytes: number) {
    super(`não há espaço suficiente no volume compartilhado: necessários ${requiredBytes} bytes (${(requiredBytes / 1024 ** 3).toFixed(2)} GiB, incluindo a margem de 15 GiB); há ${availableBytes} bytes livres (${(availableBytes / 1024 ** 3).toFixed(2)} GiB)`);
    this.requiredBytes = requiredBytes;
    this.availableBytes = availableBytes;
  }
}

export type SpaceReservation = (() => Promise<void>) & { update(claims: SpaceClaim[]): Promise<void> };
export type SpaceClaim = { path: string; bytes: number; materializedPath?: string };
type Reservation = { id: string; pid: number; sessionId?: string; claims: SpaceClaim[] };
const roots = new Set<string>();
const devices = new Map<string, string>();
// Todos os consumidores do mesmo filesystem passam pela mesma exclusão, até
// quando pool, Projetos e .tmp são diretórios diferentes do mesmo volume.
let capacityTurn: Promise<unknown> = Promise.resolve();
export async function withCapacityLock<T>(fn: () => Promise<T>): Promise<T> {
  const turn = capacityTurn.then(fn, fn);
  capacityTurn = turn.catch(() => undefined);
  return turn;
}
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
async function entries(path: string) {
  return readdir(path, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
}
async function existingDirectory(path: string): Promise<string> {
  let current = resolve(path);
  while (!(await stat(current).catch(() => null))?.isDirectory()) {
    const parent = dirname(current);
    if (parent === current) throw new Error("volume indisponível");
    current = parent;
  }
  return current;
}
async function readReservations(root: string): Promise<Reservation[]> {
  const values: Reservation[] = [];
  for (const entry of await entries(join(root, ".reservations"))) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const record = JSON.parse(await readFile(join(root, ".reservations", entry.name), "utf8")) as Reservation;
    if (processAlive(record.pid) && !(record.pid === process.pid && record.sessionId && record.sessionId !== PROCESS_SESSION)) values.push(record);
  }
  return values;
}
async function obligations(root: string, candidate?: { id: string; total: number }, exclude?: string): Promise<SpaceClaim[]> {
  const claims: SpaceClaim[] = [];
  let found = false;
  const uploads = (await entries(join(root, ".tmp"))).filter(entry => entry.isDirectory() && /^[0-9a-f-]{36}$/.test(entry.name));
  const states = await mapDisk(uploads, async entry => {
    try {
      return { id: entry.name, state: JSON.parse(await readFile(join(root, ".tmp", entry.name, "state.json"), "utf8")) as { reserva?: boolean; tamanhoTotal: number } };
    } catch { return null; }
  });
  for (const upload of states) {
    if (!upload) continue;
    const { id, state } = upload;
    const total = candidate?.id === id ? candidate.total : state.reserva ? state.tamanhoTotal : 0;
    if (candidate?.id === id) found = true;
    if (!Number.isSafeInteger(total) || total < 0) continue;
    if (total > 0) claims.push(
      { path: join(root, ".tmp"), bytes: total, materializedPath: join(root, ".tmp", id, "data") },
      { path: join(root, "pool"), bytes: total },
    );
  }
  if (candidate && !found) claims.push(
    { path: join(root, ".tmp"), bytes: candidate.total }, { path: join(root, "pool"), bytes: candidate.total },
  );
  for (const reservation of await readReservations(root)) if (reservation.id !== exclude) claims.push(...reservation.claims);
  return claims;
}
export function createSpaceManager(rootPath: string) {
  const root = resolve(rootPath); roots.add(root);
  async function allClaims(candidate?: { id: string; total: number }, exclude?: string): Promise<SpaceClaim[]> {
    const claims: SpaceClaim[] = [];
    for (const registered of roots) claims.push(...await obligations(registered, registered === root ? candidate : undefined, exclude));
    return claims;
  }
  async function assertClaims(extra: SpaceClaim[], candidate?: { id: string; total: number }, exclude?: string) {
    const needed = new Map<string, { path: string; bytes: number }>();
    // Materialização já diminui bavail: abate ANTES de ler statfs (P5).
    const claims = [...await allClaims(candidate, exclude), ...extra];
    const measured = await mapDisk(claims, async claim => {
      if (!Number.isSafeInteger(claim.bytes) || claim.bytes < 0) throw new Error("reserva inválida");
      const path = devices.has(resolve(claim.path)) ? resolve(claim.path) : await existingDirectory(claim.path);
      let dev = devices.get(path);
      if (!dev) { dev = String((await stat(path)).dev); devices.set(path, dev); }
      const materialized = claim.materializedPath ? await stat(claim.materializedPath).then(s => s.size, () => 0) : 0;
      return { path, dev, bytes: Math.max(0, claim.bytes - materialized) };
    });
    for (const claim of measured) {
      const previous = needed.get(claim.dev);
      needed.set(claim.dev, { path: previous?.path ?? claim.path, bytes: (previous?.bytes ?? 0) + claim.bytes });
    }
    for (const { path, bytes } of needed.values()) {
      const fs = await statfs(path); const available = Number(fs.bavail) * Number(fs.bsize);
      if (!Number.isFinite(available) || available < bytes + SPACE_MARGIN_BYTES) throw new SpaceCapacityError(bytes + SPACE_MARGIN_BYTES, Number.isFinite(available) ? available : 0);
    }
  }
  return {
    obligations: () => obligations(root),
    assertUpload: (id: string, total: number) => assertClaims([], { id, total }),
    async reserve(_label: string, claims: SpaceClaim[]): Promise<SpaceReservation> {
      const id = randomUUID();
      const path = join(root, ".reservations", `${id}.json`);
      async function save(next: SpaceClaim[]) {
        await assertClaims(next, undefined, id);
        await mkdir(dirname(path), { recursive: true });
        const tmp = `${path}.tmp`;
        await writeFile(tmp, JSON.stringify({ id, pid: process.pid, sessionId: PROCESS_SESSION, claims: next } satisfies Reservation));
        await rename(tmp, path);
      }
      await withCapacityLock(() => save(claims));
      const release = () => withCapacityLock(() => rm(path, { force: true }));
      return Object.assign(release, { update: (next: SpaceClaim[]) => withCapacityLock(() => save(next)) });
    },
  };
}
/** Tamanho físico uma vez por inode, inclusive hardlinks de pool/ e exports/. */
export async function uniqueFileBytes(paths: string[]): Promise<number> {
  const seen = new Set<string>(); let bytes = 0;
  for (const path of paths) {
    const file = await stat(path); const key = `${file.dev}:${file.ino}`;
    if (!seen.has(key)) { seen.add(key); bytes += file.size; }
  }
  return bytes;
}
