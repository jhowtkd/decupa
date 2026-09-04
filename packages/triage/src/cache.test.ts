import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cacheKey, readCache, writeCache } from "./cache.ts";

const parts = {
  videoSha: "abc",
  indexSha: "def",
  promptVersion: "v1",
  model: "gemini-3.8-flash",
  pass: "structure" as const,
};

describe("cacheKey", () => {
  it("é estável para as mesmas entradas", () => {
    expect(cacheKey(parts)).toBe(cacheKey({ ...parts }));
  });

  it("muda quando a versão do prompt muda", () => {
    expect(cacheKey({ ...parts, promptVersion: "v2" })).not.toBe(cacheKey(parts));
  });

  it("muda quando o passe muda, para --target não invalidar o passe 1", () => {
    expect(cacheKey({ ...parts, pass: "density" })).not.toBe(cacheKey(parts));
  });

  it("muda quando o orçamento de densidade muda", () => {
    const d1 = cacheKey({ ...parts, pass: "density", budgetSeconds: 10.0 });
    const d2 = cacheKey({ ...parts, pass: "density", budgetSeconds: 20.0 });
    expect(d1).not.toBe(d2);
  });

  it("é seguro como nome de arquivo", () => {
    expect(cacheKey(parts)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("readCache / writeCache", () => {
  it("devolve null quando não há nada gravado", async () => {
    const dir = await mkdtemp(join(tmpdir(), "triage-"));
    expect(await readCache(dir, cacheKey(parts))).toBeNull();
  });

  it("devolve o que foi gravado", async () => {
    const dir = await mkdtemp(join(tmpdir(), "triage-"));
    await writeCache(dir, cacheKey(parts), [{ unit_ids: ["u001"] }]);
    expect(await readCache(dir, cacheKey(parts))).toEqual([{ unit_ids: ["u001"] }]);
  });

  it("trata cache corrompido como ausente em vez de estourar", async () => {
    const dir = await mkdtemp(join(tmpdir(), "triage-"));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, `${cacheKey(parts)}.json`), "{ isso não é json", "utf8");
    expect(await readCache(dir, cacheKey(parts))).toBeNull();
  });

  it("cria o diretório se ainda não existir", async () => {
    const dir = join(tmpdir(), `triage-nested-${Date.now()}`, "sub");
    await writeCache(dir, cacheKey(parts), { ok: true });
    expect(await readCache(dir, cacheKey(parts))).toEqual({ ok: true });
  });
});
