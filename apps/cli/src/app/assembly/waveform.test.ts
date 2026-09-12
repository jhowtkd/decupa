import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { Executor } from "../pipeline.ts";
import { buildPeaks, peaksPath } from "./waveform.ts";

const SHA = "a".repeat(64);

/** 1 s a 8 kHz: primeira metade silêncio, segunda senoide 440 Hz ×10000. */
function deterministicPcm(): Buffer {
  const count = 8000;
  const buf = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) {
    const value = i < count / 2 ? 0 : Math.round(10000 * Math.sin((2 * Math.PI * 440 * i) / 8000));
    buf.writeInt16LE(value, i * 2);
  }
  return buf;
}

/** Executor fake: grava o PCM no destino pedido (último arg) como o ffmpeg faria. */
function pcmExec(pcm: Buffer, code = 0): Executor {
  return {
    async run(call) {
      if (code === 0) {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(call.args[call.args.length - 1]!, pcm);
      }
      return { code, stdout: code === 0 ? "" : "boom", stderr: "" };
    },
  };
}

it("peaksPath resolve o cache ao lado do proxy (arquivo por sha)", () => {
  expect(peaksPath("/proj", SHA)).toBe(join("/proj", "media", SHA, `${SHA}.peaks.json`));
});

it("buildPeaks agrega min/max por bucket do PCM determinístico", async () => {
  const dir = await mkdtemp(join(tmpdir(), "waveform-"));
  const outPath = peaksPath(dir, SHA);
  const result = await buildPeaks(
    pcmExec(deterministicPcm()),
    { proxyPath: join(dir, "proxy.mp4"), sha256: SHA, outPath, buckets: 10 },
  );
  expect(result).toEqual({ path: outPath, buckets: 10, count: 8000 });
  const file = JSON.parse(await readFile(outPath, "utf8")) as {
    sha256: string; sampleRate: number; buckets: number; count: number;
    peaks: { min: number; max: number }[];
  };
  expect(file.sha256).toBe(SHA);
  expect(file.sampleRate).toBe(8000);
  expect(file.buckets).toBe(10);
  expect(file.count).toBe(8000);
  expect(file.peaks).toHaveLength(10);
  // Metade silenciosa: buckets exatos em zero.
  for (const bucket of file.peaks.slice(0, 5)) {
    expect(bucket).toEqual({ min: 0, max: 0 });
  }
  // Metade senoidal: excursão cheia nos dois sentidos.
  for (const bucket of file.peaks.slice(5)) {
    expect(bucket.min).toBeLessThanOrEqual(-9900);
    expect(bucket.max).toBeGreaterThanOrEqual(9900);
  }
});

it("buildPeaks usa 1000 buckets por padrão", async () => {
  const dir = await mkdtemp(join(tmpdir(), "waveform-"));
  const outPath = peaksPath(dir, SHA);
  const result = await buildPeaks(
    pcmExec(deterministicPcm()),
    { proxyPath: join(dir, "proxy.mp4"), sha256: SHA, outPath },
  );
  expect(result).toEqual({ path: outPath, buckets: 1000, count: 8000 });
  const file = JSON.parse(await readFile(outPath, "utf8")) as { peaks: unknown[] };
  expect(file.peaks).toHaveLength(1000);
});

it("falha do executor vira null sem deixar arquivo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "waveform-"));
  const outPath = peaksPath(dir, SHA);
  const result = await buildPeaks(
    pcmExec(Buffer.alloc(0), 1),
    { proxyPath: join(dir, "proxy.mp4"), sha256: SHA, outPath, buckets: 10 },
  );
  expect(result).toBeNull();
  await expect(stat(outPath)).rejects.toThrow();
});

it("executor que lança vira null (best-effort)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "waveform-"));
  const outPath = peaksPath(dir, SHA);
  const throwing: Executor = {
    async run() {
      throw new Error("ffmpeg sumiu do PATH");
    },
  };
  const result = await buildPeaks(
    throwing,
    { proxyPath: join(dir, "proxy.mp4"), sha256: SHA, outPath, buckets: 10 },
  );
  expect(result).toBeNull();
});

it("calcula buckets proporcionalmente à duração quando não especificado", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decupa-peaks-dur-"));
  const outPath = join(dir, "test.peaks.json");
  const count = 80000;
  const buf = Buffer.alloc(count * 2);
  const result = await buildPeaks(pcmExec(buf), {
    proxyPath: "/tmp/proxy.mp4",
    sha256: "sha-1",
    outPath,
    durationSeconds: 120,
  });
  expect(result?.buckets).toBe(3000);
});

