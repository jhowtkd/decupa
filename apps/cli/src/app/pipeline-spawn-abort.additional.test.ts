import { describe, expect, it } from "vitest";
import { SpawnExecutor } from "./pipeline.ts";

describe("SpawnExecutor com signal previamente abortado", () => {
  it("cancela um processo local que terminaria com sucesso", async () => {
    const exec = new SpawnExecutor();
    const command = process.execPath;
    const args = ["-e", "setTimeout(() => process.exit(0), 50)"];
    const controller = new AbortController();
    controller.abort();

    try {
      const control = await exec.run({ command, args });
      expect(control.code).toBe(0);

      const result = await exec.run({
        command,
        args,
        signal: controller.signal,
      });

      expect(result.code).not.toBe(0);
    } finally {
      await exec.terminateAll();
    }
  });
});
