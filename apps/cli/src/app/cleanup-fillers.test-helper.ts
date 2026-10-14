import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, vi } from "vitest";
import type { FillerSpan } from "../condense/fillers.ts";
import { startApp } from "./server.ts";
import { sourceManifestPath } from "./session.ts";
import type { Executor, ExecCall } from "./pipeline.ts";
afterEach(() => { vi.restoreAllMocks(); });

export async function cleanupFixture(supported = true, extra?: { fetchImpl?: typeof fetch; decision?: object; ambiguous?: boolean }) {
  const dir = await mkdtemp(join(tmpdir(), "decupa-fillers-")), video = join(dir, "video.mp4"), engine = join(dir, "engine");
  await writeFile(video, "fake video");
  const configDir = join(dir, "project-config"); await mkdir(configDir);
  // A configuração da Limpeza é a do cwd; a sessão e o diário ficam no workDir.
  vi.spyOn(process, "cwd").mockReturnValue(configDir);
  const source = await stat(video);
  await writeFile(sourceManifestPath(dir), JSON.stringify({ path: video, size: source.size, mtimeMs: source.mtimeMs }));
  await mkdir(join(dir, "out")); await mkdir(join(engine, "mcp", "ve_tools"), { recursive: true });
  await writeFile(join(engine, "mcp", "ve_tools", "condense.py"), supported ? 'args.get("drop_filler_spans")' : 'args.get("drop_fillers")');
  const words = [{ text: "Bom", start: 0, end: 0.3 }, { text: "hã", start: 0.35, end: 0.55 },
    { text: "dia", start: 0.6, end: 1 }, ...(extra?.ambiguous ? [{ text: "é", start: 1.05, end: 1.2 }, { text: "bom", start: 1.25, end: 1.5 }] : [])];
  const units = [{ id: "u001", index: 0, start: 0, end: 1.5, duration: 1.5, text: words.map(w => w.text).join(" "), words },
    { id: "u002", index: 1, start: 2, end: 3, duration: 1, text: "Segue", words: [{ text: "Segue", start: 2, end: 3 }] }];
  const transcript = JSON.stringify({ segments: units.map(u => ({ start: u.start, end: u.end, text: u.text,
    words: u.words.map((w, i) => ({ ...w, id: `${u.id}:w${i}`, confidence: 1 })) })) });
  await writeFile(join(dir, "transcript.json"), transcript);
  await writeFile(join(dir, "out", "speech_index.json"), JSON.stringify({ units, transcript_sha256: createHash("sha256").update(transcript).digest("hex") }));
  await writeFile(join(dir, "out", "condense_plan.json"), JSON.stringify({ source_duration: 3, output_duration: 3, clips: [{ unit_ids: ["u001", "u002"], start: 0, end: 3 }], joins: [] }));
  if (extra?.decision) { await mkdir(join(configDir, ".decupa")); await writeFile(join(configDir, ".decupa", "decision.json"), JSON.stringify(extra.decision)); }
  const calls: ExecCall[] = [], spans: FillerSpan[][] = [];
  let beforePlan: (() => Promise<void>) | undefined, fail = false;
  const exec: Executor = { run: async call => {
    calls.push(call);
    if (call.args.includes("plan")) {
      await beforePlan?.();
      const flag = call.args.indexOf("--drop-filler-spans");
      const selected: FillerSpan[] = flag < 0 ? [] : JSON.parse(await readFile(call.args[flag + 1]!, "utf8")); spans.push(selected);
      const kept = call.args.slice(call.args.indexOf("--keep") + 1, call.args.findIndex(a => a.startsWith("--drop")));
      const ids = kept.join(" ").includes("u001-u002") ? ["u001", "u002"] : kept;
      const legacy = flag < 0 && ids.includes("u001");
      const plan = { source_duration: 3, output_duration: 3 - (legacy ? 0.2 : selected.reduce((s, c) => s + c.end - c.start, 0)),
        clips: [{ unit_ids: ids, start: 0, end: 3 }],
        joins: legacy ? [{ outgoing_unit: "u001", incoming_unit: "u001", source_out: 0.35, source_in: 0.55, removed_seconds: 0.2, kind: "filler" }]
          : selected.map(s => ({ outgoing_unit: s.unit, incoming_unit: s.unit, source_out: s.start, source_in: s.end, removed_seconds: s.end - s.start, kind: "filler" })),
        ...(flag >= 0 ? { removed: { filler_items: selected.map(s => ({ ...s, removed: [{ start: s.start, end: s.end }] })), filler_skipped: [] } } : {}) };
      await writeFile(join(dir, "out", "condense_plan.json"), JSON.stringify(plan));
      if (fail) return { code: 2, stdout: "[ERROR] motor simulado", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  } };
  const options = { input: video, workDir: dir, executor: exec, autoStart: false, port: 0,
    env: { VE_PLUGIN_ROOT: engine, ...(extra?.fetchImpl ? { DECUPA_TYPESAFE: "1", TYPESAFE_API_KEY: "fake" } : {}) }, fetchImpl: extra?.fetchImpl };
  const app = await startApp(options), base = `http://127.0.0.1:${app.port}/jobs/${app.jobId}`;
  const post = (route: string, body: object) => fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { dir, configDir, app, base, post, calls, spans, options, setBeforePlan: (fn?: () => Promise<void>) => { beforePlan = fn; }, setFail: (value: boolean) => { fail = value; } };
}
