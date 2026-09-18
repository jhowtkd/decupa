import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "index.ts");

function runCalibrate(): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", CLI, "calibrate"], {
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

it("decupa calibrate imprime o relatório offline com categorias bloqueadas", async () => {
  const { code, stdout, stderr } = await runCalibrate();
  expect(code, stderr).toBe(0);
  const report = JSON.parse(stdout) as {
    sampleSize: number;
    counts: { human_work: number };
    unlockedCategories: string[];
    latency: { p50Ms: number; p95Ms: number };
  };
  expect(report.sampleSize).toBeGreaterThan(0);
  expect(report.counts.human_work).toBe(report.sampleSize);
  expect(report.unlockedCategories).toEqual([]);
  expect(report.latency.p95Ms).toBeGreaterThanOrEqual(report.latency.p50Ms);
}, 30_000);
