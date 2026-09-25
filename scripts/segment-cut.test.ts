import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);
const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const PYTHON = process.platform === "win32" ? "python" : "python3";

async function python(code: string, env: NodeJS.ProcessEnv = {}): Promise<unknown> {
  const { stdout } = await run(PYTHON, ["-c", code], {
    env: { ...process.env, ...env, PYTHONPATH: SCRIPTS },
  });
  return JSON.parse(stdout.trim());
}

/** Comando de segmento no formato que o motor monta em `_cut_segment`. */
const ENGINE_CMD = [
  "ffmpeg", "-y", "-v", "error", "-ss", "1.000000", "-t", "2.000000", "-i", "src.mp4",
  "-map", "0:v:0", "-map", "0:a:0", "-vf", "scale=1728:3072", "-r", "30.000000",
  "-af", "afade=t=in:st=0:d=0.008", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
  "-c:a", "aac", "-ar", "48000", "-ac", "2", "-shortest", "-avoid_negative_ts", "make_zero", "out.mp4",
];

/** Motor falso: `_cut_segment` chama o `run_proc` global do módulo, como o real. */
const FAKE_ENGINE = `
import json, sys, types
engine = types.ModuleType("engine")
calls = []
class Proc:
    def __init__(self, rc): self.returncode = rc
def run_proc(cmd, *a, **k):
    calls.append(list(cmd))
    return Proc(1 if (FAIL_VT and "h264_videotoolbox" in cmd) else 0)
engine.run_proc = run_proc
exec("def _cut_segment(video_path, clip, output_path, **kw):\\n    return None if run_proc(CMD).returncode == 0 else 'erro'", engine.__dict__)
engine.CMD = CMD
`;

it("troca só o codificador e põe -hwaccel antes da entrada do vídeo", async () => {
  const out = await python(
    `import json\nfrom segment_cut import vt_command\nprint(json.dumps(vt_command(${JSON.stringify(ENGINE_CMD)})))`,
  ) as string[];
  expect(out.indexOf("-hwaccel")).toBeLessThan(out.indexOf("-ss"));
  expect(out[out.indexOf("-hwaccel") + 1]).toBe("videotoolbox");
  expect(out.slice(out.indexOf("-c:v"), out.indexOf("-c:v") + 6))
    .toEqual(["-c:v", "h264_videotoolbox", "-q:v", "68", "-allow_sw", "0"]);
  expect(out).not.toContain("libx264");
  expect(out).not.toContain("-crf");
  // Todo o resto (filtros, declick, áudio, saída) continua o do motor.
  expect(out.slice(out.indexOf("-c:a"))).toEqual(ENGINE_CMD.slice(ENGINE_CMD.indexOf("-c:a")));
  expect(out.slice(out.indexOf("-map"), out.indexOf("-c:v")))
    .toEqual(ENGINE_CMD.slice(ENGINE_CMD.indexOf("-map"), ENGINE_CMD.indexOf("-c:v")));
});

it("lê o codec da primeira linha do ffprobe (grupo de streams repete o codec)", async () => {
  expect(await python("import json\nfrom segment_cut import first_codec\nprint(json.dumps([first_codec('hevc\\n\\nhevc\\n'), first_codec('h264\\n'), first_codec('')]))"))
    .toEqual(["hevc", "h264", ""]);
});

async function cut(opts: { codec: string; failVt?: boolean; platform?: string; hardJoin?: boolean; env?: NodeJS.ProcessEnv }): Promise<{
  installed: boolean; vtCalls: number; x264Calls: number; result: string | null; mixed: boolean; makeZero: boolean;
}> {
  return await python(`
CMD = ${JSON.stringify(ENGINE_CMD)}
FAIL_VT = ${opts.failVt ? "True" : "False"}
${FAKE_ENGINE}
import segment_cut
installed = segment_cut.install(engine, hard_join=${opts.hardJoin === false ? "False" : "True"}, platform=${JSON.stringify(opts.platform ?? "darwin")}, probe=lambda p: ${JSON.stringify(opts.codec)})
result = engine._cut_segment("src.mp4", {}, "out.mp4")
print(json.dumps({
  "installed": installed,
  "vtCalls": sum(1 for c in calls if "h264_videotoolbox" in c),
  "x264Calls": sum(1 for c in calls if "libx264" in c),
  "result": result,
  "mixed": segment_cut.state["mixed"],
  "makeZero": any("-avoid_negative_ts" in c for c in calls),
}))
`, opts.env) as never;
}

it("fonte HEVC no macOS: segmento sai em VideoToolbox", async () => {
  expect(await cut({ codec: "hevc" })).toEqual({ installed: true, vtCalls: 1, x264Calls: 0, result: null, mixed: false, makeZero: false });
});

it("fonte H.264 continua em libx264 (VideoToolbox não compensa ali)", async () => {
  expect(await cut({ codec: "h264" })).toEqual({ installed: true, vtCalls: 0, x264Calls: 1, result: null, mixed: false, makeZero: false });
});

it("VideoToolbox que falha refaz o segmento com o comando original do motor", async () => {
  expect(await cut({ codec: "hevc", failVt: true })).toEqual({ installed: true, vtCalls: 1, x264Calls: 1, result: null, mixed: false, makeZero: false });
});

it("fora do macOS ou com DECUPA_RENDER_SOFTWARE=1 não usa VideoToolbox, mas corrige o início", async () => {
  for (const opts of [{ platform: "win32" }, { env: { DECUPA_RENDER_SOFTWARE: "1" } }]) {
    const out = await cut({ codec: "hevc", ...opts });
    expect(out).toMatchObject({ installed: true, vtCalls: 0, x264Calls: 1, makeZero: false });
  }
});

it("junção com dissolve ou DECUPA_SEGMENT_MAKE_ZERO=1 mantém o make_zero do motor", async () => {
  expect(await cut({ codec: "h264", hardJoin: false, platform: "win32" }))
    .toMatchObject({ installed: false, makeZero: true });
  expect(await cut({ codec: "h264", env: { DECUPA_SEGMENT_MAKE_ZERO: "1" } }))
    .toMatchObject({ installed: true, makeZero: true });
});

it("start_at_zero só remove o -avoid_negative_ts make_zero", async () => {
  const out = await python(
    `import json\nfrom segment_cut import start_at_zero\nprint(json.dumps(start_at_zero(${JSON.stringify(ENGINE_CMD)})))`,
  ) as string[];
  expect(out).toEqual(ENGINE_CMD.filter((arg, i) => arg !== "-avoid_negative_ts" && ENGINE_CMD[i - 1] !== "-avoid_negative_ts"));
});

it("segmentos de codificadores diferentes desligam a junção por cópia", async () => {
  const out = await python(`
CMD = ${JSON.stringify(ENGINE_CMD)}
FAIL_VT = False
${FAKE_ENGINE}
import segment_cut, concat_copy
segment_cut.install(engine, platform="darwin", probe=lambda p: "hevc")
engine._cut_segment("a.mp4", {}, "1.mp4")
FAIL_VT = True
engine.run_proc.__globals__["FAIL_VT"] = True
engine._cut_segment("a.mp4", {}, "2.mp4")
copied = []
engine._concat_hard = lambda segments, output_path, *, crf: copied.append("original") or None
concat_copy.install(engine, should_copy=lambda: not segment_cut.state["mixed"])
engine._concat_hard([{"path": "1.mp4"}], "out.mp4", crf=18)
print(json.dumps({"mixed": segment_cut.state["mixed"], "concat": copied}))
`);
  expect(out).toEqual({ mixed: true, concat: ["original"] });
});
