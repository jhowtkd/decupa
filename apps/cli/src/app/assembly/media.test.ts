import { access, copyFile, mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { hashFile, probe } from "@decupa/media";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import { SpawnExecutor, type ExecCall, type Executor } from "../pipeline.ts";
import { fixtureAssembly } from "./fixture.ts";
import { ensurePlayback, ensureThumbnail, proxyPath, thumbnailPath, verifySourceIdentity } from "./media.ts";
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

it("proxy usa limites de threads e encoder do perfil sem redetectar", async () => {
  for (const profile of ["software", "videotoolbox"] as const) {
    const dir = await mkdtemp(join(tmpdir(), "assembly-media-args-"));
    const path = join(dir, "fala.mp4");
    await copyFile(join(FIXTURES, "clip.mp4"), path);
    const source = await sourceFrom(path);
    const exec = copyingExec();
    await ensurePlayback(source, dir, exec, { profile });
    const proxyCall = exec.calls.find((call) => call.args.at(-1)?.endsWith(".tmp.mp4"));
    expect(proxyCall).toBeDefined();
    expect(proxyCall!.args).toContain("-threads");
    expect(proxyCall!.args).toContain("-filter_threads");
    if (profile === "videotoolbox") {
      expect(proxyCall!.args.indexOf("-hwaccel")).toBeLessThan(proxyCall!.args.indexOf("-i"));
      expect(proxyCall!.args).toContain("h264_videotoolbox");
    } else {
      expect(proxyCall!.args).toContain("libx264");
    }
  }
});

it("proxy corrompido é regenerado", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-media-"));
  const path = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), path);
  const source = await sourceFrom(path);
  const first = await ensurePlayback(source, dir, copyingExec());
  await writeFile(first.videoPath, "lixo");
  const exec = copyingExec();
  const second = await ensurePlayback(source, dir, exec);
  expect(exec.calls.filter((call) => call.args.at(-1)?.endsWith(".tmp.mp4"))).toHaveLength(1);
  expect(second.videoPath).toBe(first.videoPath);
  expect((await probe(second.videoPath)).hasVideo).toBe(true);
});

it("sinal abortado rejeita antes de lançar ffmpeg", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-media-"));
  const path = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), path);
  const source = await sourceFrom(path);
  const exec = copyingExec();
  const controller = new AbortController();
  controller.abort();
  await expect(ensurePlayback(source, dir, exec, { signal: controller.signal })).rejects.toThrow(/abort/i);
  await expect(ensureThumbnail(source, dir, exec, { signal: controller.signal })).rejects.toThrow(/abort/i);
  expect(exec.calls).toHaveLength(0);
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


it("miniaturas concorrentes extraem um único frame sem gerar proxy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-thumb-"));
  const source = await sourceFrom(join(FIXTURES, "clip.mp4"));
  const exec = copyingExec();
  const results = await Promise.all(Array.from({ length: 6 }, () => ensureThumbnail(source, dir, exec)));
  expect(new Set(results).size).toBe(1);
  expect(exec.calls).toHaveLength(1);
  expect(exec.calls[0]!.args).toContain(source.path);
  expect(exec.calls[0]!.args).toContain("-vframes");
  await expect(access(proxyPath(dir, source.sha256))).rejects.toThrow();
});

it("pedidos simultâneos de reprodução compartilham o mesmo proxy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-playback-"));
  const source = await sourceFrom(join(FIXTURES, "clip.mp4"));
  const exec = copyingExec();
  await Promise.all(Array.from({ length: 4 }, () => ensurePlayback(source, dir, exec)));
  expect(exec.calls.filter((call) => call.args.at(-1)?.endsWith(".tmp.mp4"))).toHaveLength(1);
});

it("com detectHardware, o proxy usa o perfil comprovado do projeto sem refazer a prova", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-media-hw-"));
  const path = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), path);
  const source = await sourceFrom(path);
  await mkdir(join(dir, "hardware-proof"), { recursive: true });
  await writeFile(join(dir, "hardware-proof", "profile.json"), `${JSON.stringify({ profile: "videotoolbox", version: 2 })}\n`);
  const exec = copyingExec();
  await ensurePlayback(source, dir, exec, { detectHardware: true });
  const proxyCalls = exec.calls.filter((call) => call.args.at(-1)?.endsWith(".tmp.mp4"));
  expect(proxyCalls).toHaveLength(1);
  expect(proxyCalls[0]!.args).toContain("h264_videotoolbox");
  expect(proxyCalls[0]!.args.indexOf("-hwaccel")).toBeLessThan(proxyCalls[0]!.args.indexOf("-i"));
  expect(proxyCalls[0]!.args).toContain("-threads");
  // Nenhuma prova de hardware nova: o perfil veio do cache do projeto.
  expect(exec.calls.some((call) => call.args.some((arg) => arg.includes("hardware-proof")))).toBe(false);
});

it("encode de hardware que falha cai para software e publica proxy válido", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-media-hwfail-"));
  const path = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), path);
  const source = await sourceFrom(path);
  const calls: ExecCall[] = [];
  const exec: Executor = {
    async run(call) {
      calls.push(call);
      const output = call.args.at(-1)!;
      if (call.args.includes("h264_videotoolbox")) return { code: 1, stdout: "", stderr: "vt indisponível" };
      if (output.endsWith(".tmp.mp4")) await copyFile(join(FIXTURES, "clip.mp4"), output);
      else if (output.endsWith(".tmp.jpg")) await writeFile(output, "miniatura");
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const result = await ensurePlayback(source, dir, exec, { profile: "videotoolbox" });
  expect(result.videoPath).toBe(proxyPath(dir, source.sha256));
  const proxyCalls = calls.filter((call) => call.args.at(-1)?.endsWith(".tmp.mp4"));
  expect(proxyCalls.map((call) => call.args.includes("libx264"))).toEqual([false, true]);
  const info = await probe(result.videoPath);
  expect(info.hasVideo).toBe(true);
});

it("cancelar durante o encode de hardware não dispara o fallback de software", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-media-hwcancel-"));
  const path = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), path);
  const source = await sourceFrom(path);
  const ac = new AbortController();
  const calls: ExecCall[] = [];
  const exec: Executor = {
    async run(call) {
      calls.push(call);
      ac.abort();
      return { code: 1, stdout: "", stderr: "interrompido" };
    },
  };
  await expect(ensurePlayback(source, dir, exec, { profile: "videotoolbox", signal: ac.signal })).rejects.toThrow();
  expect(calls.filter((call) => call.args.includes("libx264"))).toHaveLength(0);
  await expect(access(proxyPath(dir, source.sha256))).rejects.toThrow();
});

it("detectHardware sem perfil em cache faz a prova fora da fila e não trava", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-media-prove-"));
  const path = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), path);
  const source = await sourceFrom(path);
  const exec = copyingExec();
  const inner = exec.run.bind(exec);
  exec.run = async (call) => (call.args.includes("-encoders")
    ? { code: 0, stdout: " V..... libx264            libx264 H.264\n", stderr: "" }
    : inner(call));
  const result = await ensurePlayback(source, dir, exec, { detectHardware: true });
  expect(result.videoPath).toBe(proxyPath(dir, source.sha256));
  await access(join(dir, "hardware-proof", "profile.json"));
}, 20000);
