import { copyFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { hashFile } from "@decupa/media";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import type { Executor } from "../pipeline.ts";
import { fixtureAssembly } from "./fixture.ts";
import { describeSource } from "./model.ts";
import { visualWindows } from "./visual.ts";

const frameExecutor: Executor = {
  async run(call) {
    const pattern = call.args[call.args.length - 1]!;
    const seconds = Number(call.args[call.args.indexOf("-t") + 1]!);
    for (let i = 0; i < seconds; i += 1) {
      await writeFile(pattern.replace("%03d", String(i).padStart(3, "0")), `frame-${i}`);
    }
    return { code: 0, stdout: "", stderr: "" };
  },
};

async function sourceOf(durationSeconds: number) {
  const dir = await mkdtemp(join(tmpdir(), "assembly-frac-"));
  const path = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), path);
  return {
    dir,
    source: {
      ...fixtureAssembly().sources[0]!,
      path,
      sha256: await hashFile(path),
      durationSeconds,
    },
  };
}

function clientReturning(end: number, sends: { n: number }) {
  return {
    async send() {
      sends.n += 1;
      return JSON.stringify({
        spans: [{ id: "local-0", start: 1, end, text: "fundo", confidence: "observed", tags: [] }],
      });
    },
  };
}

it("janela final de 60,4 s aceita o quadro local [1, 2] sem reparo", async () => {
  const { dir, source } = await sourceOf(60.4);
  const sends = { n: 0 };
  const spans = await describeSource(source, dir, new AbortController().signal, {
    client: clientReturning(2, sends),
    exec: frameExecutor,
  });
  expect(sends.n).toBe(visualWindows(60.4).length);
  const tail = spans.filter((span) => span.start >= 60);
  expect(tail).toHaveLength(1);
  expect(tail[0]?.end).toBeCloseTo(60.4, 5);
  expect(spans.every((span) => span.end <= 60.4 + 1e-9)).toBe(true);
});

it("excesso local acima de 1 s na janela final continua inválido", async () => {
  const { dir, source } = await sourceOf(60.4);
  const sends = { n: 0 };
  await expect(describeSource(source, dir, new AbortController().signal, {
    client: clientReturning(3, sends),
    exec: frameExecutor,
  })).rejects.toThrow(/termina depois da fonte/);
  expect(sends.n).toBe(visualWindows(60.4).length + 1);
});
