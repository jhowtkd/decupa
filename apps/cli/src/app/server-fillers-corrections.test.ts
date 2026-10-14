import { createHash } from "node:crypto";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const inject = vi.hoisted(() => ({ failOnce: false }));
vi.mock("@decupa/cache", async importOriginal => {
  const original = await importOriginal<typeof import("@decupa/cache")>();
  return { ...original, publishAtomic: async (...args: Parameters<typeof original.publishAtomic>) => {
    if (inject.failOnce && args[0].endsWith("fillers.json")) { inject.failOnce = false; throw Error("EIO simulado"); }
    return original.publishAtomic(...args);
  } };
});
vi.mock("./pipeline.ts", async importOriginal => {
  const original = await importOriginal<typeof import("./pipeline.ts")>();
  return { ...original, preflight: async () => {}, ensureAudioProxy: async () => false,
    runIngest: async () => ({ warning: "aviso original da ingestão" }) };
});
import { cleanupFixture } from "./cleanup-fillers.test-helper.ts";
import { startApp } from "./server.ts";
import type { Review } from "./review.ts";

let close: (() => Promise<void>) | undefined;
afterEach(async () => { inject.failOnce = false; await close?.(); close = undefined; });
async function boot(extra?: Parameters<typeof cleanupFixture>[1]) { const f = await cleanupFixture(true, extra); close = f.app.close; return f; }
const reviewOf = async (response: Response): Promise<Review> => { expect(response.status).toBe(200); return (await response.json() as { review: Review }).review; };
const success = () => vi.fn<typeof fetch>(async (_url, init) => {
  const body = JSON.parse(String(init?.body));
  return new Response(JSON.stringify({ model: body.model, answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: "noul", noul: 0.8 }])) }));
});
const jobOf = async (base: string) => (await (await fetch(base)).json()) as {
  stage: string; error?: string; review: Review; warning?: string; fillerWarning?: string; fillerNotesPending: boolean; fillerNotes?: { score: number | null }[];
};

it("falha transitória ao carregar índice permite nova tentativa na mesma sessão", async () => {
  const f = await boot(), path = join(f.dir, "out", "speech_index.json"), previous = await readFile(path, "utf8");
  await unlink(path); expect((await f.post("/keep", { keepList: "u001" })).status).toBe(500);
  await writeFile(path, previous);
  const review = await reviewOf(await f.post("/keep", { keepList: "u001" }));
  expect(review.generation).toBe(1); expect(review.fillers.supported).toBe(true);
  expect(f.spans).toHaveLength(1);
});

it.each(["JSON de decisão", "configuração de decisão", "parse estrito do índice"])("%s inválido conserva plano/review legados com aviso", async kind => {
  const f = await boot({ ambiguous: true, fetchImpl: success() });
  if (kind.includes("decisão")) {
    await mkdir(join(f.configDir, ".decupa"), { recursive: true });
    await writeFile(join(f.configDir, ".decupa", "decision.json"), kind.startsWith("JSON") ? "{" : JSON.stringify({ mode: "inexistente" }));
  } else {
    const path = join(f.dir, "out", "speech_index.json"), index = JSON.parse(await readFile(path, "utf8"));
    index.units[0].words[1].start = "inválido"; await writeFile(path, JSON.stringify(index));
  }
  const review = await reviewOf(await f.post("/keep", { keepList: "u001-u002" }));
  expect(review.fillers.supported).toBe(false); expect(review.fillers.groups).toEqual([]);
  expect(review.units).toHaveLength(2); expect(review.joins[0]?.isFiller).toBe(true);
  expect(review.fillers).toMatchObject({ count: 1, totalSeconds: 0.2 });
  expect(f.calls.at(-1)!.args.slice(-2)).toEqual(["--drop-fillers", "hard"]);
  expect((await jobOf(f.base)).fillerWarning).toContain("indisponíveis");
});

it.each([true, false])("confidence ausente usa hard; null explícito conserva suporte (ausente=%s)", async absent => {
  const f = await boot(), path = join(f.dir, "transcript.json"), transcript = JSON.parse(await readFile(path, "utf8"));
  if (absent) delete transcript.segments[0].words[1].confidence; else transcript.segments[0].words[1].confidence = null;
  const text = JSON.stringify(transcript); await writeFile(path, text);
  const indexPath = join(f.dir, "out", "speech_index.json"), index = JSON.parse(await readFile(indexPath, "utf8"));
  index.transcript_sha256 = createHash("sha256").update(text).digest("hex"); await writeFile(indexPath, JSON.stringify(index));
  const review = await reviewOf(await f.post("/keep", { keepList: "u001-u002" }));
  expect(review.fillers.supported).toBe(!absent);
  if (absent) {
    expect(f.calls.at(-1)!.args.slice(-2)).toEqual(["--drop-fillers", "hard"]);
    expect(review.fillers.totalSeconds).toBeCloseTo(0.2);
    expect(review.fillers.warnings).toContain("transcrição antiga: para cortar cacoetes por palavra, refaça a transcrição");
    expect((await jobOf(f.base)).warning ?? "").not.toContain("transcrição antiga");
  } else {
    expect(f.calls.at(-1)!.args).not.toContain("--drop-fillers"); expect(f.spans.at(-1)).toEqual([]);
    expect(review.fillers.groups[0]!.items[0]!.status).toBe("abstain");
  }
});

it("E/S da sessão mantém novo review/plano, par anterior e aviso de ingestão; próxima ação persiste o estado em memória", async () => {
  const f = await boot(); await f.app.close();
  const app = await startApp({ ...f.options, autoStart: true }); close = app.close;
  const base = `http://127.0.0.1:${app.port}/jobs/${app.jobId}`;
  await vi.waitFor(async () => expect((await jobOf(base)).stage).toBe("ready"));
  const first = (await jobOf(base)).review, candidate = first.fillers.groups[0]!.items[0]!;
  const previous = { keep: await readFile(join(f.dir, "keep.txt"), "utf8"), fillers: await readFile(join(f.dir, "fillers.json"), "utf8") };
  inject.failOnce = true;
  const post = (path: string, body: object) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const next = await reviewOf(await post("/fillers", { kept: [{ candidateId: candidate.id, wordIds: candidate.wordIds }] }));
  expect(next.generation).toBe(2); expect(next.fillers.groups[0]!.items[0]!.status).toBe("kept");
  expect(f.spans.at(-1)).toEqual([]);
  expect(JSON.parse(await readFile(join(f.dir, "out", "condense_plan.json"), "utf8")).removed.filler_items).toEqual([]);
  expect(await readFile(join(f.dir, "keep.txt"), "utf8")).toBe(previous.keep);
  expect(await readFile(join(f.dir, "fillers.json"), "utf8")).toBe(previous.fillers);
  const current = await jobOf(base);
  expect(current.review).toEqual(next); expect(current.stage).toBe("ready");
  expect(current.warning).toContain("aviso original da ingestão");
  expect(current.fillerWarning).toBe("não consegui gravar a sessão; ela não será retomada com esta mudança");
  const third = await reviewOf(await post("/keep", { keepList: "u001" }));
  expect(third.fillers.groups[0]!.items[0]!.status).toBe("kept"); expect(f.spans.at(-1)).toEqual([]);
  expect((await jobOf(base)).warning).toBe("aviso original da ingestão");
  expect(JSON.parse(await readFile(join(f.dir, "fillers.json"), "utf8")).kept).toHaveLength(1);
});

it.each(["sem cliente", "429"])("reabrir com Jev configurado pontua depois de sessão %s", async previous => {
  const fetchImpl = previous === "429" ? vi.fn<typeof fetch>(async () => new Response("simulado", { status: 429 })) : undefined;
  const f = await boot({ ambiguous: true, decision: { mode: "observe", model: "jev-configured" }, fetchImpl });
  await reviewOf(await f.post("/keep", { keepList: "u001-u002" }));
  if (fetchImpl) await vi.waitFor(async () => expect((await jobOf(f.base)).fillerNotes?.[0]?.score).toBe(null));
  else { expect((await jobOf(f.base)).fillerNotes).toEqual([]); expect((await jobOf(f.base)).fillerNotesPending).toBe(false); }
  await expect(readFile(join(f.dir, "fillers-notes.json"))).rejects.toMatchObject({ code: "ENOENT" });
  await f.app.close();
  const configured = success(), app = await startApp({ ...f.options, fetchImpl: configured,
    env: { ...f.options.env, DECUPA_TYPESAFE: "1", TYPESAFE_API_KEY: "fake" } }); close = app.close;
  const base = `http://127.0.0.1:${app.port}/jobs/${app.jobId}`;
  await reviewOf(await fetch(base + "/keep", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keepList: "u001-u002" }) }));
  await vi.waitFor(async () => expect((await jobOf(base)).fillerNotes?.[0]?.score).toBe(0.8));
  expect(configured).toHaveBeenCalledTimes(1); expect((await jobOf(base)).fillerNotesPending).toBe(false);
});

it("GET publica pendência apenas enquanto Jev trabalha; desmarcar/remarcar unidade reutiliza nota", async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; }), reply = success();
  const fetchImpl = vi.fn<typeof fetch>(async (...args) => { entered(); await gate; return reply(...args); });
  const f = await boot({ ambiguous: true, decision: { mode: "observe", model: "jev-configured" }, fetchImpl });
  await reviewOf(await f.post("/keep", { keepList: "u001-u002" })); await started;
  expect((await jobOf(f.base)).fillerNotesPending).toBe(true);
  release(); await vi.waitFor(async () => expect((await jobOf(f.base)).fillerNotesPending).toBe(false));
  expect((await jobOf(f.base)).fillerNotes?.[0]?.score).toBe(0.8);
  await f.post("/keep", { keepList: "u002" }); expect((await jobOf(f.base)).fillerNotes).toEqual([]);
  await f.post("/keep", { keepList: "u001-u002" });
  await vi.waitFor(async () => expect((await jobOf(f.base)).fillerNotes?.[0]?.score).toBe(0.8));
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it.each(["JSON de decisão", "configuração de decisão", "índice"])("fallback por %s conserva decisão salva sem regravar; reparo e reabertura a reaplicam", async kind => {
  const f = await boot(), first = await reviewOf(await f.post("/keep", { keepList: "u001-u002" }));
  const c = first.fillers.groups[0]!.items[0]!;
  await reviewOf(await f.post("/fillers", { kept: [{ candidateId: c.id, wordIds: c.wordIds }] }));
  const file = join(f.dir, "fillers.json"), saved = await readFile(file, "utf8"), beforeStat = await stat(file, { bigint: true });
  const indexFile = join(f.dir, "out", "speech_index.json"), originalIndex = await readFile(indexFile, "utf8");
  const decisionFile = join(f.configDir, ".decupa", "decision.json");
  await f.app.close();
  if (kind === "índice") {
    const index = JSON.parse(originalIndex); index.units[0].words[1].start = "inválido"; await writeFile(indexFile, JSON.stringify(index));
  } else {
    await mkdir(join(f.configDir, ".decupa"), { recursive: true });
    await writeFile(decisionFile, kind === "JSON de decisão" ? "{" : JSON.stringify({ mode: "inexistente" }));
  }
  const restart = async () => {
    const app = await startApp(f.options); close = app.close;
    const base = `http://127.0.0.1:${app.port}/jobs/${app.jobId}`;
    return { app, post: (keepList: string) => fetch(base + "/keep", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keepList }) }) };
  };
  const fallback = await restart();
  for (const keepList of ["u001", "u001-u002"]) {
    expect((await reviewOf(await fallback.post(keepList))).fillers.supported).toBe(false);
    expect(await readFile(file, "utf8")).toBe(saved);
    expect((await stat(file, { bigint: true })).mtimeNs).toBe(beforeStat.mtimeNs);
  }
  expect(await readFile(join(f.dir, "keep.txt"), "utf8")).toBe("u001-u002\n");
  await fallback.app.close();
  if (kind === "índice") await writeFile(indexFile, originalIndex); else await unlink(decisionFile);
  const repaired = await restart(), review = await reviewOf(await repaired.post("u001-u002"));
  expect(review.fillers.supported).toBe(true);
  expect(review.fillers.groups[0]!.items[0]).toMatchObject({ id: c.id, status: "kept" });
  expect(f.spans.at(-1)).toEqual([]);
});

it("ingest com índice vazio volta à mensagem acionável de vídeo sem fala", async () => {
  const f = await boot(); await f.app.close();
  await writeFile(join(f.dir, "out", "speech_index.json"), JSON.stringify({ units: [] }));
  const app = await startApp({ ...f.options, autoStart: true }); close = app.close;
  const base = `http://127.0.0.1:${app.port}/jobs/${app.jobId}`;
  await vi.waitFor(async () => {
    const current = await jobOf(base); expect(current.stage).toBe("error");
    expect(current.error).toBe("nenhuma unidade de fala para cortar: a transcrição deste vídeo não trouxe fala que o motor aproveite. Confira se o áudio tem voz em português.");
  });
  expect(f.spans).toEqual([]);
});

it.each([true, false])("aviso legado tem um lugar só (cartão visível=%s)", async visible => {
  const f = await boot(), indexFile = join(f.dir, "out", "speech_index.json"), index = JSON.parse(await readFile(indexFile, "utf8"));
  if (visible) {
    const path = join(f.dir, "transcript.json"), transcript = JSON.parse(await readFile(path, "utf8"));
    delete transcript.segments[0].words[1].confidence;
    const text = JSON.stringify(transcript); await writeFile(path, text);
    index.transcript_sha256 = createHash("sha256").update(text).digest("hex");
  } else for (const unit of index.units) unit.words = [];
  await writeFile(indexFile, JSON.stringify(index));
  const review = await reviewOf(await f.post("/keep", { keepList: "u001-u002" })), current = await jobOf(f.base);
  expect(review.fillers.groups.length > 0).toBe(visible); expect(review.fillers.supported).toBe(false);
  const warning = visible ? "transcrição antiga: para cortar cacoetes por palavra, refaça a transcrição"
    : "índice ou transcrição sem palavras; cacoetes por palavra indisponíveis";
  expect(review.fillers.warnings.filter(w => w === warning)).toHaveLength(1);
  expect((current.warning ?? "").includes(warning)).toBe(!visible);
});
