import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES } from "../../../../tests/fixtures/global-setup.ts";
import { probeSourceStartSeconds, SpawnExecutor } from "./pipeline.ts";

describe("probeSourceStartSeconds", () => {
  it("lê 01:00:00:00 a 25 fps como 3600 segundos", async () => {
    // O EDL da limpeza somava os cortes a partir de zero e a câmera ficava offline.
    const seconds = await probeSourceStartSeconds(
      { id: "j1", videoPath: join(FIXTURES, "tc-1h-25.mov"), workDir: "/tmp" },
      new SpawnExecutor(),
    );
    expect(seconds).toBe(3600);
  }, 30_000);
});
