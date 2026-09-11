import { access, copyFile, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { hashFile, probe } from "@decupa/media";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import { SpawnExecutor, type ExecCall, type Executor } from "../pipeline.ts";
import { fixtureAssembly } from "./fixture.ts";
import { ensurePlayback, proxyPath, thumbnailPath, verifySourceIdentity } from "./media.ts";
import type { Source } from "./types.ts";

async function sourceFrom(path: string, overrides: Partial<Source> = {}): Promise<Source> {
  const base = fixtureAssembly().sources[0]!;
  const info = await probe(path);
  const st = await stat(path);
  return {
    ...base,
    id: "a",
    path,
    sha256: await hashFile(path),
    durationSeconds: Math.max(info.durationMs / 1000, 0.001),
    hasVideo: info.hasVideo,
    hasAudio: info.hasAudio,
    name: "fala.mp4",
    size: st.size,
    mtimeMs: st.mtimeMs,
    ...overrides,
  };
}

/** Executa ffmpeg de verdade quando o teste precisa provar o comando. */
const realExec = () => new SpawnExecutor();

/** Finge o ffmpeg copiando mídia real para a saída pedida. */
function copyingExec(extra?: (output: string) => Promise<void>): Executor & { calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  return {
    calls,
    async run(call: ExecCall) {
      calls.push(call);
      const output = call.args[call.args.length - 1]!;
      if (output.endsWith(".tmp.mp4")) {
        await copyFile(join(FIXTURES, "clip.mp4"), output);
      } else if (output.endsWith(".tmp.jpg")) {
        await writeFile(output, "miniatura");
      }
      if (extra) await extra(output);
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

it("gera proxy reproduzível e miniatura com ffmpeg real", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-media-"));
  const path = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), path);
  const source = await sourceFrom(path);
  const result = await ensurePlayback(source, dir, realExec());
  expect(result.videoPath).toBe(proxyPath(dir, source.sha256));
  const info = await probe(result.videoPath);
  expect(info.hasVideo || info.hasAudio).toBe(true);
  expect(result.thumbnailPath).toBe(thumbnailPath(dir, source.sha256));
  await access(result.thumbnailPath!);
}, 60000);

it("falha de geração de proxy não publica nada", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-media-"));
  const path = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), path);
  const source = await sourceFrom(path);
  const failing: Executor = { async run() { return { code: 1, stdout: "", stderr: "ffmpeg quebrou" }; } };
  await expect(ensurePlayback(source, dir, failing)).rejects.toThrow(/proxy falhou.*\ba\b/);
  await expect(access(proxyPath(dir, source.sha256))).rejects.toThrow();
});

it("proxy inválido não vira cache válido", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-media-"));
  const path = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), path);
  const source = await sourceFrom(path);
  const garbage: Executor = {
    async run(call: ExecCall) {
      const output = call.args[call.args.length - 1]!;
      await writeFile(output, "lixo");
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  await expect(ensurePlayback(source, dir, garbage)).rejects.toThrow();
  await expect(access(proxyPath(dir, source.sha256))).rejects.toThrow();
});

it("reusa proxy válido sem chamar o ffmpeg de novo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-media-"));
  const path = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), path);
  const source = await sourceFrom(path);
  const first = await ensurePlayback(source, dir, copyingExec());
  const counting = copyingExec();
  const second = await ensurePlayback(source, dir, counting);
  expect(counting.calls).toHaveLength(0);
  expect(second).toEqual(first);
});

it("áudio sem vídeo usa player próprio: sem miniatura e sem thumb", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-media-"));
  const path = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), path);
  const source = await sourceFrom(path, { hasVideo: false });
  const exec = copyingExec();
  const result = await ensurePlayback(source, dir, exec);
  expect(result.thumbnailPath).toBeNull();
  // Só o proxy foi pedido; nenhum comando de miniatura rodou.
  expect(exec.calls.filter((call) => call.args[call.args.length - 1]!.endsWith(".tmp.jpg"))).toHaveLength(0);
});

it("verifySourceIdentity aprova, nomeia ausente e detecta troca", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-media-"));
  const path = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), path);
  const source = await sourceFrom(path);
  await expect(verifySourceIdentity(source)).resolves.toBeUndefined();
  await expect(verifySourceIdentity({ ...source, path: join(dir, "sumiu.mp4") }))
    .rejects.toThrow(/mídia ausente.*\ba\b/);
  // Troca com tamanho diferente: sentinela barata pega.
  await copyFile(join(FIXTURES, "edited.wav"), path);
  await expect(verifySourceIdentity(source)).rejects.toThrow(/substituído.*\ba\b/);
  // Troca com o mesmo tamanho: o hash pega.
  const sameSize = await sourceFrom(path);
  await writeFile(path, Buffer.alloc((await stat(path)).size, 7));
  await expect(verifySourceIdentity({ ...sameSize, size: undefined, mtimeMs: undefined }))
    .rejects.toThrow(/substituído/);
});
