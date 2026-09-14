import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FakeExecutor,
  makeTriageProxy,
  runIngest,
  SpawnExecutor,
  type Executor,
} from "./pipeline.ts";
import { defaultTranscode } from "../triage.ts";

/**
 * Escolha documentada (ICE3-05): `services/vision/visual_index.py` não exige
 * dimensões fixas — lê qualquer quadro via cv2 e trabalha com coordenadas
 * normalizadas do MediaPipe (lm.x/lm.y em 0..1). Por isso os proxies usam
 * `force_original_aspect_ratio=decrease` puro, sem letterbox/pad — o mesmo
 * padrão de `assembly/model.ts`. O teto continua 270×480 (triagem) e 540×960
 * (visual); fonte 16:9 sai 16:9, só que menor.
 */

const job = { id: "j1", videoPath: "/vid/aula.mp4", workDir: "/work/j1" };

function vfDe(exec: FakeExecutor): string {
  const ffmpeg = exec.calls.find((c) => c.command === "ffmpeg");
  const vf = ffmpeg?.args[ffmpeg.args.indexOf("-vf") + 1];
  expect(vf).toBeDefined();
  return vf!;
}

/** O -vf do proxy visual passa por `runIngest` (`runVisualIndex` é privado). */
async function vfVisual(): Promise<string> {
  const exec = new FakeExecutor();
  await runIngest(job, exec, () => {});
  return vfDe(exec);
}

describe("proxies sem distorção de aspecto", () => {
  it("proxy de triagem preserva 16:9", async () => {
    const exec = new FakeExecutor();
    await makeTriageProxy(job, exec);
    const vf = vfDe(exec);
    expect(vf).toContain("force_original_aspect_ratio");
    expect(vf).not.toContain("scale=270:480");
  });

  it("proxy visual preserva 16:9", async () => {
    const vf = await vfVisual();
    expect(vf).toContain("force_original_aspect_ratio");
    expect(vf).not.toContain("scale=540:960");
  });
});

const hasFfmpeg = ((): boolean => {
  try {
    return spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
})();

async function dimensoes(exec: Executor, video: string): Promise<{ w: number; h: number }> {
  const { code, stdout } = await exec.run({
    command: "ffprobe",
    args: [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height", "-of", "csv=p=0",
      video,
    ],
  });
  expect(code).toBe(0);
  const [w, h] = stdout.trim().split(",").map(Number);
  return { w: w!, h: h! };
}

describe.skipIf(!hasFfmpeg)("proxies a partir de fonte 16:9 (integração)", () => {
  it("triagem e visual reais saem 16:9 dentro do teto", async () => {
    const exec = new SpawnExecutor();
    const dir = await mkdtemp(join(tmpdir(), "decupa-proxy-aspect-"));
    const fonte = join(dir, "fonte-16x9.mp4");
    const gerado = await exec.run({
      command: "ffmpeg",
      args: [
        "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30",
        "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-y", fonte,
      ],
    });
    expect(gerado.code).toBe(0);

    const triagem = await makeTriageProxy(
      { id: "j1", videoPath: fonte, workDir: dir }, exec,
    );
    const t = await dimensoes(exec, triagem);
    expect(t.w / t.h).toBeCloseTo(16 / 9, 2);
    expect(t.w).toBeLessThanOrEqual(270);
    expect(t.h).toBeLessThanOrEqual(480);

    // O -vf visual é o que o `runIngest` realmente emite, aplicado de verdade.
    const vf = await vfVisual();
    const visual = join(dir, "visual.mp4");
    const feito = await exec.run({
      command: "ffmpeg",
      args: [
        "-i", fonte, "-vf", vf,
        "-c:v", "libx264", "-crf", "32", "-preset", "veryfast",
        "-an", "-y", visual,
      ],
    });
    expect(feito.code).toBe(0);
    const v = await dimensoes(exec, visual);
    expect(v.w / v.h).toBeCloseTo(16 / 9, 2);
    expect(v.w).toBeLessThanOrEqual(540);
    expect(v.h).toBeLessThanOrEqual(960);
  }, 120_000);

  it("transcode reserva da triagem (triage.ts) sai 16:9 dentro do teto", async () => {
    const exec = new SpawnExecutor();
    const dir = await mkdtemp(join(tmpdir(), "decupa-proxy-aspect-"));
    const fonte = join(dir, "fonte-16x9.mp4");
    const gerado = await exec.run({
      command: "ffmpeg",
      args: [
        "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30",
        "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-y", fonte,
      ],
    });
    expect(gerado.code).toBe(0);
    const destino = join(dir, "triage-proxy.mp4");
    await defaultTranscode(fonte, destino);
    const t = await dimensoes(exec, destino);
    expect(t.w / t.h).toBeCloseTo(16 / 9, 2);
    expect(t.w).toBeLessThanOrEqual(270);
    expect(t.h).toBeLessThanOrEqual(480);
  }, 120_000);
});
