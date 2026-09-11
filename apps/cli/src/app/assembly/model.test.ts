import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { hashFile } from "@decupa/media";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import type { Executor } from "../pipeline.ts";
import { describeSource, VISUAL_PROMPT } from "./model.ts";
import { fixtureAssembly } from "./fixture.ts";

async function speechSource(dir: string, durationSeconds = 3) {
  const path = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), path);
  return {
    ...fixtureAssembly().sources[0]!,
    path,
    sha256: await hashFile(path),
    durationSeconds,
  };
}

const copyProxy: Executor = {
  async run(call) {
    const out = call.args[call.args.length - 1]!;
    const input = call.args[call.args.indexOf("-i") + 1]!;
    await copyFile(input, out);
    return { code: 0, stdout: "", stderr: "" };
  },
};

it("usa o prompt visual e não o de triagem", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-model-"));
  const source = await speechSource(dir);
  const prompts: string[] = [];
  const client = {
    async send(content: unknown[]) {
      const text = content.find((part) => (part as { type?: string }).type === "text") as { text: string };
      prompts.push(text.text);
      return JSON.stringify({
        spans: [{ id: "local-0", start: 0, end: 1, text: "fundo vermelho", confidence: "observed", tags: [] }],
      });
    },
  };
  const spans = await describeSource(source, dir, new AbortController().signal, { client, exec: copyProxy });
  expect(spans[0]?.text).toBe("fundo vermelho");
  expect(prompts.join("\n")).toContain("Não identifique pessoas por nome");
  expect(prompts.join("\n")).not.toMatch(/preroll|unit_ids/);
  expect(VISUAL_PROMPT).not.toMatch(/preroll/);
});

it("janela roteirizada devolve spans na origem da fonte", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-model-"));
  const source = await speechSource(dir);
  const client = {
    async send() {
      return JSON.stringify({
        spans: [{ id: "local-0", start: 0, end: 1, text: "mesa", confidence: "observed", tags: ["mesa"] }],
      });
    },
  };
  const spans = await describeSource(source, dir, new AbortController().signal, { client, exec: copyProxy });
  expect(spans[0]?.text).toBe("mesa");
  expect(spans[0]?.start).toBe(0);
  expect(spans[0]?.sourceId).toBe("a");
});

it("cancelar interrompe janelas seguintes e devolve o parcial", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-model-"));
  const source = await speechSource(dir, 45);
  let calls = 0;
  const ac = new AbortController();
  const client = {
    async send() {
      calls += 1;
      const payload = JSON.stringify({
        spans: [{ id: "local-0", start: 0, end: 1, text: "janela", confidence: "observed", tags: [] }],
      });
      if (calls === 1) ac.abort();
      return payload;
    },
  };
  const spans = await describeSource(source, dir, ac.signal, { client, exec: copyProxy });
  expect(calls).toBe(1);
  expect(spans).toHaveLength(1);
});
