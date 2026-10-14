import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { writeCredentials } from "@decupa/triage";
import { settingsTokens } from "./provider-visual.ts";
import { startApp } from "./server.ts";

const cssFixture = vi.hoisted(() => ({ removeMarker: false }));
// Só a leitura do CSS é alterada: simula uma edição sem mexer no arquivo da bancada.
vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, readFile: async (...args: Parameters<typeof fs.readFile>) => {
    const value = await fs.readFile(...args);
    return cssFixture.removeMarker && String(args[0]).endsWith("/assembly/page.css") && typeof value === "string"
      ? value.replace("/* == base == */", "") : value;
  } };
});

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { cssFixture.removeMarker = false; for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function folder() {
  const dir = await mkdtemp(join(tmpdir(), "settings-tokens-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true })); return dir;
}
async function boot() {
  const user = await folder(), projectDir = await folder();
  await writeCredentials(user, { preset: "zai", apiKey: "fake-zai-key" });
  const app = await startApp({ projectDir, providerConfigDir: user, port: 0, env: {}, fetchImpl: async () => { throw new Error("Rede de provedor proibida neste teste"); } });
  cleanup.push(() => app.close());
  return `http://127.0.0.1:${app.port}`;
}

it("o extrator devolve só tokens e exige a divisão explícita do CSS", () => {
  expect(settingsTokens(":root{--ink:red}\n/* == base == */\nbody{overflow:hidden}")).toBe(":root{--ink:red}\n");
  expect(() => settingsTokens(":root{--ink:red}\nbody{overflow:hidden}"))
    .toThrow("Tokens de Configurações indisponíveis: falta o marcador de base do CSS.");
});

it("o CSS real contém o marcador e a rota serve os tokens sem a casca da bancada", async () => {
  const source = await readFile(new URL("./assembly/page.css", import.meta.url), "utf8");
  expect(source).toContain("/* == base == */");
  const response = await fetch(await boot() + "/settings/tokens.css");
  expect(response.status).toBe(200);
  const css = await response.text();
  expect(css).toContain("--ground: #0B0C0E"); expect(css).toContain("--radius-card: 16px");
  expect(css).not.toContain("/* == base == */"); expect(css).not.toContain("overflow: hidden");
});

it("sem o marcador a rota falha com 500 e erro explícito, sem servir o CSS inteiro", async () => {
  const base = await boot(); cssFixture.removeMarker = true;
  const response = await fetch(base + "/settings/tokens.css");
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "Tokens de Configurações indisponíveis: falta o marcador de base do CSS." });
});
