import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { operationResolver } from "./analysis-operation.ts";

const muse = { preset: "custom" as const, apiKey: "meta-fake", model: "muse-spark-1.3-contributor", baseUrl: "https://api.meta.ai/v1/chat/completions" };
const success = (text: string) => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: text } }] }));

async function dir() { return mkdtemp(join(tmpdir(), "operation-resolver-")); }

it("sem enableText nem proposeSend injetado, a Montagem não ganha proposeSend (Limpeza/Jev isolados)", async () => {
  const resolve = operationResolver({ dir: await dir(), loadStored: async () => muse, env: {}, enableVisual: false });
  const deps = await resolve();
  expect(deps).not.toHaveProperty("proposeSend");
});

it("enableText:true resolve proposeSend a partir do texto da Montagem (Muse por padrão)", async () => {
  const calls: string[] = [];
  const fetchImpl = (async url => { calls.push(String(url)); return success("{}"); }) as typeof fetch;
  const resolve = operationResolver({ dir: await dir(), loadStored: async () => muse, env: {}, fetchImpl, enableVisual: false, enableText: true });
  const deps = await resolve();
  await deps.proposeSend!([{ type: "text", text: "proposta" }]);
  expect(calls).toEqual([muse.baseUrl]);
});

it("DECUPA_ASSEMBLY_TEXT_PROVIDER=openai com chave: proposeSend da Montagem vai ao Sol", async () => {
  const calls: { url: string; model: string }[] = [];
  const fetchImpl = (async (url, init) => { calls.push({ url: String(url), model: JSON.parse(String(init?.body)).model }); return success("{}"); }) as typeof fetch;
  const resolve = operationResolver({ dir: await dir(), loadStored: async () => muse, env: { DECUPA_ASSEMBLY_TEXT_PROVIDER: "openai", OPENAI_API_KEY: "sol-fake" }, fetchImpl, enableVisual: false, enableText: true });
  const deps = await resolve();
  await deps.proposeSend!([{ type: "text", text: "proposta" }]);
  expect(calls).toEqual([{ url: "https://api.openai.com/v1/chat/completions", model: "gpt-6.1-sol" }]);
});

it("um proposeSend explícito (teste/CLI) vence o transporte resolvido e dispensa enableText", async () => {
  const fake = async () => "{}";
  const resolve = operationResolver({ dir: await dir(), loadStored: async () => muse, env: {}, enableVisual: false, proposeSend: fake });
  const deps = await resolve();
  expect(deps.proposeSend).toBe(fake);
});

it("describeClient só aparece com enableVisual, independente de enableText", async () => {
  const describeClient = { send: async () => "{}" };
  const resolve = operationResolver({ dir: await dir(), loadStored: async () => muse, env: {}, enableVisual: true, describeClient, enableText: true });
  const deps = await resolve();
  expect(deps.describeClient).toBe(describeClient);
  const off = operationResolver({ dir: await dir(), loadStored: async () => muse, env: {}, enableVisual: false, describeClient, enableText: true });
  expect((await off()).describeClient).toBeUndefined();
});
