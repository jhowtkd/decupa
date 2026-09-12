import { chmod, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { credentialsPath, readCredentials, writeCredentials } from "./credentials.ts";

describe("credentials", () => {
  it("grava e lê sem logar a chave", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-cred-"));
    const path = await writeCredentials(dir, {
      preset: "minimax",
      model: "MiniMax-M2",
      baseUrl: "https://api.minimax.io/v1/chat/completions",
      apiKey: "segredo-teste",
    });
    expect(path).toBe(credentialsPath(dir));
    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
    const loaded = await readCredentials(dir);
    expect(loaded?.preset).toBe("minimax");
    expect(loaded?.apiKey).toBe("segredo-teste");
    const disk = await readFile(path, "utf8");
    expect(disk).toContain("segredo-teste");
  });

  it("devolve null quando não há arquivo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-cred-"));
    expect(await readCredentials(dir)).toBeNull();
  });

  it("recusa diretório relativo", () => {
    expect(() => credentialsPath("projeto")).toThrow(/absoluto/);
  });

  it("restringe arquivo 0644 existente antes de reescrever", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-cred-"));
    const path = credentialsPath(dir);
    await writeCredentials(dir, { preset: "zai" });
    await chmod(path, 0o644);
    await writeCredentials(dir, { preset: "zai", apiKey: "nova" });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
