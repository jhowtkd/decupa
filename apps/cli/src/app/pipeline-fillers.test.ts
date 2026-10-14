import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { engineSupportsFillerSpans, FakeExecutor, runPlan } from "./pipeline.ts";

it("detecção só observa suporte; [] produz JSON vazio e nunca entra no léxico", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "pipeline-fillers-")), exec = new FakeExecutor();
  await mkdir(join(workDir, "mcp", "ve_tools"), { recursive: true });
  const source = join(workDir, "mcp", "ve_tools", "condense.py");
  await writeFile(source, 'args.get("drop_fillers")'); expect(await engineSupportsFillerSpans(workDir)).toBe(false);
  await writeFile(source, 'args.get("drop_filler_spans")'); expect(await engineSupportsFillerSpans(workDir)).toBe(true);
  expect(await engineSupportsFillerSpans(join(workDir, "ausente"))).toBe(false);
  await runPlan({ id: "j", videoPath: "/fake.mp4", workDir }, "u001", exec, undefined, { supported: true, generation: 3, spans: [] });
  const args = exec.calls[0]!.args;
  expect(args).not.toContain("--drop-fillers");
  const path = args[args.indexOf("--drop-filler-spans") + 1]!;
  expect(path).toBe(join(workDir, "fillers-spans-3.json")); expect(await readFile(path, "utf8")).toBe("[]\n");
  await runPlan({ id: "j", videoPath: "/fake.mp4", workDir }, "u001", exec, undefined, { supported: false, generation: 4, spans: [] });
  expect(exec.calls[1]!.args.slice(-2)).toEqual(["--drop-fillers", "hard"]);
});

it("wrapper Python passa presença/vazio e spans ao motor simulado, e rejeita JSON não-lista", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wrapper-fillers-")), module = join(dir, "mcp", "ve_tools");
  await mkdir(module, { recursive: true });
  await writeFile(join(module, "__init__.py"), "");
  await writeFile(join(module, "run_context.py"), "class RunContext:\n def __init__(self, **kwargs): pass\n");
  await writeFile(join(module, "condense.py"), "import json\nfrom types import SimpleNamespace\ndef condense_plan(args, ctx):\n return SimpleNamespace(text=json.dumps(args))\ncondense_index=condense_qc=condense_render=condense_plan\n");
  const file = join(dir, "spans.json");
  const invoke = (flag: boolean) => JSON.parse(execFileSync("python3", [resolve("scripts/condense.py"), "plan", "/fake.mp4", "--keep", "u001", ...(flag ? ["--drop-filler-spans", file] : ["--drop-fillers", "hard"])], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, VE_PLUGIN_ROOT: dir } }));
  expect(invoke(false)).toEqual({ video_path: "/fake.mp4", keep: ["u001"], drop_fillers: "hard" });
  await writeFile(file, "[]"); expect(invoke(true)).toEqual({ video_path: "/fake.mp4", keep: ["u001"], drop_filler_spans: [] });
  const spans = [{ start: 1, end: 2, candidate_id: "c" }]; await writeFile(file, JSON.stringify(spans));
  expect(invoke(true).drop_filler_spans).toEqual(spans);
  await writeFile(file, "{}"); expect(() => invoke(true)).toThrow(/lista JSON/);
});
