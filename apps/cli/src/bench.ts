import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createScenarioWork,
  renderBenchmark,
  runBatchBenchmark,
  type BenchmarkScenario,
} from "@decupa/bench";
import { createFileCoordinator } from "@decupa/coordinator";

export async function runCliBench(opts: {
  scenario: BenchmarkScenario;
  limit: number;
  inputs: string[];
  cwd?: string;
}): Promise<{ code: number; output: string }> {
  if (opts.inputs.length === 0) {
    return {
      code: 1,
      output: "bench precisa de --input com arquivos reais; não inventa lote fictício",
    };
  }
  const root = join(opts.cwd ?? process.cwd(), ".decupa", "bench");
  await mkdir(root, { recursive: true });
  const session = createScenarioWork({
    scenario: opts.scenario,
    cacheDir: join(root, "artifacts"),
  });
  const coordinator = createFileCoordinator(join(root, "coordinator", randomUUID()), { limit: opts.limit, pollMs: 5 });
  const manifest = await runBatchBenchmark({
    caseId: `cli-${opts.scenario}-${opts.inputs.length}`,
    scenario: opts.scenario,
    files: opts.inputs,
    limit: opts.limit,
    coordinator,
    work: session.work,
    stats: session.stats,
  });
  return {
    code: manifest.failures === 0 ? 0 : 1,
    output: renderBenchmark(manifest),
  };
}
