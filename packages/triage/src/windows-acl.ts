import { Buffer } from "node:buffer";

const SID_RE = /^S-\d-\d+(?:-\d+)+$/i;
const FULL_CONTROL_MASK = 0x1f01ff;

export type SddlAclEntry = {
  type: "A" | "D";
  flags: string[];
  rights: string;
  sid?: string;
  /** Apelido SDDL que só vira SID relativo ao domínio (ex.: `LA`). */
  alias?: string;
  inherited: boolean;
  fullControl: boolean;
};

export type ParsedSddlAcl = {
  fileName: string;
  sddl: string;
  protected: boolean;
  entries: SddlAclEntry[];
};

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      fields.push(field);
      field = "";
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error("saída whoami inválida");
  fields.push(field);
  return fields;
}

export function parseWhoamiUserSid(output: string): string {
  const lines = output.replace(/^\uFEFF/, "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length !== 1) throw new Error("SID do usuário atual não confirmado");
  const fields = parseCsvLine(lines[0]);
  const sid = fields.length === 2 ? fields[1].trim().toUpperCase() : "";
  if (!SID_RE.test(sid)) throw new Error("SID do usuário atual não confirmado");
  return sid;
}

/**
 * O `icacls /save` grava UTF-16LE, mas o BOM não é garantido. Sem BOM, o
 * UTF-16LE aparece pelo byte nulo depois do primeiro caractere ASCII. A
 * validação estrita da SDDL logo depois mantém a falha fechada.
 */
function decodeIcaclsSave(output: Uint8Array): string {
  const bytes = Buffer.from(output);
  const utf16 = bytes.byteLength >= 2 && bytes.byteLength % 2 === 0
    && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] !== 0 && bytes[1] === 0));
  if (utf16) return bytes.toString("utf16le").replace(/^\uFEFF/, "");
  if (bytes.byteLength > 0 && !bytes.includes(0)) return bytes.toString("utf8").replace(/^\uFEFF/, "");
  throw new Error(`saída icacls /save em codificação desconhecida (início: ${bytes.subarray(0, 8).toString("hex") || "vazio"})`);
}

// A SDDL abrevia SIDs conhecidos. Os fixos viram SID direto; os relativos ao
// domínio dependem do prefixo da conta e são resolvidos em `resolveSddlSid`.
const WELL_KNOWN_SDDL_SIDS: Record<string, string> = {
  AN: "S-1-5-7", AU: "S-1-5-11", BA: "S-1-5-32-544", BG: "S-1-5-32-546",
  BO: "S-1-5-32-551", BU: "S-1-5-32-545", CG: "S-1-3-1", CO: "S-1-3-0",
  ED: "S-1-5-9", IU: "S-1-5-4", LS: "S-1-5-19", NS: "S-1-5-20",
  NU: "S-1-5-2", OW: "S-1-3-4", PS: "S-1-5-10", PU: "S-1-5-32-547",
  RC: "S-1-5-12", RD: "S-1-5-32-555", RU: "S-1-5-32-554", SO: "S-1-5-32-549",
  SU: "S-1-5-6", SY: "S-1-5-18", WD: "S-1-1-0", WR: "S-1-5-33",
  AC: "S-1-15-2-1", AO: "S-1-5-32-548", PO: "S-1-5-32-550", RE: "S-1-5-32-552",
  NO: "S-1-5-32-556", MU: "S-1-5-32-558", LU: "S-1-5-32-559", IS: "S-1-5-32-568",
  RM: "S-1-5-32-580",
};
const DOMAIN_RELATIVE_SDDL_RIDS: Record<string, number> = {
  LA: 500, LG: 501, DA: 512, DU: 513, DG: 514, DC: 515, DD: 516, CA: 517,
  SA: 518, EA: 519, PA: 520, RS: 553, RO: 498, CN: 522, AP: 525,
};

/**
 * SID efetivo da ACE. Apelidos de domínio usam o prefixo do SID do usuário:
 * cobre a conta local (o Administrador embutido aparece como `LA`). Para outro
 * domínio o SID resolvido não bate e a verificação continua falhando fechada.
 */
export function resolveSddlSid(entry: SddlAclEntry, userSid: string): string | undefined {
  if (entry.sid) return entry.sid;
  const rid = entry.alias ? DOMAIN_RELATIVE_SDDL_RIDS[entry.alias] : undefined;
  if (rid === undefined) return undefined;
  const domain = userSid.toUpperCase().replace(/-\d+$/, "");
  return /^S-1-5-21-\d+-\d+-\d+$/.test(domain) ? `${domain}-${rid}` : undefined;
}

function parseAce(raw: string): SddlAclEntry {
  const fields = raw.split(";");
  if (fields.length !== 6 || (fields[0] !== "A" && fields[0] !== "D")) {
    throw new Error("ACE SDDL não interpretável");
  }
  const [type, rawFlags, rights, objectGuid, inheritObjectGuid, rawSid] = fields;
  if (objectGuid || inheritObjectGuid) throw new Error("ACE SDDL não interpretável");
  const flags: string[] = rawFlags ? rawFlags.match(/.{2}/g) ?? [] : [];
  if (flags.join("") !== rawFlags) throw new Error("ACE SDDL não interpretável");
  const upperSid = rawSid.toUpperCase();
  const sid = SID_RE.test(rawSid) ? upperSid : WELL_KNOWN_SDDL_SIDS[upperSid];
  const alias = !sid && /^[A-Z]{2}$/.test(upperSid) ? upperSid : undefined;
  const normalizedRights = rights.toUpperCase();
  const fullControl = normalizedRights === "FA" ||
    (/^0X[0-9A-F]+$/.test(normalizedRights) && Number.parseInt(normalizedRights.slice(2), 16) === FULL_CONTROL_MASK);
  return { type, flags, rights: normalizedRights, ...(sid ? { sid } : {}), ...(alias ? { alias } : {}), inherited: flags.includes("ID"), fullControl };
}

export function parseIcaclsSaveOutput(output: Uint8Array): ParsedSddlAcl {
  const lines = decodeIcaclsSave(output).split(/\r?\n/).filter(Boolean);
  if (lines.length !== 2 || !lines[0] || !lines[1]) throw new Error("saída icacls /save incompleta");
  const sddl = lines[1];
  const daclStart = sddl.indexOf("D:");
  if (daclStart < 0) throw new Error("DACL SDDL não confirmada");
  const dacl = sddl.slice(daclStart + 2);
  const firstAce = dacl.indexOf("(");
  if (firstAce < 0) throw new Error("DACL SDDL sem ACE");
  const controls = dacl.slice(0, firstAce);
  const controlFlags = controls.match(/P|AI|AR|A/g) ?? [];
  if (controlFlags.join("") !== controls) throw new Error("flags da DACL SDDL não interpretáveis");

  const entries: SddlAclEntry[] = [];
  let cursor = firstAce;
  while (cursor < dacl.length && dacl[cursor] === "(") {
    let depth = 0;
    let end = cursor;
    for (; end < dacl.length; end++) {
      if (dacl[end] === "(") depth++;
      else if (dacl[end] === ")" && --depth === 0) break;
      else if (dacl[end] === ")" && depth < 0) throw new Error("ACE SDDL truncada");
    }
    if (end >= dacl.length || depth !== 0) throw new Error("ACE SDDL truncada");
    entries.push(parseAce(dacl.slice(cursor + 1, end)));
    cursor = end + 1;
  }
  if (cursor < dacl.length && !dacl.slice(cursor).startsWith("S:")) throw new Error("DACL SDDL não interpretável");
  if (entries.length === 0) throw new Error("DACL SDDL sem ACE");
  return { fileName: lines[0], sddl, protected: controls.includes("P"), entries };
}

export function isRestrictedSddlAcl(acl: ParsedSddlAcl, sid: string): boolean {
  const expectedSid = sid.toUpperCase();
  return acl.protected && acl.entries.length === 1 && acl.entries[0].type === "A" &&
    resolveSddlSid(acl.entries[0], expectedSid) === expectedSid && !acl.entries[0].inherited && acl.entries[0].fullControl;
}
