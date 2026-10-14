import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { mtimeCached } from "./config-cache.ts";
import { createCredentialsReader, readAnalysisCredentials } from "./analysis-credentials.ts";
import { readCredentials, writeCredentials } from "./credentials.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function folder() { const dir = await mkdtemp(join(tmpdir(), "config-cache-")); dirs.push(dir); return dir; }

it("polls reusam leitura, mas cada snapshot é independente; gravar e remover invalidam credenciais", async () => {
  const project = await folder(), user = await folder();
  await writeCredentials(project, { preset: "zai", apiKey: "text" });
  await writeCredentials(user, { preset: "zai", apiKey: "user-text", typesafe: true, typesafeApiKey: "old-key" });
  const load = vi.fn(readCredentials), read = createCredentialsReader(load);
  const first = (await readAnalysisCredentials(project, user, read))!;
  first.typesafeApiKey = "mutated";
  for (let i = 0; i < 5; i++) expect((await readAnalysisCredentials(project, user, read))?.typesafeApiKey).toBe("old-key");
  expect(load).toHaveBeenCalledTimes(2);
  await writeCredentials(user, { preset: "zai", apiKey: "user-text", typesafeApiKey: "new-key" });
  expect((await readAnalysisCredentials(project, user, read))?.typesafeApiKey).toBe("new-key");
  expect(load).toHaveBeenCalledTimes(3);
  await writeCredentials(user, { preset: "zai", apiKey: "user-text", typesafe: false }, { removeKeys: ["typesafeApiKey"] });
  expect(await readAnalysisCredentials(project, user, read)).toMatchObject({ typesafe: false });
  expect((await readAnalysisCredentials(project, user, read))?.typesafeApiKey).toBeUndefined();
  expect(load).toHaveBeenCalledTimes(4);
});

it("decision.json ausente, inválido e reparado mudam somente quando o arquivo muda", async () => {
  const dir = await folder(), path = join(dir, "decision.json");
  const load = vi.fn(async (path: string) => {
    const text = await readFile(path, "utf8").catch(error => { if (error.code === "ENOENT") return "null"; throw error; });
    return JSON.parse(text);
  }), read = mtimeCached(load);
  await read(path); await read(path); expect(load).toHaveBeenCalledTimes(1);
  await writeFile(path, "broken");
  await expect(read(path)).rejects.toThrow(); await expect(read(path)).rejects.toThrow(); expect(load).toHaveBeenCalledTimes(2);
  await writeFile(path, '{"mode":"observe","model":"custom"}');
  expect(await read(path)).toEqual({ mode: "observe", model: "custom" }); expect(load).toHaveBeenCalledTimes(3);
  await unlink(path); expect(await read(path)).toBeNull(); expect(load).toHaveBeenCalledTimes(4);
});

it("invalidação explícita do leitor atualiza chave e remoção mesmo sem mudança de metadados", async () => {
  const user = await folder(); let key: string | undefined = "old-key";
  // O arquivo fica ausente: seu carimbo não muda entre os snapshots deste teste.
  const load = vi.fn(async () => ({ preset: "zai" as const, apiKey: "text", ...(key ? { typesafeApiKey: key } : {}) }));
  const read = createCredentialsReader(load), first = await read(user);
  key = "new-key"; expect((await read(user))?.typesafeApiKey).toBe("old-key");
  read.invalidate(user); expect((await read(user))?.typesafeApiKey).toBe("new-key");
  key = undefined; read.invalidate(user); expect(await read(user)).not.toHaveProperty("typesafeApiKey");
  expect(first?.typesafeApiKey).toBe("old-key"); expect(load).toHaveBeenCalledTimes(3);
});
