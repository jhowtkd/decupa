import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bootProjectDecision } from "./decision-boot.ts";

describe("bootProjectDecision", () => {
  it("projeto sem config abre desligado e observe não chama a API", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decision-boot-"));
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const missing = await bootProjectDecision({
      projectDir: dir,
      env: { TYPESAFE_API_KEY: "sk-secret", DECUPA_TYPESAFE: "1" },
      fetchImpl,
    });
    expect(missing).toMatchObject({ mode: "off", enabled: false, apiCalls: 0 });
    expect(calls).toBe(0);

    await mkdir(join(dir, ".decupa"), { recursive: true });
    await writeFile(join(dir, ".decupa", "decision.json"), JSON.stringify({ mode: "observe" }), "utf8");
    const observe = await bootProjectDecision({
      projectDir: dir,
      env: { TYPESAFE_API_KEY: "sk-secret", DECUPA_TYPESAFE: "1" },
      fetchImpl,
    });
    expect(observe).toMatchObject({ mode: "observe", enabled: false, apiCalls: 0 });
    expect(calls).toBe(0);
  });
});
