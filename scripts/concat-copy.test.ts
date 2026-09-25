import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);
const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const PYTHON = process.platform === "win32" ? "python" : "python3";

async function ff(args: string[]): Promise<void> {
  await run("ffmpeg", ["-v", "error", "-y", ...args]);
}

/** Segmento normalizado como o motor faz no corte duro (libx264 + AAC 48 kHz estéreo). */
async function segment(dir: string, name: string, seconds: number, hz: number): Promise<string> {
  const out = join(dir, name);
  await ff([
    "-f", "lavfi", "-i", `testsrc=size=320x240:rate=30:duration=${seconds}`,
    "-f", "lavfi", "-i", `sine=frequency=${hz}:sample_rate=48000:duration=${seconds}`,
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-ar", "48000", "-ac", "2", "-shortest", out,
  ]);
  return out;
}

type Packet = { size: number; key: boolean; hash: string };

async function packets(path: string): Promise<Packet[]> {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=size,flags,data_hash",
    "-show_data_hash", "md5", "-of", "csv=p=0", path,
  ]);
  return stdout.trim().split(/\r?\n/).map((line) => {
    const [size, flags, hash] = line.split(",");
    return { size: Number(size), key: flags!.startsWith("K"), hash: hash! };
  });
}

async function python(code: string, env: NodeJS.ProcessEnv = {}): Promise<string> {
  const { stdout } = await run(PYTHON, ["-c", code], {
    env: { ...process.env, ...env, PYTHONPATH: SCRIPTS },
  });
  return stdout.trim();
}

it("concatena copiando o vídeo dos segmentos e recodifica só o áudio", async () => {
  const dir = await mkdtemp(join(tmpdir(), "concat-copy-"));
  const a = await segment(dir, "seg-a.mp4", 1.5, 440);
  const b = await segment(dir, "seg-b.mp4", 2, 660);
  const out = join(dir, "corte.mp4");
  const result = await python(
    `import json\nfrom concat_copy import concat_video_copy\n` +
    `print(json.dumps(concat_video_copy([{"path": ${JSON.stringify(a)}}, {"path": ${JSON.stringify(b)}}], ${JSON.stringify(out)}, crf=18)))`,
  );
  expect(JSON.parse(result)).toBeNull();

  // Vídeo por cópia: mesmos pacotes, na mesma ordem. Só o quadro-chave que abre
  // cada segmento ganha os parâmetros do H.264 (SPS/PPS) em banda, poucos bytes.
  const source = [...await packets(a), ...await packets(b)];
  const output = await packets(out);
  expect(output).toHaveLength(source.length);
  const segmentStarts = new Set([0, (await packets(a)).length]);
  for (const [i, pkt] of output.entries()) {
    if (segmentStarts.has(i)) {
      expect(pkt.key).toBe(true);
      expect(pkt.size - source[i]!.size).toBeGreaterThanOrEqual(0);
      expect(pkt.size - source[i]!.size).toBeLessThan(256);
    } else {
      expect(pkt.hash, `pacote ${i}`).toBe(source[i]!.hash);
    }
  }
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-show_entries", "stream=codec_type,codec_name:format=duration", "-of", "json", out,
  ]);
  const info = JSON.parse(stdout) as { streams: { codec_type: string; codec_name: string }[]; format: { duration: string } };
  expect(info.streams.map((s) => `${s.codec_type}:${s.codec_name}`)).toEqual(["video:h264", "audio:aac"]);
  expect(Number(info.format.duration)).toBeGreaterThan(3.3);
  expect(Number(info.format.duration)).toBeLessThan(3.8);
}, 60_000);

it("se a cópia falhar, cai na concatenação original do motor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "concat-fallback-"));
  const code = [
    "import json, types",
    "from concat_copy import install",
    "calls = []",
    "engine = types.SimpleNamespace(_concat_hard=lambda segments, output_path, *, crf: calls.append(crf) or None)",
    "installed = install(engine)",
    `missing = [{"path": ${JSON.stringify(join(dir, "nao-existe.mp4"))}}]`,
    `result = engine._concat_hard(missing, ${JSON.stringify(join(dir, "out.mp4"))}, crf=18)`,
    "print(json.dumps({'installed': installed, 'result': result, 'calls': calls}))",
  ].join("\n");
  expect(JSON.parse(await python(code))).toEqual({ installed: true, result: null, calls: [18] });
  // A/B: com DECUPA_CONCAT_REENCODE=1 o motor fica intocado.
  const untouched = await python(
    "import types\nfrom concat_copy import install\nprint(install(types.SimpleNamespace(_concat_hard=lambda *a, **k: None)))",
    { DECUPA_CONCAT_REENCODE: "1" },
  );
  expect(untouched).toBe("False");
}, 30_000);
