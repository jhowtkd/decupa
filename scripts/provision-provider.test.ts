import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

it("provisionamento cita as chaves opcionais e grava três chaves falsas só no usuário temporário", async () => {
  const dir = await mkdtemp(join(tmpdir(), "provision-keys-")); dirs.push(dir);
  const script = fileURLToPath(new URL("./provision-provider.ts", import.meta.url));
  // O processo filho não herda segredos, nem o diretório real do usuário.
  const env = { PATH: process.env.PATH, HOME: dir, USERPROFILE: dir };
  const run = (extra = {}) => promisify(execFile)(process.execPath, ["--experimental-strip-types", script], { env: { ...env, ...extra } });
  const absent = await run();
  expect(absent.stdout).toContain("DECUPA_COMPANY_OPENAI_API_KEY");
  expect(absent.stdout).toContain("TYPESAFE_API_KEY");
  const installed = await run({ DECUPA_COMPANY_API_KEY: "fake-text", DECUPA_COMPANY_OPENAI_API_KEY: "fake-luna", TYPESAFE_API_KEY: "fake-jev", DECUPA_TYPESAFE: "1" });
  expect(installed.stdout).not.toMatch(/fake-text|fake-luna|fake-jev/);
  const path = join(dir, ".decupa", "credentials");
  const saved = await readFile(path, "utf8");
  expect(JSON.parse(saved)).toMatchObject({ apiKey: "fake-text", openaiApiKey: "fake-luna", typesafeApiKey: "fake-jev", typesafe: true });
  if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await run({ DECUPA_COMPANY_API_KEY: "replace-text", OPENAI_API_KEY: "replace-luna", TYPESAFE_API_KEY: "replace-jev" })).stdout).toContain("nenhuma chave foi sobrescrita");
  expect(await readFile(path, "utf8")).toBe(saved);
});
