import { access } from "node:fs/promises";
import {
  renderBenchmark,
  runBatchBenchmark,
  type BenchmarkScenario,
} from "@decupa/bench";

export async function runCliBench(opts: {
  scenario: BenchmarkScenario;
  limit: number;
  inputs: string[];
}): Promise<{ code: number; output: string }> {
  if (opts.inputs.length === 0) {
    return {
      code: 1,
      output: "bench precisa de --input com arquivos reais; não inventa lote fictício",
    };
  }
  const manifest = await runBatchBenchmark({
    caseId: `cli-${opts.scenario}-${opts.inputs.length}`,
    scenario: opts.scenario,
    files: opts.inputs,
    limit: opts.limit,
    work: async (file) => {
      await access(file);
    },
  });
  return {
    code: manifest.failures === 0 ? 0 : 1,
    output: renderBenchmark(manifest),
  };
}
