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

it("recorte visual exige seek de entrada e proíbe stream-copy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-model-"));
  const source = await speechSource(dir, 45);
  const seen: { args: string[][] } = { args: [] };
  const captured = { payloads: [] as string[], prompts: [] as string[] };
  await describeSource(source, dir, new AbortController().signal, {
    client: localSpanClient(captured),
    exec: windowMarkerExec(seen),
  });
  for (const args of seen.args) {
    const iAt = args.indexOf("-i");
    const ssAt = args.indexOf("-ss");
    expect(ssAt).toBeGreaterThanOrEqual(0);
    expect(ssAt).toBeLessThan(iAt);
    expect(args.includes("-c") && args[args.indexOf("-c") + 1] === "copy").toBe(false);
    expect(args.includes("copy")).toBe(false);
    expect(args).toContain("-c:v");
    expect(args[args.indexOf("-c:v") + 1]).not.toBe("copy");
  }
  const second = seen.args[1]!;
  expect(second[second.indexOf("-ss") + 1]).toBe("19");
  expect(second[second.indexOf("-t") + 1]).toBe("21");
});

/** Resposta com cobertura total da janela pedida, por texto distinto. */
function fullWindowClient(counter: { calls: number }, failOn: { n: number }) {
  return {
    async send(content: unknown[]) {
      counter.calls += 1;
      if (counter.calls === failOn.n) throw new Error("provedor falhou");
      const text = (content.find((part) => (part as { type?: string }).type === "text") as { text: string }).text;
      const match = /intervalo da fonte \[([\d.]+), ([\d.]+)\)/.exec(text);
      const start = match ? Number(match[1]) : 0;
      const end = match ? Number(match[2]) : 0;
      const fetchStart = start === 0 ? 0 : start - 1;
      return JSON.stringify({
        spans: [{
          id: `local-${counter.calls}`,
          start: 0,
          end: end - fetchStart,
          text: `janela-${start}`,
          confidence: "observed",
          tags: [],
        }],
      });
    },
  };
}

it("retomada reaproveita janelas prontas e não reenvia", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-model-"));
  const source = await speechSource(dir, 45);
  const seen: { args: string[][] } = { args: [] };
  const counter = { calls: 0 };
  const failOn = { n: 2 };
  const client = fullWindowClient(counter, failOn);
  await expect(describeSource(source, dir, new AbortController().signal, {
    client,
    exec: windowMarkerExec(seen),
  })).rejects.toThrow(/provedor falhou/);
  expect(counter.calls).toBe(2);
  failOn.n = -1;
  const before = counter.calls;
  const spans = await describeSource(source, dir, new AbortController().signal, {
    client,
    exec: windowMarkerExec(seen),
  });
  // Janela 1 veio do cache: só 2 envios novos (janelas 2 e 3).
  expect(counter.calls - before).toBe(2);
  expect(spans).toHaveLength(3);
});

it("respostas complementares conservam ambos os trechos", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-model-"));
  const source = await speechSource(dir, 3);
  let mode: "first" | "missing" = "first";
  let calls = 0;
  const client = {
    async send() {
      calls += 1;
      // Mesma posição (item 0) nas duas respostas: o ID posicional repete,
      // mas os intervalos são complementares e ambos precisam sobreviver.
      const span = mode === "first"
        ? { start: 0, end: 2, text: "anterior" }
        : { start: 2, end: 3, text: "faltante" };
      return JSON.stringify({
        spans: [{ id: "local-0", ...span, confidence: "observed", tags: [] }],
      });
    },
  };
  const deps = { client, exec: copyProxy };
  const first = await describeSource(source, dir, new AbortController().signal, deps);
  expect(first.map((span) => [span.start, span.end])).toEqual([[0, 2]]);
  mode = "missing";
  const before = calls;
  const second = await describeSource(source, dir, new AbortController().signal, deps);
  // A janela parcial não valeu como concluída: foi pedida de novo.
  expect(calls - before).toBe(1);
  expect(second.map((span) => [span.start, span.end, span.text])).toEqual([
    [0, 2, "anterior"],
    [2, 3, "faltante"],
  ]);
  expect(new Set(second.map((span) => span.id)).size).toBe(second.length);
  // Terceira execução reutiliza o cache completo sem outra chamada.
  const cached = await describeSource(source, dir, new AbortController().signal, deps);
  expect(calls - before).toBe(1);
  expect(cached.map((span) => [span.start, span.end, span.text])).toEqual([
    [0, 2, "anterior"],
    [2, 3, "faltante"],
  ]);
});
