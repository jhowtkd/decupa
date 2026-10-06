import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupFixture } from "./cleanup-fillers.test-helper.ts";
import { startApp } from "./server.ts";
import type { Review } from "./review.ts";

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });
async function boot(supported = true, extra?: Parameters<typeof cleanupFixture>[1]) { const f = await cleanupFixture(supported, extra); close = f.app.close; return f; }
const reviewOf = async (response: Response): Promise<Review> => { expect(response.status).toBe(200); return (await response.json() as { review: Review }).review; };
function decision(review: Review) { const c = review.fillers.groups.flatMap(g => g.items).find(c => c.category === "hesitation")!; return { candidateId: c.id, wordIds: c.wordIds }; }
const saved = async (dir: string) => ({ keep: await readFile(join(dir, "keep.txt"), "utf8"), fillers: await readFile(join(dir, "fillers.json"), "utf8"), plan: await readFile(join(dir, "out", "condense_plan.json"), "utf8") });

it("motor sem suporte preserva argumentos legados e bloqueia decisões por palavra", async () => {
  const f = await boot(false), review = await reviewOf(await f.post("/keep", { keepList: "u001-u002" }));
  expect(f.calls.at(-1)!.args.slice(-2)).toEqual(["--drop-fillers", "hard"]);
  expect(review.fillers.groups).toHaveLength(1); expect(review.fillers.supported).toBe(false);
  expect(review.fillers).toMatchObject({ count: 1, totalSeconds: 0.2 }); expect(review.joins[0]!.isFiller).toBe(true);
  expect(review.fillers.warnings).toContain("motor sem suporte a corte por palavra; atualize o motor");
  expect((await f.post("/fillers", { kept: [decision(review)] })).status).toBe(409);
  expect(f.calls.filter(c => c.args.includes("plan"))).toHaveLength(1);
});

it("lista explícita [] preserva a palavra e a decisão sobrevive ao re-plano e retomada", async () => {
  const f = await boot(); const first = await reviewOf(await f.post("/keep", { keepList: "u001-u002" }));
  expect(first.generation).toBe(1); expect(first.fillers.totalSeconds).toBeCloseTo(0.2);
  const kept = await reviewOf(await f.post("/fillers", { kept: [decision(first)] }));
  expect(kept.generation).toBe(2); expect(f.spans.at(-1)).toEqual([]);
  expect(f.calls.at(-1)!.args).not.toContain("--drop-fillers");
  await f.post("/keep", { keepList: "u001" }); expect(f.spans.at(-1)).toEqual([]);
  const persisted = JSON.parse(await readFile(join(f.dir, "fillers.json"), "utf8"));
  expect(persisted.kept[0].texts).toEqual(["hã"]);
  await f.app.close();
  const resumed = await startApp(f.options); close = resumed.close;
  const base = `http://127.0.0.1:${resumed.port}/jobs/${resumed.jobId}`;
  const res = await fetch(base + "/fillers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kept: [decision(first)] }) });
  const review = await reviewOf(res); expect(review.units.filter(u => u.kept).map(u => u.id)).toEqual(["u001"]);
  expect(f.spans.at(-1)).toEqual([]); expect(review.fillers.groups[0]!.items[0]!.status).toBe("kept");
});

it("keep e cacoetes sobrepostos convergem e nenhuma resposta traz a geração superada", async () => {
  const f = await boot(); const first = await reviewOf(await f.post("/keep", { keepList: "u001-u002" }));
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
  let hits = 0; f.setBeforePlan(async () => { if (++hits === 1) { entered(); await gate; } });
  const a = f.post("/keep", { keepList: "u001" }); await started;
  const b = f.post("/fillers", { kept: [decision(first)] });
  await vi.waitFor(async () => { const body = await (await fetch(f.base)).json() as { generation: number; desiredGeneration: number; planning: boolean; review: Review }; expect(body.desiredGeneration).toBe(3); expect(body.generation).toBe(body.review.generation); expect(body.planning).toBe(true); });
  release();
  const [ra, rb] = await Promise.all([a.then(reviewOf), b.then(reviewOf)]);
  expect(ra.generation).toBe(3); expect(rb.generation).toBe(3);
  expect(ra.units.filter(u => u.kept).map(u => u.id)).toEqual(["u001"]);
  expect(f.spans.at(-1)).toEqual([]); expect((await saved(f.dir)).keep.trim()).toBe("u001");
});

it("decisões conflitantes em pedidos sucessivos usam a última", async () => {
  const f = await boot(), review = await reviewOf(await f.post("/keep", { keepList: "u001-u002" })), d = decision(review);
  await f.post("/fillers", { kept: [d] });
  const cut = await reviewOf(await f.post("/fillers", { cut: [d] }));
  expect(cut.fillers.groups[0]!.items[0]!.status).toBe("cut");
  expect(JSON.parse((await saved(f.dir)).fillers)).toMatchObject({ kept: [], cut: [expect.objectContaining(d)] });
  expect((await f.post("/fillers", { cut: [d], kept: [d] })).status).toBe(400);
});

it("falha mesmo depois de escrever plano preserva review e par; próxima ação conserva o estado desejado", async () => {
  const f = await boot(); const first = await reviewOf(await f.post("/keep", { keepList: "u001-u002" })), before = await saved(f.dir);
  f.setFail(true); expect((await f.post("/fillers", { kept: [decision(first)] })).status).toBe(500);
  expect(await saved(f.dir)).toEqual(before);
  const current = await (await fetch(f.base)).json() as { review: Review; warning: string; stage: string; planning: boolean };
  expect(current.review).toEqual(first); expect(current.stage).toBe("ready"); expect(current.warning).toContain("última mudança não foi aplicada");
  expect(current.planning).toBe(false);
  f.setFail(false); const next = await reviewOf(await f.post("/keep", { keepList: "u001" }));
  expect(next.generation).toBe(3); expect(f.spans.at(-1)).toEqual([]);
});

it("texto persistido divergente descarta decisão e mostra aviso", async () => {
  const f = await boot(); await writeFile(join(f.dir, "fillers.json"), JSON.stringify({ transcriptSha256: "outra", kept: [], cut: [] }));
  const review = await reviewOf(await f.post("/keep", { keepList: "u001-u002" }));
  expect(review.fillers.warnings.join(" ")).toContain("transcrição mudou");
});

it("nota Jev usa modelo configurado, publica via GET e não re-planeja nem repete o mesmo conjunto", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("jev-configured");
    return new Response(JSON.stringify({ model: body.model, answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: "noul", noul: 0.8 }])) }), { status: 200 });
  });
  const f = await boot(true, { fetchImpl, decision: { mode: "observe", model: "jev-configured" }, ambiguous: true });
  const first = await reviewOf(await f.post("/keep", { keepList: "u001-u002" }));
  await vi.waitFor(async () => { const job = await (await fetch(f.base)).json() as { fillerNotes: { score: number }[] }; expect(job.fillerNotes[0]?.score).toBe(0.8); });
  expect(fetchImpl).toHaveBeenCalledTimes(1); expect(f.calls.filter(c => c.args.includes("plan"))).toHaveLength(1);
  await f.post("/fillers", { kept: [decision(first)] });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(JSON.parse(await readFile(join(f.dir, "fillers-notes.json"), "utf8")).notes[0].model).toBe("jev-configured");
  const before = f.calls.filter(c => c.args.includes("plan")).length;
  await vi.waitFor(async () => { const job = await (await fetch(f.base)).json() as { review: Review }; expect(job.review.generation).toBe(2); });
  expect(f.calls.filter(c => c.args.includes("plan"))).toHaveLength(before);
});

it("valida identidade dos cacoetes na borda sem produzir nova geração", async () => {
  const f = await boot(), first = await reviewOf(await f.post("/keep", { keepList: "u001-u002" }));
  const d = decision(first);
  expect((await f.post("/fillers", { kept: [{ ...d, wordIds: ["forjada"] }] })).status).toBe(400);
  expect((await f.post("/fillers", { cut: "forjado" })).status).toBe(400);
  const j = await (await fetch(f.base)).json() as { generation: number; desiredGeneration: number };
  expect(j).toMatchObject({ generation: 1, desiredGeneration: 1 }); expect(f.spans).toHaveLength(1);
  for (const path of ["/fillers-ui.js", "/review-generation.js"]) {
    const res = await fetch(`http://127.0.0.1:${f.app.port}${path}`); expect(res.status).toBe(200); expect(await res.text()).toContain("export function");
  }
});

it("429 do cliente dedicado tenta uma vez e conserva ambíguos sinalizados sem corte", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response("simulado", { status: 429 }));
  const f = await boot(true, { fetchImpl, decision: { mode: "observe", model: "jev-configured" }, ambiguous: true });
  await reviewOf(await f.post("/keep", { keepList: "u001-u002" }));
  await vi.waitFor(async () => {
    const job = await (await fetch(f.base)).json() as { fillerNotes: { score: number | null; decisionFailure: string }[]; review: Review };
    expect(job.fillerNotes[0]).toMatchObject({ score: null, decisionFailure: "Jev indisponível" });
    expect(job.review.fillers.groups.flatMap(g => g.items).find(c => c.category === "ambiguous")!.status).toBe("signal");
  });
  expect(fetchImpl).toHaveBeenCalledTimes(1); expect(f.calls.filter(c => c.args.includes("plan"))).toHaveLength(1);
  expect(f.spans[0]!.every(c => c.category === "hesitation")).toBe(true);
});
