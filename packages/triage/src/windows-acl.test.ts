import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { restrictWindowsCredentials, type WindowsCommandRunner } from "./credentials.ts";
import { parseIcaclsOutput, parseWhoamiUserSid, isRestrictedAcl } from "./windows-acl.ts";

const domainSid = "S-1-5-21-111111111-222222222-333333333-1104";
const localSid = "S-1-5-21-444444444-555555555-666666666-1001";

async function fixture(name: string): Promise<string> {
  return readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
}

describe("parsing das saídas nativas de ACL do Windows", () => {
  it("extrai SID de usuário de domínio e preserva o formato CSV sem depender do idioma", async () => {
    expect(parseWhoamiUserSid(await fixture("windows-whoami-domain.csv"))).toBe(domainSid);
    expect(parseWhoamiUserSid(await fixture("windows-whoami-local.csv"))).toBe(localSid);
  });

  it("recusa saída whoami ambígua ou que não contenha SID", () => {
    expect(() => parseWhoamiUserSid("\"DOMÍNIO\\Ana\",\"não é SID\"\n")).toThrow();
    expect(() => parseWhoamiUserSid("\"DOMÍNIO\\Ana\",\"S-1-5-21-1\"\n\"DOMÍNIO\\Bia\",\"S-1-5-21-2\"\n")).toThrow();
  });

  it("lê caminho com espaço, acento e percentagem e marca herança pelas flags", async () => {
    const entries = parseIcaclsOutput(await fixture("windows-icacls-inherited.txt"));
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ identity: "CONTOSO\\Ana Oliveira", inherited: true, fullControl: true });
    expect(entries[1]).toMatchObject({ identity: "BUILTIN\\Administrators", inherited: true, fullControl: true });
    expect(entries[2]).toMatchObject({ identity: domainSid, inherited: false, allow: true, fullControl: true });
    expect(isRestrictedAcl(entries, domainSid)).toBe(false);
  });

  it("ignora o resumo localizado e identifica entradas extras e negação sem texto em inglês", async () => {
    const entries = parseIcaclsOutput(await fixture("windows-icacls-extras-localized.txt"));
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ identity: localSid, inherited: false, allow: true, fullControl: true });
    expect(entries[1]).toMatchObject({ identity: "S-1-1-0", allow: false, fullControl: false });
    expect(entries[2]).toMatchObject({ identity: "S-1-5-32-544", inherited: false, fullControl: true });
    expect(isRestrictedAcl(entries, localSid)).toBe(false);
  });

  it("aceita somente uma regra Allow não herdada do SID atual com controle total", () => {
    const entries = parseIcaclsOutput("C:\\credenciais %.json\nS-1-5-21-1:(F)\n");
    expect(isRestrictedAcl(entries, "S-1-5-21-1")).toBe(true);
    expect(isRestrictedAcl(parseIcaclsOutput("C:\\credenciais %.json\nS-1-5-21-1:(I)(F)\n"), "S-1-5-21-1")).toBe(false);
    expect(isRestrictedAcl(parseIcaclsOutput("C:\\credenciais %.json\nS-1-5-21-1:(R)\n"), "S-1-5-21-1")).toBe(false);
  });

  it("falha fechado quando a saída contém uma linha de ACL que não pode ser analisada", () => {
    expect(() => parseIcaclsOutput("C:\\credenciais %.json\nS-1-5-21-1:(F)\nentrada ACL inválida:(F\n")).toThrow();
    expect(() => parseIcaclsOutput("S-1-5-21-1:(F)\n")).toThrow();
  });

  it("usa executáveis nativos com caminho como argumento e timeout curto", async () => {
    const path = "C:\\Projetos\\Meu Projeto\u00e1\\credenciais %.json";
    const calls: { executable: string; args: string[]; options: Parameters<WindowsCommandRunner>[2] }[] = [];
    const execute: WindowsCommandRunner = async (executable, args, options) => {
      calls.push({ executable, args, options });
      if (executable === "whoami.exe") return { stdout: `"CONTOSO\\\\Ana","${domainSid}"\n` };
      if (args.length === 1) return { stdout: `${path}\n${domainSid}:(F)\n` };
      return { stdout: "" };
    };

    await restrictWindowsCredentials(path, execute);

    expect(calls.map(call => [call.executable, call.args])).toEqual([
      ["whoami.exe", ["/user", "/fo", "csv", "/nh"]],
      ["icacls.exe", [path, "/inheritance:r", "/grant:r", `*${domainSid}:F`]],
      ["icacls.exe", [path]],
    ]);
    expect(calls.every(call => call.options?.shell === false && call.options?.timeout === 30_000)).toBe(true);
  });

  it("remove entradas extras antes de confirmar a ACL final", async () => {
    const path = "C:\\Projetos\\credenciais %.json";
    const calls: string[][] = [];
    let reads = 0;
    const execute: WindowsCommandRunner = async (executable, args) => {
      calls.push([executable, ...args]);
      if (executable === "whoami.exe") return { stdout: `"CONTOSO\\\\Ana","${domainSid}"\n` };
      if (args.length === 1) {
        reads++;
        return { stdout: reads === 1
          ? `${path}\n${domainSid}:(F)\nS-1-1-0:(R)\n`
          : `${path}\n${domainSid}:(F)\n` };
      }
      return { stdout: "" };
    };

    await restrictWindowsCredentials(path, execute);

    expect(calls.slice(3, 7)).toEqual([
      ["icacls.exe", path, "/remove:g", `*${domainSid}`],
      ["icacls.exe", path, "/remove:g", "*S-1-1-0"],
      ["icacls.exe", path, "/inheritance:r", "/grant:r", `*${domainSid}:F`],
      ["icacls.exe", path],
    ]);
  });

  it("não continua se a confirmação da ACL não puder ser analisada", async () => {
    const calls: string[] = [];
    const execute: WindowsCommandRunner = async (executable, args) => {
      calls.push(`${executable} ${args.join(" ")}`);
      if (executable === "whoami.exe") return { stdout: `"CONTOSO\\\\Ana","${domainSid}"\n` };
      return { stdout: "saída localizada sem entradas legíveis\n" };
    };

    await expect(restrictWindowsCredentials("C:\\credenciais %.json", execute)).rejects.toThrow(/ACL/);
    expect(calls).toHaveLength(3);
  });
});
