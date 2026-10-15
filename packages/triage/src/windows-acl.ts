const SID_RE = /^S-\d-\d+(?:-\d+)+$/i;

export type WindowsAclEntry = {
  identity: string;
  sid?: string;
  flags: string[];
  inherited: boolean;
  allow: boolean;
  fullControl: boolean;
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

export function parseIcaclsOutput(output: string): WindowsAclEntry[] {
  const entries: WindowsAclEntry[] = [];
  let sawHeader = false;
  for (const rawLine of output.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^(.+):((?:\([^)]*\))+)$/.exec(line);
    if (!sawHeader) {
      if (match) throw new Error("saída icacls inválida");
      sawHeader = true;
      continue;
    }
    if (!match) {
      if (line.includes(":(")) throw new Error("saída icacls inválida");
      continue;
    }
    const identity = match[1].trim().replace(/^\*/, "");
    if (!identity) throw new Error("saída icacls inválida");
    const flags = [...match[2].matchAll(/\(([^)]*)\)/g)].map(match => match[1].toUpperCase());
    const sid = SID_RE.test(identity) ? identity.toUpperCase() : undefined;
    entries.push({
      identity,
      ...(sid ? { sid } : {}),
      flags,
      inherited: flags.includes("I"),
      allow: !flags.includes("DENY"),
      fullControl: flags.includes("F"),
    });
  }
  if (!sawHeader || entries.length === 0) throw new Error("ACL das credenciais não confirmada");
  return entries;
}

export function isRestrictedAcl(entries: WindowsAclEntry[], sid: string): boolean {
  const expectedSid = sid.toUpperCase();
  return entries.length === 1 && entries[0].sid === expectedSid && entries[0].allow &&
    entries[0].fullControl && !entries[0].inherited;
}
