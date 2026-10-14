import { expect, it } from "vitest";
import { networkGuard } from "./no-external-network.ts";

it("falha na verificação final mesmo quando o chamador engole o bloqueio", async () => {
  let calls = 0;
  const guard = networkGuard(async () => { calls++; return new Response("local"); });
  await guard.fetch("https://api.openai.com/v1/chat/completions").catch(() => undefined);
  expect(calls).toBe(0);
  expect(() => guard.assertClear()).toThrow(/tentativas de rede externa bloqueadas/);
  expect(await (await guard.fetch("http://127.0.0.1:1234/")).text()).toBe("local");
  expect(calls).toBe(1);
  guard.assertClear();
});
