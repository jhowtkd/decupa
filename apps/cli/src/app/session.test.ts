import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initialKeepList, keepPath, readKeepList, writeKeepList } from "./session.ts";

describe("readKeepList", () => {
  it("devolve null quando não há sessão gravada", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-sess-"));
    expect(await readKeepList(dir)).toBeNull();
  });

  it("faz ida e volta da mesma string que o --keep consome", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-sess-"));
    await writeKeepList(dir, "u001-u003 u005");
    expect(await readKeepList(dir)).toBe("u001-u003 u005");
  });

  it("trata arquivo em branco como ausência", async () => {
    // Um keep vazio não é "nada fica": é arquivo truncado. Devolvê-lo faria o
    // ingest planejar com --keep sem faixa nenhuma, e o motor estouraria numa
    // mensagem que não descreve o problema real.
    const dir = await mkdtemp(join(tmpdir(), "decupa-sess-"));
    await writeFile(keepPath(dir), "  \n", "utf8");
    expect(await readKeepList(dir)).toBeNull();
  });
});

describe("initialKeepList", () => {
  it("usa a sessão gravada quando ela existe", () => {
    expect(initialKeepList("u002-u003", ["u001", "u002", "u003"])).toBe("u002-u003");
  });

  it("sem sessão, começa com tudo, da primeira à última unidade", () => {
    expect(initialKeepList(null, ["u001", "u002", "u003"])).toBe("u001-u003");
  });

  it("estoura quando o índice não tem unidade nenhuma", () => {
    expect(() => initialKeepList(null, [])).toThrow(/unidade/);
  });
});
