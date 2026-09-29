import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeExecutor, runIngest, type PipelineJob } from "./pipeline.ts";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function job(withTranscript: boolean): Promise<PipelineJob> {
  const workDir = await mkdtemp(join(tmpdir(), "ingest-signal-"));
  dirs.push(workDir);
  if (withTranscript) {
    await writeFile(
      join(workDir, "transcript.json"),
      JSON.stringify({ segments: [{ start: 0, end: 1, text: "oi" }] }),
    );
  }
  return { id: "j", videoPath: join(workDir, "clip.mp4"), workDir };
}

// Sem o signal no filho, cancelar a operação deixa o `index`/`condense-prep`
// rodando até o fim: o abort só derrubaria o que já tinha o signal.
describe("runIngest repassa o signal da operação aos filhos", () => {
  it("o `condense index` do motor recebe o signal", async () => {
    const exec = new FakeExecutor();
    const controller = new AbortController();
    await runIngest(await job(true), exec, () => {}, undefined, undefined, undefined,
      controller.signal, { visual: false });
    const index = exec.calls.find((c) => c.args.includes("index"));
    expect(index).toBeDefined();
    expect(index!.signal).toBe(controller.signal);
  });

  it("o `condense-prep` (sem worker residente) recebe o signal", async () => {
    const exec = new FakeExecutor();
    const controller = new AbortController();
    // O fake não grava o transcript: o que vem depois pode rejeitar.
    await runIngest(await job(false), exec, () => {}, undefined, undefined, undefined,
      controller.signal, { visual: false }).catch(() => undefined);
    const prep = exec.calls.find((c) => c.args.includes("condense-prep"));
    expect(prep).toBeDefined();
    expect(prep!.signal).toBe(controller.signal);
  });
});
