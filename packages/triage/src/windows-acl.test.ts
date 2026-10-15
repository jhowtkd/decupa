import { access, readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { restrictWindowsCredentials, type WindowsCommandRunner } from "./credentials.ts";
import { isRestrictedSddlAcl, parseIcaclsSaveOutput, parseWhoamiUserSid, resolveSddlSid } from "./windows-acl.ts";

const domainSid = "S-1-5-21-111111111-222222222-333333333-1104";
const localSid = "S-1-5-21-444444444-555555555-666666666-1001";

async function fixture(name: string): Promise<Buffer> {
  return readFile(new URL(`../fixtures/${name}`, import.meta.url));
}

// Capturas de `icacls <arquivo> /save <arquivo-temporário>`: o primeiro registro
// é o nome do arquivo e o seguinte é a SDDL, gravados em UTF-16LE (com ou sem BOM) e CRLF.
describe("parsing das saídas nativas de ACL do Windows", () => {
  it("extrai SID de usuário de domínio e local do CSV de whoami", async () => {
    expect(parseWhoamiUserSid((await fixture("windows-whoami-domain.csv")).toString("utf8"))).toBe(domainSid);
    expect(parseWhoamiUserSid((await fixture("windows-whoami-local.csv")).toString("utf8"))).toBe(localSid);
  });

  it("recusa saída whoami ambígua ou que não contenha SID", () => {
    expect(() => parseWhoamiUserSid("\"DOMÍNIO\\Ana\",\"não é SID\"\n")).toThrow();
    expect(() => parseWhoamiUserSid("\"DOMÍNIO\\Ana\",\"S-1-5-21-1\"\n\"DOMÍNIO\\Bia\",\"S-1-5-21-2\"\n")).toThrow();
  });

  it("aceita SDDL protegida com FA e com a máscara hexadecimal equivalente", async () => {
    const fa = parseIcaclsSaveOutput(await fixture("windows-icacls-save-fa.txt"));
    const mask = parseIcaclsSaveOutput(await fixture("windows-icacls-save-mask.txt"));
    expect(isRestrictedSddlAcl(fa, localSid)).toBe(true);
    expect(isRestrictedSddlAcl(mask, localSid)).toBe(true);
    expect(fa).toMatchObject({ protected: true, entries: [{ type: "A", sid: localSid, fullControl: true, inherited: false }] });
  });

  it.each([
    ["windows-icacls-save-extra.txt", "uma ACE extra"],
    ["windows-icacls-save-deny.txt", "uma ACE Deny"],
    ["windows-icacls-save-inherited.txt", "uma ACE herdida"],
    ["windows-icacls-save-unprotected.txt", "DACL sem P"],
    ["windows-icacls-save-other-sid.txt", "um SID diferente"],
  ])("recusa %s (%s)", async name => {
    expect(isRestrictedSddlAcl(parseIcaclsSaveOutput(await fixture(name)), localSid)).toBe(false);
  });

  it("aceita a mesma SDDL em UTF-16LE sem BOM e em UTF-8", async () => {
    const text = (await fixture("windows-icacls-save-fa.txt")).toString("utf16le").replace(/^﻿/, "");
    const expected = parseIcaclsSaveOutput(await fixture("windows-icacls-save-fa.txt"));
    expect(parseIcaclsSaveOutput(Buffer.from(text, "utf16le"))).toEqual(expected);
    expect(parseIcaclsSaveOutput(Buffer.from(text, "utf8"))).toEqual(expected);
  });

  it("resolve apelidos SDDL: fixos pela tabela e LA pelo domínio do usuário", () => {
    const save = (dacl: string) => parseIcaclsSaveOutput(Buffer.from(`\uFEFFcredenciais.json\r\n${dacl}\r\n`, "utf16le"));
    const builtinAdmin = "S-1-5-21-444444444-555555555-666666666-500";
    const own = save("D:PAI(A;;FA;;;LA)");
    expect(own.entries[0]).toMatchObject({ alias: "LA" });
    expect(resolveSddlSid(own.entries[0]!, builtinAdmin)).toBe(builtinAdmin);
    expect(isRestrictedSddlAcl(own, builtinAdmin)).toBe(true);
    expect(isRestrictedSddlAcl(own, localSid)).toBe(false);
    expect(resolveSddlSid(own.entries[0]!, "S-1-5-18")).toBeUndefined();
    const system = save("O:BAG:SYD:PAI(A;;FA;;;SY)(A;;FA;;;BA)");
    expect(system.entries.map(entry => entry.sid)).toEqual(["S-1-5-18", "S-1-5-32-544"]);
    expect(system.sddl).toBe("O:BAG:SYD:PAI(A;;FA;;;SY)(A;;FA;;;BA)");
    expect(resolveSddlSid(save("D:PAI(A;;FA;;;ZZ)").entries[0]!, localSid)).toBeUndefined();
  });

  it("recusa saída vazia ou em codificação desconhecida", () => {
    expect(() => parseIcaclsSaveOutput(Buffer.alloc(0))).toThrow(/codificação desconhecida/);
    expect(() => parseIcaclsSaveOutput(Buffer.from([0x00, 0x43, 0x00]))).toThrow(/codificação desconhecida/);
  });

  it("falha fechado para SDDL ausente, truncada ou com ACE não interpretável", async () => {
    expect(() => parseIcaclsSaveOutput(Buffer.from("\uFEFFC:\\credenciais\r\nD:PAI\r\n", "utf16le"))).toThrow();
    expect(() => parseIcaclsSaveOutput(Buffer.from("\uFEFFC:\\credenciais\r\nD:PAI(A;;FA;;;S-1-5-21-1", "utf16le"))).toThrow();
    expect(() => parseIcaclsSaveOutput(Buffer.from("\uFEFFC:\\credenciais\r\nD:PAI(X;;FA;;;S-1-5-21-1)\r\n", "utf16le"))).toThrow();
  });

  it("confirma pela SDDL produzida no arquivo temporário e passa o caminho como argumento", async () => {
    const path = "C:\\Projetos\\Meu Projetoá\\credenciais %.json";
    const calls: { executable: string; args: string[]; options: Parameters<WindowsCommandRunner>[2] }[] = [];
    let savePath: string | undefined;
    const execute: WindowsCommandRunner = async (executable, args, options) => {
      calls.push({ executable, args, options });
      if (executable === "whoami.exe") return { stdout: `"CONTOSO\\\\Ana","${localSid}"\n` };
      if (args[1] === "/save") {
        savePath = args[2];
        await writeFile(args[2]!, await fixture("windows-icacls-save-fa.txt"));
      }
      return { stdout: "" };
    };

    await restrictWindowsCredentials(path, execute);

    expect(calls.map(call => [call.executable, call.args.slice(0, 2)])).toEqual([
      ["whoami.exe", ["/user", "/fo"]],
      ["icacls.exe", [path, "/inheritance:r"]],
      ["icacls.exe", [path, "/save"]],
    ]);
    expect(calls.every(call => call.options?.shell === false && call.options?.timeout === 30_000)).toBe(true);
    await expect(access(savePath!)).rejects.toThrow();
  });

  it("remove ACEs extras usando somente os SIDs da SDDL", async () => {
    const path = "C:\\Projetos\\credenciais %.json";
    const calls: string[][] = [];
    let saves = 0;
    const execute: WindowsCommandRunner = async (executable, args) => {
      calls.push([executable, ...args]);
      if (executable === "whoami.exe") return { stdout: `"CONTOSO\\\\Ana","${localSid}"\n` };
      if (args[1] === "/save") {
        saves++;
        await writeFile(args[2]!, await fixture(saves === 1 ? "windows-icacls-save-extra.txt" : "windows-icacls-save-fa.txt"));
      }
      return { stdout: "" };
    };

    await restrictWindowsCredentials(path, execute);

    expect(calls).toContainEqual(["icacls.exe", path, "/remove:g", `*${localSid}`]);
    expect(calls).toContainEqual(["icacls.exe", path, "/remove:g", "*S-1-1-0"]);
    expect(calls.some(call => call.includes("DESKTOP\\x") || call.includes("Administrators"))).toBe(false);
  });

  it("restringe o Administrador embutido, que a SDDL mostra como LA", async () => {
    const path = "C:\\Users\\Administrador\\credenciais.json";
    const builtinAdmin = "S-1-5-21-444444444-555555555-666666666-500";
    const calls: string[][] = [];
    let saves = 0;
    const execute: WindowsCommandRunner = async (executable, args) => {
      calls.push([executable, ...args]);
      if (executable === "whoami.exe") return { stdout: `"DESKTOP\\\\Administrador","${builtinAdmin}"\n` };
      if (args[1] === "/save") {
        saves++;
        const dacl = saves === 1 ? "D:PAI(A;;FA;;;LA)(A;;FA;;;SY)" : "D:PAI(A;;FA;;;LA)";
        await writeFile(args[2]!, Buffer.from(`credenciais.json\r\n${dacl}\r\n`, "utf16le"));
      }
      return { stdout: "" };
    };

    await restrictWindowsCredentials(path, execute);

    expect(calls).toContainEqual(["icacls.exe", path, "/remove:g", `*${builtinAdmin}`]);
    expect(calls).toContainEqual(["icacls.exe", path, "/remove:g", "*S-1-5-18"]);
  });
});
