import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "index.ts");

it("documenta as flags de rede nos fluxos do navegador", async () => {
  const result = await new Promise<{ code: number; stdout: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", CLI], {
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.on("error", reject);
    child.on("close", code => resolve({ code: code ?? 1, stdout }));
  });

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("--allowed-hosts <hostes>");
  expect(result.stdout).toContain("--allowed-origins <origens>");
  expect(result.stdout).toContain("--trust-proxy");
});

it("documenta o servidor sem Projeto inicial", async () => {
  const result = await new Promise<{ code: number; stdout: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", CLI], {
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.on("error", reject);
    child.on("close", code => resolve({ code: code ?? 1, stdout }));
  });

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("decupa serve --projects-root <pasta>");
});
