import { unlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import { publishAtomic } from "@decupa/cache";
import type { IncomingMessage, ServerResponse } from "node:http";
import { withProjectWrite } from "./assembly/store.ts";

export const EDIT_RESERVATION_TTL_MS = 90_000;
export const EDIT_RESERVATION_FILE = "edit-reservation.json";
export const EDIT_RESERVATION_HEADER = "x-decupa-tab";

export type EditReservation = {
  tabId: string;
  nome: string;
  ultimoSinal: number;
  /** Preenchido somente quando a Reserva foi transferida por Assumir Edição. */
  assumidoEm?: number;
};

export class ReservationHeldError extends Error {
  readonly dono: EditReservation;

  constructor(dono: EditReservation) {
    super("Projeto já está reservado para edição");
    this.dono = dono;
  }
}

function reservationPath(projeto: string): string {
  return join(projeto, EDIT_RESERVATION_FILE);
}

function validReservation(value: unknown): EditReservation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.tabId !== "string" || !item.tabId
    || typeof item.nome !== "string" || !item.nome
    || typeof item.ultimoSinal !== "number" || !Number.isFinite(item.ultimoSinal)) return null;
  return {
    tabId: item.tabId,
    nome: item.nome,
    ultimoSinal: item.ultimoSinal,
    ...(typeof item.assumidoEm === "number" && Number.isFinite(item.assumidoEm)
      ? { assumidoEm: item.assumidoEm } : {}),
  };
}

async function readReservation(projeto: string): Promise<EditReservation | null> {
  try {
    return validReservation(JSON.parse(await readFile(reservationPath(projeto), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function vigente(reserva: EditReservation | null, agora: number): EditReservation | null {
  if (!reserva || agora - reserva.ultimoSinal > EDIT_RESERVATION_TTL_MS) return null;
  return reserva;
}

async function gravar(projeto: string, reserva: EditReservation): Promise<void> {
  await publishAtomic(reservationPath(projeto), `${JSON.stringify(reserva)}\n`, { durable: true });
}

async function remover(projeto: string): Promise<void> {
  await unlink(reservationPath(projeto)).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
}

/** Lê a Reserva sob o mesmo mutex de escrita que publica as revisões. */
export async function estado(projeto: string, agora: number): Promise<EditReservation | null> {
  return withProjectWrite(projeto, async () => vigente(await readReservation(projeto), agora));
}

/** Obtém a Reserva; para o dono, o pedido é idempotente e renova o sinal. */
export async function obter(
  projeto: string, tabId: string, nome: string, agora: number,
): Promise<EditReservation> {
  return withProjectWrite(projeto, async () => {
    const atual = await readReservation(projeto);
    const dono = vigente(atual, agora);
    if (dono && dono.tabId !== tabId) throw new ReservationHeldError(dono);
    const reserva = {
      tabId, nome: dono?.tabId === tabId ? dono.nome : nome, ultimoSinal: agora,
      ...(dono?.assumidoEm === undefined ? {} : { assumidoEm: dono.assumidoEm }),
    };
    await gravar(projeto, reserva);
    return reserva;
  });
}

/** Renova uma Reserva da aba, inclusive quando ela expirou durante suspensão. */
export async function sinal(
  projeto: string, tabId: string, agora: number,
): Promise<EditReservation | null> {
  return withProjectWrite(projeto, async () => {
    const atual = await readReservation(projeto);
    if (!atual) return null;
    const dono = vigente(atual, agora);
    if (dono && dono.tabId !== tabId) throw new ReservationHeldError(dono);
    if (atual.tabId !== tabId) return null;
    const reserva = { ...atual, ultimoSinal: agora };
    await gravar(projeto, reserva);
    return reserva;
  });
}

/** Libera somente a Reserva da aba que a detém; repetição é idempotente. */
export async function liberar(projeto: string, tabId: string): Promise<void> {
  return withProjectWrite(projeto, async () => {
    const atual = await readReservation(projeto);
    if (atual?.tabId === tabId) await remover(projeto);
  });
}

/** Transfere a Reserva sem depender de ela estar expirada. */
export async function assumir(
  projeto: string, tabId: string, nome: string, agora: number,
): Promise<EditReservation> {
  return withProjectWrite(projeto, async () => {
    const reserva = { tabId, nome, ultimoSinal: agora, assumidoEm: agora };
    await gravar(projeto, reserva);
    return reserva;
  });
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function owner(reserva: EditReservation | null): { nome: string; ultimoSinal: number; assumidoEm?: number } | null {
  if (!reserva) return null;
  return {
    nome: reserva.nome,
    ultimoSinal: reserva.ultimoSinal,
    ...(reserva.assumidoEm === undefined ? {} : { assumidoEm: reserva.assumidoEm }),
  };
}

function tabFromHeader(req: IncomingMessage): string | undefined {
  const value = header(req, EDIT_RESERVATION_HEADER)?.trim();
  return value || undefined;
}

async function releaseBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size <= 16 * 1024) chunks.push(chunk as Buffer);
  }
  if (size > 16 * 1024) return undefined;
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    return typeof body.tabId === "string" ? body.tabId : undefined;
  } catch {
    return undefined;
  }
}

export type ReservationHttpDeps = {
  projeto: string;
  now: () => number;
  identity: (req: IncomingMessage) => string | undefined;
};

function conflict(res: ServerResponse, reserva: EditReservation | null, identidade: string): void {
  sendJson(res, {
    error: "Projeto reservado para edição",
    dono: owner(reserva),
    mesmaPessoa: reserva?.nome === identidade,
  }, 409);
}

/** Rotas públicas da Reserva e portão único das alterações do Projeto. */
export async function handleReservationRequest(
  req: IncomingMessage, res: ServerResponse, deps: ReservationHttpDeps,
): Promise<boolean> {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  const isReservation = pathname === "/reservation" || pathname.startsWith("/reservation/");
  if (!isReservation) return false;
  const agora = deps.now();
  const identidade = deps.identity(req) ?? "usuário local";
  let tabId = tabFromHeader(req);

  if (pathname === "/reservation" && req.method === "GET") {
    const reserva = await estado(deps.projeto, agora);
    sendJson(res, {
      reserva,
      reservation: reserva,
      dono: owner(reserva),
      minha: Boolean(tabId && reserva?.tabId === tabId),
      mesmaPessoa: Boolean(reserva && reserva.nome === identidade),
    });
    return true;
  }
  if (pathname === "/reservation" && req.method === "POST") {
    if (!tabId) { sendJson(res, { error: "header X-Decupa-Tab ausente" }, 400); return true; }
    try {
      const reserva = await obter(deps.projeto, tabId, identidade, agora);
      sendJson(res, { reserva, reservation: reserva, dono: null, minha: true });
    } catch (error) {
      if (!(error instanceof ReservationHeldError)) throw error;
      conflict(res, error.dono, identidade);
    }
    return true;
  }
  if (pathname === "/reservation/heartbeat" && req.method === "POST") {
    if (!tabId) { sendJson(res, { error: "header X-Decupa-Tab ausente" }, 400); return true; }
    try {
      // Sem arquivo, a aba que voltou de suspensão recupera a Reserva em
      // silêncio; se outra aba chegou antes, obter() conserva o conflito.
      const reserva = await sinal(deps.projeto, tabId, agora)
        ?? await obter(deps.projeto, tabId, identidade, agora);
      if (!reserva) { conflict(res, null, identidade); return true; }
      sendJson(res, { reserva, reservation: reserva, dono: null, minha: true });
    } catch (error) {
      if (!(error instanceof ReservationHeldError)) throw error;
      conflict(res, error.dono, identidade);
    }
    return true;
  }
  if (pathname === "/reservation/release" && req.method === "POST") {
    tabId ??= await releaseBody(req);
    if (!tabId) { sendJson(res, { error: "header X-Decupa-Tab ausente" }, 400); return true; }
    await liberar(deps.projeto, tabId);
    sendJson(res, { ok: true });
    return true;
  }
  if (pathname === "/reservation/take" && req.method === "POST") {
    if (!tabId) { sendJson(res, { error: "header X-Decupa-Tab ausente" }, 400); return true; }
    const reserva = await assumir(deps.projeto, tabId, identidade, agora);
    sendJson(res, { reserva, reservation: reserva, dono: null, minha: true });
    return true;
  }
  return false;
}

export async function requireEditReservation(
  req: IncomingMessage, res: ServerResponse, deps: ReservationHttpDeps,
): Promise<boolean> {
  const tabId = tabFromHeader(req);
  const reserva = await estado(deps.projeto, deps.now());
  // Clientes sem aba (scripts, curl e MCP) continuam podendo alterar um
  // Projeto livre. Eles não obtêm nem renovam a Reserva; quando há uma aba
  // editando, passam pelo mesmo conflito para não contornar o portão.
  if (!tabId && !reserva) return true;
  if (tabId && reserva?.tabId === tabId) return true;
  conflict(res, reserva, deps.identity(req) ?? "usuário local");
  return false;
}
