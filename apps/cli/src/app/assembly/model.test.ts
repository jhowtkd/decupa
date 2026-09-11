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

it("cancelar após a primeira janela estoura em vez de devolver parcial", async () => {
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
  await expect(describeSource(source, dir, ac.signal, { client, exec: copyProxy })).rejects.toThrow();
  expect(calls).toBe(1);
});

it("sinal já abortado nem começa", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-model-"));
  const source = await speechSource(dir, 45);
  const ac = new AbortController();
  ac.abort();
  let calls = 0;
  const client = { async send() { calls += 1; return '{"spans":[]}'; } };
  await expect(describeSource(source, dir, ac.signal, { client, exec: copyProxy })).rejects.toThrow(/cancelada/);
  expect(calls).toBe(0);
});

function windowMarkerExec(seen: { args: string[][] }): Executor {
  return {
    async run(call) {
      seen.args.push(call.args);
      const out = call.args[call.args.length - 1]!;
      const ss = call.args[call.args.indexOf("-ss") + 1] ?? "?";
      const t = call.args[call.args.indexOf("-t") + 1] ?? "?";
      const { writeFile } = await import("node:fs/promises");
      await writeFile(out, `clip-from-${ss}-dur-${t}`);
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

function localSpanClient(captured: { payloads: string[]; prompts: string[] }) {
  let n = 0;
  return {
    async send(content: unknown[]) {
      n += 1;
      const video = content.find((part) => (part as { type?: string }).type === "video_url") as {
        video_url: { url: string };
      };
      const text = content.find((part) => (part as { type?: string }).type === "text") as { text: string };
      captured.payloads.push(video.video_url.url);
      captured.prompts.push(text.text);
      // Janela 1 não tem contexto; as demais têm 1s: o conteúdo começa em 1 local.
      const start = n === 1 ? 0 : 1;
      return JSON.stringify({
        spans: [{ id: `local-${n}`, start, end: start + 1, text: "mesa", confidence: "observed", tags: [] }],
      });
    },
  };
}

it("segunda janela recebe vídeo recortado diferente e soma a origem uma vez", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-model-"));
  const source = await speechSource(dir, 45);
  const seen: { args: string[][] } = { args: [] };
  const captured = { payloads: [] as string[], prompts: [] as string[] };
  const client = localSpanClient(captured);
  const { payloads, prompts } = captured;
  const spans = await describeSource(source, dir, new AbortController().signal, {
    client,
    exec: windowMarkerExec(seen),
  });
  // 3 janelas, cada uma com seu recorte — nunca o proxy inteiro.
  expect(seen.args).toHaveLength(3);
  expect(new Set(payloads).size).toBe(3);
  expect(spans).toHaveLength(3);
  // Segunda janela: origem 20 somada uma vez (1 local + 19), sem dupla soma.
  const second = spans.filter((span) => span.start >= 20 && span.start < 40);
  expect(second.map((span) => [span.start, span.end])).toEqual([[20, 21]]);
  expect(prompts[1]).toContain("[20, 40)");
  expect(prompts[1]).toContain("origem 0");
  // Última janela parcial: recorte [39, 45), não [40, 45) sem contexto.
  const last = seen.args[2]!;
  expect(last[last.indexOf("-ss") + 1]).toBe("39");
  expect(last[last.indexOf("-t") + 1]).toBe("6");
});

it("retomada reaproveita janelas prontas e não reenvia", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-model-"));
  const source = await speechSource(dir, 45);
  const seen: { args: string[][] } = { args: [] };
  let calls = 0;
  let failOn = 2;
  const client = {
    async send() {
      calls += 1;
      if (calls === failOn) throw new Error("provedor falhou");
      // Janela 1 sem contexto; demais com 1s (conteúdo em 1 local).
      const start = calls === 1 ? 0 : 1;
      return JSON.stringify({
        spans: [{ id: `local-${calls}`, start, end: start + 1, text: "mesa", confidence: "observed", tags: [] }],
      });
    },
  };
  await expect(describeSource(source, dir, new AbortController().signal, {
    client,
    exec: windowMarkerExec(seen),
  })).rejects.toThrow(/provedor falhou/);
  expect(calls).toBe(2);
  failOn = -1;
  const before = calls;
  const spans = await describeSource(source, dir, new AbortController().signal, {
    client,
    exec: windowMarkerExec(seen),
  });
  // Janela 1 veio do cache: só 2 envios novos (janelas 2 e 3).
  expect(calls - before).toBe(2);
  expect(spans).toHaveLength(3);
});
