import { createHash } from "node:crypto";
import { link, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { Executor } from "../apps/cli/src/app/pipeline.ts";
import { fixtureAssembly } from "../apps/cli/src/app/assembly/fixture.ts";
import { blankProject } from "../apps/cli/src/app/assembly/routes.ts";
import { createProject, loadProject, saveProject } from "../apps/cli/src/app/assembly/store.ts";
import type { Source } from "../apps/cli/src/app/assembly/types.ts";
import { constrainSpansToSampled, main, sampleFrames } from "./visual-analysis-proof.ts";

it("seleciona amostras determinísticas sem fabricar timestamps", () => {
  const frames = [19, 20, 21, 22, 23, 24].map((sourceSecond) => ({ sourceSecond, dataUrl: "fixture" }));
  expect(sampleFrames(frames, 3).map((f) => f.sourceSecond)).toEqual([19, 22, 24]);
  expect(sampleFrames(frames, 1)).toEqual(frames);
  expect(sampleFrames([], 3)).toEqual([]);
});

/** Projeto piloto mínimo: entrevista (speech) + apoio (support), 3s cada. */
async function pilotProject(dir?: string): Promise<string> {
  const root = dir ?? await mkdtemp(join(tmpdir(), "visual-proof-"));
  await createProject(root, blankProject("proof"));
  const mkSource = (id: string, role: "speech" | "support", durationSeconds: number): Source => ({
    ...fixtureAssembly().sources[0]!,
    id,
    path: join(root, `${id}.mp4`),
    sha256: createHash("sha256").update(id).digest("hex"),
    durationSeconds,
    hasVideo: true,
    hasAudio: false,
    role,
    included: true,
    name: `${id}.mp4`,
  });
  const current = await loadProject(root);
  await saveProject(root, current.revision, (p) => ({
    ...p,
    assembly: {
      ...p.assembly,
      sources: [mkSource("fala", "speech", 3), mkSource("apoio", "support", 3)],
    },
  }));
  return root;
}

async function hashProjectJson(dir: string): Promise<string> {
  return createHash("sha256").update(await readFile(join(dir, "project.json"))).digest("hex");
}

/** Executor fake: um JPEG por segundo solicitado, sem FFmpeg real. */
const frameExec: Executor = {
  async run(call) {
    const pattern = call.args.at(-1)!;
    const seconds = Number(call.args[call.args.indexOf("-t") + 1]!);
    for (let i = 0; i < seconds; i += 1) {
      await writeFile(pattern.replace("%03d", String(i).padStart(3, "0")), `frame-${i}`);
    }
    return { code: 0, stdout: "", stderr: "" };
  },
};

function fullCover(text: string, start = 0, end = 3, confidence = "observed"): string {
  return JSON.stringify({
    spans: [{ id: "local-0", start, end, text, confidence, tags: [] }],
  });
}

/** Cliente fake com respostas roteirizadas em ordem de chamada. */
function fakeClient(responses: string[]) {
  const calls: unknown[][] = [];
  return {
    calls,
    client: {
      model: "fake",
      providerKey: "fake",
      send: async (content: unknown[]): Promise<string> => {
        calls.push(content);
        return responses[Math.min(calls.length - 1, responses.length - 1)]!;
      },
    },
  };
}

it("sem --allow-paid só inventaria: zero chamadas, pedido concreto, project.json intacto", async () => {
  const dir = await pilotProject();
  const before = await hashProjectJson(dir);
  const lines: string[] = [];
  let fetchCalls = 0;
  const fetchImpl = (async () => {
    fetchCalls += 1;
    throw new Error("rede proibida sem autorização");
  }) as typeof fetch;
  const out = join(dir, "report.json");
  const code = await main(
    ["--project", dir, "--out", out, "--arm", "compact"],
    { log: (line) => lines.push(line), fetchImpl },
  );
  expect(code).toBe(2);
  expect(fetchCalls).toBe(0);
  const text = lines.join("\n");
  expect(text).toMatch(/allow-paid/);
  expect(text).toMatch(/fala.*speech|speech.*fala/s);
  expect(text).toMatch(/chamadas?/i);
  await expect(readFile(out, "utf8")).rejects.toThrow();
  expect(await hashProjectJson(dir)).toBe(before);
});

it("two-pass contabiliza as duas chamadas e não escreve project.json", async () => {
  const dir = await pilotProject();
  const before = await hashProjectJson(dir);
  // Passada 1: fala incerta (pede detalhe) + apoio observado; passada 2: detalhe da fala.
  const { calls, client } = fakeClient([
    fullCover("talvez entrevista", 0, 3, "uncertain"),
    fullCover("paisagem", 0, 3),
    fullCover("entrevista detalhada", 0, 3),
  ]);
  const out = join(dir, "two-pass.json");
  const code = await main(
    ["--project", dir, "--out", out, "--arm", "two-pass", "--allow-paid"],
    { log: () => undefined, client, exec: frameExec },
  );
  expect(code).toBe(0);
  expect(calls).toHaveLength(3);
  const report = JSON.parse(await readFile(out, "utf8"));
  expect(report.status).toBe("ok");
  expect(report.sends).toBe(3);
  expect(report.passes).toEqual([2, 1]);
  expect(report.spans.some((span: { text: string }) => span.text === "entrevista detalhada")).toBe(true);
  // Detalhe denso substitui o panorama, não mistura com ele.
  expect(report.spans.filter((s: { sourceId: string }) => s.sourceId === "fala")
    .map((s: { text: string }) => s.text)).toEqual(["entrevista detalhada", "entrevista detalhada", "entrevista detalhada"]);
  expect(await hashProjectJson(dir)).toBe(before);
});

it("sparse subamostra só speech e mantém support a 1 fps", async () => {
  const dir = await pilotProject();
  const before = await hashProjectJson(dir);
  const { calls, client } = fakeClient([fullCover("fala"), fullCover("apoio")]);
  const out = join(dir, "sparse.json");
  const code = await main(
    ["--project", dir, "--out", out, "--arm", "sparse", "--allow-paid"],
    { log: () => undefined, client, exec: frameExec },
  );
  expect(code).toBe(0);
  // Fala: 3 frames → índices 0 e 2; apoio: 3 frames intactos.
  const countImages = (content: unknown[]): number =>
    content.filter((part) => (part as { type?: string }).type === "image_url").length;
  expect(calls.map(countImages)).toEqual([2, 3]);
  const promptOf = (content: unknown[]): string =>
    (content.find((part) => (part as { type?: string }).type === "text") as { text: string }).text;
  // Amostrado declara 3s; denso mantém o prompt de 1 fps.
  expect(promptOf(calls[0]!)).toContain("a cada 3 segundos");
  expect(promptOf(calls[0]!)).not.toContain("1 fps");
  expect(promptOf(calls[1]!)).toContain("1 fps");
  const report = JSON.parse(await readFile(out, "utf8"));
  expect(report.framesSent).toBe(5);
  // Segundos sem imagem não viram observed: [1,2) da fala é lacuna.
  expect(report.spans).toHaveLength(5);
  expect(report.spans.filter((s: { sourceId: string }) => s.sourceId === "fala")
    .map((s: { start: number; end: number }) => [s.start, s.end])).toEqual([[0, 1], [2, 3]]);
  expect(await hashProjectJson(dir)).toBe(before);
});

it.each(["baseline", "compact"] as const)("braço %s via describeSource não escreve project.json", async (arm) => {
  const dir = await pilotProject();
  const before = await hashProjectJson(dir);
  const { client } = fakeClient([fullCover(`${arm}-fala`), fullCover(`${arm}-apoio`)]);
  const out = join(dir, `${arm}.json`);
  const code = await main(
    ["--project", dir, "--out", out, "--arm", arm, "--allow-paid"],
    { log: () => undefined, client, exec: frameExec },
  );
  expect(code).toBe(0);
  const report = JSON.parse(await readFile(out, "utf8"));
  expect(report.status).toBe("ok");
  expect(report.sends).toBe(2);
  expect(report.spans).toHaveLength(arm === "compact" ? 6 : 2);
  expect(await hashProjectJson(dir)).toBe(before);
});

it("low-effort sem suporte confirmado marca não executado, sem chamadas", async () => {
  const dir = await pilotProject();
  const before = await hashProjectJson(dir);
  const { calls, client } = fakeClient([fullCover("x")]);
  const out = join(dir, "low-effort.json");
  const code = await main(
    ["--project", dir, "--out", out, "--arm", "low-effort", "--allow-paid"],
    { log: () => undefined, client, exec: frameExec },
  );
  expect(code).toBe(0);
  expect(calls).toHaveLength(0);
  const report = JSON.parse(await readFile(out, "utf8"));
  expect(report.status).toBe("not-run");
  expect(report.reason).toMatch(/reasoning_effort/i);
  expect(await hashProjectJson(dir)).toBe(before);
});

it("recusa amostra acima de 60s antes de qualquer chamada", async () => {
  const dir = await mkdtemp(join(tmpdir(), "visual-proof-long-"));
  await createProject(dir, blankProject("proof"));
  const current = await loadProject(dir);
  await saveProject(dir, current.revision, (p) => ({
    ...p,
    assembly: {
      ...p.assembly,
      sources: [{
        ...fixtureAssembly().sources[0]!,
        id: "longa",
        path: join(dir, "longa.mp4"),
        sha256: createHash("sha256").update("longa").digest("hex"),
        durationSeconds: 61,
        hasVideo: true,
        role: "speech",
        included: true,
        name: "longa.mp4",
      }],
    },
  }));
  const before = await hashProjectJson(dir);
  const { calls, client } = fakeClient([fullCover("x")]);
  const lines: string[] = [];
  const code = await main(
    ["--project", dir, "--out", join(dir, "r.json"), "--arm", "baseline", "--allow-paid"],
    { log: (line) => lines.push(line), client, exec: frameExec },
  );
  expect(code).toBe(1);
  expect(calls).toHaveLength(0);
  expect(lines.join("\n")).toMatch(/60/);
  expect(await hashProjectJson(dir)).toBe(before);
});

it("argumentos inválidos imprimem uso e saem 1", async () => {
  const lines: string[] = [];
  const code = await main([], { log: (line) => lines.push(line) });
  expect(code).toBe(1);
  expect(lines.join("\n")).toMatch(/--project.*--out.*--arm/s);
});

it("recusa --out sobre caminho existente, inclusive links para project.json", async () => {
  const dir = await pilotProject();
  const before = await hashProjectJson(dir);
  const beforeText = await readFile(join(dir, "project.json"), "utf8");
  const { calls, client } = fakeClient([fullCover("x")]);
  const hooks = { log: () => undefined, client, exec: frameExec };
  // Direto sobre project.json, num braço sem API: a trava é prévia a tudo.
  const direct = await main(
    ["--project", dir, "--out", join(dir, "project.json"), "--arm", "low-effort", "--allow-paid"],
    hooks,
  );
  expect(direct).toBe(1);
  // Symlink e hardlink para project.json: aliases também recusados.
  await symlink(join(dir, "project.json"), join(dir, "alias.json"));
  const viaLink = await main(
    ["--project", dir, "--out", join(dir, "alias.json"), "--arm", "low-effort", "--allow-paid"],
    hooks,
  );
  expect(viaLink).toBe(1);
  await link(join(dir, "project.json"), join(dir, "hard.json"));
  const viaHard = await main(
    ["--project", dir, "--out", join(dir, "hard.json"), "--arm", "low-effort", "--allow-paid"],
    hooks,
  );
  expect(viaHard).toBe(1);
  // Braço pago também recusa antes de qualquer chamada.
  const paid = await main(
    ["--project", dir, "--out", join(dir, "project.json"), "--arm", "compact", "--allow-paid"],
    hooks,
  );
  expect(paid).toBe(1);
  expect(calls).toHaveLength(0);
  expect(await hashProjectJson(dir)).toBe(before);
  expect(await readFile(join(dir, "project.json"), "utf8")).toBe(beforeText);
});

it("constrainSpansToSampled mantém só segundos com imagem", () => {
  const span = (start: number, end: number, confidence = "observed") => ({
    id: "x", sourceId: "s", start, end, text: "t", confidence: confidence as "observed", tags: [] as string[],
  });
  expect(constrainSpansToSampled([span(0, 3)], [0, 2]).map((s) => [s.start, s.end]))
    .toEqual([[0, 1], [2, 3]]);
  expect(constrainSpansToSampled(
    [{ ...span(0, 3), confidence: "uncertain" as const }],
    [1],
  ).map((s) => [s.start, s.end, s.confidence])).toEqual([[1, 2, "uncertain"]]);
  expect(constrainSpansToSampled([span(0, 1)], [2])).toEqual([]);
  expect(constrainSpansToSampled([span(20, 20.4)], [20]).map((s) => [s.start, s.end]))
    .toEqual([[20, 20.4]]);
});
