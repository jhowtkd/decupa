import { Buffer } from "node:buffer";

const SID_RE = /^S-\d-\d+(?:-\d+)+$/i;
const FULL_CONTROL_MASK = 0x1f01ff;

export type SddlAclEntry = {
  type: "A" | "D";
  flags: string[];
  rights: string;
  sid?: string;
  inherited: boolean;
  fullControl: boolean;
};

export type ParsedSddlAcl = {
  fileName: string;
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

function decodeIcaclsSave(output: Uint8Array): string {
  if (output.byteLength < 2 || output[0] !== 0xff || output[1] !== 0xfe || output.byteLength % 2 !== 0) {
    throw new Error("saída icacls /save não está em UTF-16LE");
  }
  const text = Buffer.from(output).toString("utf16le");
  if (!text.startsWith("\uFEFF")) throw new Error("saída icacls /save sem BOM");
  return text.slice(1);
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
  const sid = SID_RE.test(rawSid) ? rawSid.toUpperCase() : undefined;
  const normalizedRights = rights.toUpperCase();
  const fullControl = normalizedRights === "FA" ||
    (/^0X[0-9A-F]+$/.test(normalizedRights) && Number.parseInt(normalizedRights.slice(2), 16) === FULL_CONTROL_MASK);
  return { type, flags, rights: normalizedRights, ...(sid ? { sid } : {}), inherited: flags.includes("ID"), fullControl };
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
  return { fileName: lines[0], protected: controls.includes("P"), entries };
}

export function isRestrictedSddlAcl(acl: ParsedSddlAcl, sid: string): boolean {
  const expectedSid = sid.toUpperCase();
  return acl.protected && acl.entries.length === 1 && acl.entries[0].type === "A" &&
    acl.entries[0].sid === expectedSid && !acl.entries[0].inherited && acl.entries[0].fullControl;
}
