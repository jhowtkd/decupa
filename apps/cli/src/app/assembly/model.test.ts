import { copyFile, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { hashFile } from "@decupa/media";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import type { Executor } from "../pipeline.ts";
import { describeSource, normalizeCompactSpans, sanitizeProviderKey, VISUAL_PROMPT, VISUAL_PROMPT_SPARSE, type VisualMetric } from "./model.ts";
import { fixtureAssembly } from "./fixture.ts";

/** Identidade fake: clientes injetados precisam dela para usar cache persistente. */
const TEST_IDENTITY = { model: "test-model", providerKey: "test-provider" };

async function findJsonFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...await findJsonFiles(full));
    else if (entry.name.endsWith(".json")) out.push(full);
  }
  return out;
}

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

/** Escreve um JPEG por segundo solicitado, no padrão de saída do FFmpeg. */
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
  const spans = await describeSource(source, dir, new AbortController().signal, { client, exec: frameExecutor });
  expect(spans[0]?.text).toBe("fundo vermelho");
  expect(prompts.join("\n")).toContain("Não identifique pessoas por nome");
  expect(prompts.join("\n")).not.toMatch(/preroll|unit_ids/);
  expect(VISUAL_PROMPT).not.toMatch(/preroll/);
});

it("envia frames JPEG timestampados, nunca video_url", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-model-"));
  const source = await speechSource(dir);
  const captured: unknown[][] = [];
  const client = {
    async send(content: unknown[]) {
      captured.push(content);
      return JSON.stringify({
        spans: [{ id: "local-0", start: 0, end: 1, text: "mesa", confidence: "observed", tags: [] }],
      });
    },
  };
  const spans = await describeSource(source, dir, new AbortController().signal, {
    client,
    exec: frameExecutor,
  });

  expect(spans[0]?.text).toBe("mesa");
  const parts = captured[0]!;
  expect(parts.some((part: any) => part.type === "video_url")).toBe(false);
  expect(parts.filter((part: any) => part.type === "image_url").length).toBeGreaterThan(0);
  expect((parts.find((part: any) => part.type === "text") as any).text)
    .toMatch(/frame.*fonte.*0s/i);
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
  const spans = await describeSource(source, dir, new AbortController().signal, { client, exec: frameExecutor });
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
      ac.abort();
      const payload = JSON.stringify({
        spans: [{ id: "local-0", start: 0, end: 1, text: "janela", confidence: "observed", tags: [] }],
      });
      return payload;
    },
  };
  await expect(describeSource(source, dir, ac.signal, { client, exec: frameExecutor })).rejects.toThrow();
  expect(calls).toBeGreaterThanOrEqual(1);
});

it("sinal já abortado nem começa", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-model-"));
  const source = await speechSource(dir, 45);
  const ac = new AbortController();
  ac.abort();
  let calls = 0;
  const client = { async send() { calls += 1; return '{"spans":[]}'; } };
  await expect(describeSource(source, dir, ac.signal, { client, exec: frameExecutor })).rejects.toThrow(/cancelada/);
  expect(calls).toBe(0);
});

function windowMarkerExec(seen: { args: string[][] }): Executor {
  return {
    async run(call) {
      seen.args.push(call.args);
      const pattern = call.args[call.args.length - 1]!;
      const ss = call.args[call.args.indexOf("-ss") + 1] ?? "?";
      const t = call.args[call.args.indexOf("-t") + 1] ?? "?";
      for (let i = 0; i < Number(t); i += 1) {
        await writeFile(pattern.replace("%03d", String(i).padStart(3, "0")), `clip-from-${ss}-dur-${t}-${i}`);
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

function localSpanClient(captured: { payloads: string[]; prompts: string[] }) {
  return {
    async send(content: unknown[]) {
      const urls = content
        .filter((part) => (part as { type?: string }).type === "image_url")
        .map((part) => (part as { image_url: { url: string } }).image_url.url);
      const text = content.find((part) => (part as { type?: string }).type === "text") as { text: string };
      captured.payloads.push(urls.join("|"));
      captured.prompts.push(text.text);
      const match = /na fonte: \[([\d.]+), ([\d.]+)\)/.exec(text.text);
      const start = match ? Number(match[1]) : 0;
      const localStart = start === 0 ? 0 : 1;
      return JSON.stringify({
        spans: [{ id: `local-${start}`, start: localStart, end: localStart + 1, text: "mesa", confidence: "observed", tags: [] }],
      });
    },
  };
}

it("segunda janela recebe frames distintos e soma a origem uma vez", async () => {
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
  // 3 janelas, cada uma com seus frames — nunca o proxy inteiro.
  expect(seen.args).toHaveLength(3);
  expect(new Set(payloads).size).toBe(3);
  expect(spans).toHaveLength(3);
  // Segunda janela: origem 20 somada uma vez (1 local + 19), sem dupla soma.
  const second = spans.filter((span) => span.start >= 20 && span.start < 40);
  expect(second.map((span) => [span.start, span.end])).toEqual([[20, 21]]);
  const midPrompt = prompts.find((p) => p.includes("[20, 40)"));
  expect(midPrompt).toContain("[20, 40)");
  expect(midPrompt).toContain("origem 0");
  // Última janela parcial: recorte [39, 45), não [40, 45) sem contexto.
  const last = seen.args.find((args) => args[args.indexOf("-ss") + 1] === "39")!;
  expect(last[last.indexOf("-ss") + 1]).toBe("39");
  expect(last[last.indexOf("-t") + 1]).toBe("6");
});

/** Resposta com cobertura total da janela pedida, por texto distinto. */
function fullWindowClient(counter: { calls: number }, failOn: { interval?: string }) {
  return {
    ...TEST_IDENTITY,
    async send(content: unknown[]) {
      counter.calls += 1;
      const text = (content.find((part) => (part as { type?: string }).type === "text") as { text: string }).text;
      if (failOn.interval && text.includes(failOn.interval)) throw new Error("provedor falhou");
      const match = /na fonte: \[([\d.]+), ([\d.]+)\)/.exec(text);
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
  const failOn = { interval: "[20, 40)" as string | undefined };
  const client = fullWindowClient(counter, failOn);
  await expect(describeSource(source, dir, new AbortController().signal, {
    client,
    exec: windowMarkerExec(seen),
  })).rejects.toThrow(/provedor falhou/);
  expect(counter.calls).toBeGreaterThanOrEqual(2);
  failOn.interval = undefined;
  const before = counter.calls;
  const spans = await describeSource(source, dir, new AbortController().signal, {
    client,
    exec: windowMarkerExec(seen),
  });
  // Janela do meio falhou: só ela é reenviada.
  expect(counter.calls - before).toBe(1);
  expect(spans).toHaveLength(3);
});

it("respostas complementares conservam ambos os trechos", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-model-"));
  const source = await speechSource(dir, 3);
  let mode: "first" | "missing" = "first";
  let calls = 0;
  const client = {
    ...TEST_IDENTITY,
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
  const deps = { client, exec: frameExecutor };
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

it("replay com artefato aquecido faz 0 chamadas de encode e de API", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-model-"));
  const source = await speechSource(dir);
  let api = 0;
  let encodes = 0;
  const client = {
    ...TEST_IDENTITY,
    async send() {
      api += 1;
      return JSON.stringify({
        spans: [{ id: "local-0", start: 0, end: 3, text: "mesa", confidence: "observed", tags: [] }],
      });
    },
  };
  const exec: Executor = {
    async run(call) {
      encodes += 1;
      return frameExecutor.run(call);
    },
  };
  await describeSource(source, dir, new AbortController().signal, { client, exec });
  expect(api).toBeGreaterThan(0);
  expect(encodes).toBeGreaterThan(0);
  const beforeApi = api;
  const beforeEnc = encodes;
  await describeSource(source, dir, new AbortController().signal, { client, exec });
  expect(api).toBe(beforeApi);
  expect(encodes).toBe(beforeEnc);
});

it("resposta atrasada não altera revisão nova", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-model-"));
  const source = await speechSource(dir, 3);
  let current = true;
  let release!: (value: string) => void;
  const hung = new Promise<string>((resolve) => { release = resolve; });
  const pending = describeSource(source, dir, new AbortController().signal, {
    client: { send: () => hung },
    exec: frameExecutor,
    isCurrent: () => current,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  current = false;
  release(JSON.stringify({
    spans: [{ id: "local-0", start: 0, end: 3, text: "atrasado", confidence: "observed", tags: [] }],
  }));
  await expect(pending).rejects.toThrow(/obsoleta/);
  let calls = 0;
  const spans = await describeSource(source, dir, new AbortController().signal, {
    client: {
      async send() {
        calls += 1;
        return JSON.stringify({
          spans: [{ id: "local-0", start: 0, end: 3, text: "atual", confidence: "observed", tags: [] }],
        });
      },
    },
    exec: frameExecutor,
  });
  expect(calls).toBe(1);
  expect(spans[0]?.text).toBe("atual");
});

it("corrige uma resposta visual malformada sem pular a validação temporal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-model-repair-"));
  const source = await speechSource(dir);
  const requests: unknown[][] = [];
  const client = { ...TEST_IDENTITY, async send(content: unknown[]) {
    requests.push(content);
    return requests.length === 1 ? '{"spans":[{"text":"aspas " quebradas"}]}'
      : JSON.stringify({ spans: [{ start: 0, end: 3, text: "entrevista", confidence: "observed", tags: [] }] });
  } };
  const spans = await describeSource(source, dir, new AbortController().signal, { client, exec: frameExecutor });
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text", text: expect.stringContaining("não passou na validação") })]));
  expect(spans[0]).toMatchObject({ start: 0, end: 3, text: "entrevista" });
  await describeSource(source, dir, new AbortController().signal, { client, exec: frameExecutor });
  expect(requests).toHaveLength(2);
});

it("limita a correção visual a uma tentativa e recusa tempos fora da fonte", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-model-repair-"));
  const source = await speechSource(dir);
  let calls = 0;
  const client = { async send() { calls++; return JSON.stringify({ spans: [{ start: 0, end: 999, text: "inválido", confidence: "observed" }] }); } };
  await expect(describeSource(source, dir, new AbortController().signal, { client, exec: frameExecutor })).rejects.toThrow("termina depois da fonte");
  expect(calls).toBe(2);
});

it("emite telemetria por fase e cache-hit na segunda execução", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-model-metrics-"));
  const source = await speechSource(dir, 3);
  const events: VisualMetric[] = [];
  let clock = 0;
  const client = {
    ...TEST_IDENTITY,
    async send() {
      clock += 10;
      return JSON.stringify({
        spans: [{ id: "local-0", start: 0, end: 3, text: "mesa", confidence: "observed", tags: [] }],
      });
    },
  };
  const deps = {
    client,
    exec: frameExecutor,
    onMetric: (event: VisualMetric) => events.push(event),
    now: () => clock,
  };
  await describeSource(source, dir, new AbortController().signal, deps);
  await describeSource(source, dir, new AbortController().signal, deps);
  expect(events.some((e) => e.phase === "request" && e.attempt === 1)).toBe(true);
  expect(events.at(-1)?.outcome).toBe("cache-hit");
  expect(JSON.stringify(events)).not.toContain("data:image");
  expect(events.every((e) => e.elapsedMs >= 0 && e.queueMs >= 0)).toBe(true);
  expect(events.every((e) => e.sourceId === "a")).toBe(true);
});

it("erro de transporte termina com evento error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-model-metrics-"));
  const source = await speechSource(dir, 3);
  const events: VisualMetric[] = [];
  const client = {
    async send(): Promise<string> { throw new Error("provedor falhou"); },
  };
  await expect(describeSource(source, dir, new AbortController().signal, {
    client,
    exec: frameExecutor,
    onMetric: (event: VisualMetric) => events.push(event),
  })).rejects.toThrow(/provedor falhou/);
  expect(events.some((e) => e.phase === "request" && e.outcome === "error")).toBe(true);
  expect(JSON.stringify(events)).not.toContain("data:image");
});

it("cancelamento durante o envio termina cancelled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-model-metrics-"));
  const source = await speechSource(dir, 3);
  const events: VisualMetric[] = [];
  const ac = new AbortController();
  const client = {
    async send() {
      ac.abort();
      return JSON.stringify({
        spans: [{ id: "local-0", start: 0, end: 3, text: "mesa", confidence: "observed", tags: [] }],
      });
    },
  };
  await expect(describeSource(source, dir, ac.signal, {
    client,
    exec: frameExecutor,
    onMetric: (event: VisualMetric) => events.push(event),
  })).rejects.toThrow();
  expect(events.some((e) => e.outcome === "cancelled")).toBe(true);
});

it("resposta inválida seguida de válida gera duas tentativas medidas", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-model-metrics-"));
  const source = await speechSource(dir, 3);
  const events: VisualMetric[] = [];
  let calls = 0;
  const client = {
    async send() {
      calls += 1;
      return calls === 1
        ? '{"spans":[{"text":"aspas " quebradas"}]}'
        : JSON.stringify({
          spans: [{ start: 0, end: 3, text: "mesa", confidence: "observed", tags: [] }],
        });
    },
  };
  await describeSource(source, dir, new AbortController().signal, {
    client,
    exec: frameExecutor,
    onMetric: (event: VisualMetric) => events.push(event),
  });
  expect(events.filter((e) => e.phase === "request").map((e) => e.attempt)).toEqual([1, 2]);
});

it("prompt esparso declara amostragem de 3s e exige honestidade por segundo", () => {
  expect(VISUAL_PROMPT_SPARSE).toContain("a cada 3 segundos");
  expect(VISUAL_PROMPT_SPARSE).not.toContain("1 fps");
  expect(VISUAL_PROMPT_SPARSE).toContain('{"spans"');
  expect(VISUAL_PROMPT_SPARSE).toContain("unavailable");
});

it("normaliza spans compactos em células de até 1s sem inventar cobertura", () => {
  const span = {
    id: "old", sourceId: "s", start: 19, end: 22.4, text: "Público na feira",
    confidence: "observed" as const, tags: ["público"],
  };
  expect(normalizeCompactSpans([span]).map((s) => [s.start, s.end]))
    .toEqual([[19, 20], [20, 21], [21, 22], [22, 22.4]]);
  expect(normalizeCompactSpans([{ ...span, confidence: "uncertain" }])
    .every((s) => s.confidence === "uncertain")).toBe(true);
  // Lacuna na resposta permanece lacuna: nada preenche [1, 2).
  const gappy = normalizeCompactSpans([
    { ...span, start: 0, end: 1 },
    { ...span, start: 2, end: 3 },
  ]);
  expect(gappy.map((s) => [s.start, s.end])).toEqual([[0, 1], [2, 3]]);
});

it("perfil compact preserva ação breve entre trechos estáticos", async () => {
  const respond = () => JSON.stringify({
    spans: [
      { id: "local-0", start: 0, end: 4, text: "entrevista estática", confidence: "observed", tags: [] },
      { id: "local-1", start: 4, end: 5, text: "levanta a placa", confidence: "observed", tags: [] },
      { id: "local-2", start: 5, end: 6, text: "entrevista estática", confidence: "observed", tags: [] },
    ],
  });
  const prompts: string[] = [];
  const client = {
    async send(content: unknown[]) {
      prompts.push((content.find((part) => (part as { type?: string }).type === "text") as { text: string }).text);
      return respond();
    },
  };
  // Diretórios separados: até a Task 3 o perfil não compõe a chave de cache.
  const compactDir = await mkdtemp(join(tmpdir(), "assembly-model-compact-"));
  const compactSource = await speechSource(compactDir, 6);
  const spans = await describeSource(compactSource, compactDir, new AbortController().signal, {
    client,
    exec: frameExecutor,
    profile: "compact",
  });
  expect(spans.map((s) => [s.start, s.end, s.text])).toEqual([
    [0, 1, "entrevista estática"],
    [1, 2, "entrevista estática"],
    [2, 3, "entrevista estática"],
    [3, 4, "entrevista estática"],
    [4, 5, "levanta a placa"],
    [5, 6, "entrevista estática"],
  ]);
  expect(prompts.join("\n")).toContain("Agrupe intervalos consecutivos");
  // Baseline intacto: sem perfil, intervalos multi-segundo não são fatiados.
  const baselineDir = await mkdtemp(join(tmpdir(), "assembly-model-baseline-"));
  const baselineSource = await speechSource(baselineDir, 6);
  const baseline = await describeSource(baselineSource, baselineDir, new AbortController().signal, {
    client,
    exec: frameExecutor,
  });
  expect(baseline.map((s) => [s.start, s.end])).toEqual([[0, 4], [4, 5], [5, 6]]);
  expect(prompts.join("\n")).toContain("Descreva o que é observável por segundo");
});

it("janela final fracionária publica só o trecho solicitado", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-model-frac-"));
  const source = await speechSource(dir, 20.4);
  const client = {
    async send(content: unknown[]) {
      const text = (content.find((part) => (part as { type?: string }).type === "text") as { text: string }).text;
      const match = /na fonte: \[([\d.]+), ([\d.]+)\)/.exec(text);
      const start = match ? Number(match[1]) : 0;
      const end = match ? Number(match[2]) : 0;
      const fetchStart = start === 0 ? 0 : start - 1;
      return JSON.stringify({
        spans: [{
          id: `local-${start}`, start: 0, end: end - fetchStart,
          text: `janela-${start}`, confidence: "observed", tags: [],
        }],
      });
    },
  };
  const spans = await describeSource(source, dir, new AbortController().signal, {
    client,
    exec: frameExecutor,
    profile: "compact",
  });
  // Janela {start:20, end:20.4, fetchStart:19}: origem somada uma vez, fim
  // fracionário preservado, sem inventar [20,21].
  const tail = spans.filter((s) => s.start >= 20);
  expect(tail).toHaveLength(1);
  expect(tail[0]?.start).toBe(20);
  expect(tail[0]?.end).toBeCloseTo(20.4, 9);
  expect(spans.every((s) => s.end <= 20.4 + 1e-9)).toBe(true);
});

it("isola cache por modelo, provedor e perfil", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-model-identity-"));
  const source = await speechSource(dir, 3);
  let calls = 0;
  const send = async () => {
    calls += 1;
    return JSON.stringify({
      spans: [{ id: "local-0", start: 0, end: 3, text: "mesa", confidence: "observed", tags: [] }],
    });
  };
  const run = (identity: { model: string; providerKey: string }, profile?: "baseline" | "compact") =>
    describeSource(source, dir, new AbortController().signal, {
      client: { ...identity, send },
      exec: frameExecutor,
      ...(profile ? { profile } : {}),
    });
  const same = { model: "m1", providerKey: "https://a.example" };
  await run(same);
  await run(same);
  expect(calls).toBe(1);
  const newModel = { model: "m2", providerKey: "https://a.example" };
  await run(newModel);
  await run(newModel);
  expect(calls).toBe(2);
  const newProvider = { model: "m2", providerKey: "https://b.example" };
  await run(newProvider);
  await run(newProvider);
  expect(calls).toBe(3);
  await run(newProvider, "compact");
  await run(newProvider, "compact");
  expect(calls).toBe(4);
});

it("chave de provedor sanitizada nunca leva credencial ao cache", async () => {
  expect(sanitizeProviderKey("https://user:pass@api.example.com/v1?key=sk-secret#frag"))
    .toBe("https://api.example.com/v1");
  expect(sanitizeProviderKey("test-provider")).toBe("test-provider");
  const dir = await mkdtemp(join(tmpdir(), "assembly-model-hygiene-"));
  const source = await speechSource(dir, 3);
  const client = {
    model: "m1",
    providerKey: "https://user:pass@api.example.com/v1?key=sk-secret",
    async send() {
      return JSON.stringify({
        spans: [{ id: "local-0", start: 0, end: 3, text: "mesa", confidence: "observed", tags: [] }],
      });
    },
  };
  await describeSource(source, dir, new AbortController().signal, { client, exec: frameExecutor });
  const envelopes = (await findJsonFiles(dir)).filter((file) => file.includes("w-0-3"));
  expect(envelopes).toHaveLength(1);
  const text = await readFile(envelopes[0]!, "utf8");
  expect(text).toContain("https://api.example.com/v1");
  expect(text).not.toContain("sk-secret");
  expect(text).not.toContain("user:pass");
  expect(text).not.toContain("apiKey");
  expect(JSON.parse(text).identityKey).toMatch(/^[0-9a-f]{64}$/);
});

it("cliente sem identidade funciona sem ler ou escrever cache persistente", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-model-noid-"));
  const source = await speechSource(dir, 3);
  let calls = 0;
  const client = {
    async send() {
      calls += 1;
      return JSON.stringify({
        spans: [{ id: "local-0", start: 0, end: 3, text: "mesa", confidence: "observed", tags: [] }],
      });
    },
  };
  const deps = { client, exec: frameExecutor };
  const first = await describeSource(source, dir, new AbortController().signal, deps);
  const second = await describeSource(source, dir, new AbortController().signal, deps);
  expect(calls).toBe(2);
  expect(second).toEqual(first);
  const envelopes = (await findJsonFiles(dir)).filter((file) => file.includes("w-"));
  expect(envelopes).toEqual([]);
});
