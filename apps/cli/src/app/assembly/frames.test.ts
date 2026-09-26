import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import type { ExecCall, Executor } from "../pipeline.ts";
import { fixtureAssembly } from "./fixture.ts";
import { extractVisualFrames } from "./frames.ts";
import type { Source } from "./types.ts";

/** Fonte com id "a", duração que cobre a janela e vídeo real em tmp. */
async function sourceInTemp(): Promise<Source> {
  const dir = await mkdtemp(join(tmpdir(), "assembly-frames-"));
  const path = join(dir, "fala.mp4");
  await writeFile(path, "vídeo de teste");
  return {
    ...fixtureAssembly().sources[0]!,
    id: "a",
    path,
    durationSeconds: 30,
    hasVideo: true,
  };
}

it("extrai JPEGs a 1 FPS e etiqueta cada frame pelo segundo da fonte", async () => {
  const source = await sourceInTemp();
  const seen: ExecCall[] = [];
  const exec: Executor = {
    async run(call) {
      seen.push(call);
      const pattern = call.args.at(-1)!;
      await mkdir(dirname(pattern), { recursive: true });
      await writeFile(pattern.replace("%03d", "001"), "jpeg-a");
      await writeFile(pattern.replace("%03d", "002"), "jpeg-b");
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const frames = await extractVisualFrames(source, { start: 20, end: 22, fetchStart: 19 }, exec);

  expect(frames.map((frame) => frame.sourceSecond)).toEqual([19, 20]);
  expect(frames[0]?.dataUrl).toBe(
    "data:image/jpeg;base64," + Buffer.from("jpeg-a").toString("base64"),
  );
  expect(seen[0]?.args).toEqual(expect.arrayContaining(["-ss", "19", "-t", "3"]));
  expect(seen[0]!.args.indexOf("-ss")).toBeLessThan(seen[0]!.args.indexOf("-i"));
  expect(seen[0]!.args).toContain("-accurate_seek");
  expect(seen[0]?.args.find((arg) => arg.includes("fps=1"))).toContain("fps=1");
  // Teto de threads de decodificação por janela, aplicado na entrada.
  const args = seen[0]!.args;
  expect(args[args.indexOf("-threads") + 1]).toBe("2");
  expect(args.indexOf("-threads")).toBeLessThan(args.indexOf("-i"));
  expect(args[args.indexOf("-filter_threads") + 1]).toBe("1");
  // Diretório efêmero sob o tmpdir do sistema, com prefixo próprio.
  const pattern = seen[0]?.args.at(-1);
  expect(typeof pattern === "string" && dirname(pattern)).toMatch(/decupa-frames-/);
});

it("não transforma falha do FFmpeg em análise vazia", async () => {
  const source = await sourceInTemp();
  const window = { start: 0, end: 2, fetchStart: 0 };
  const exec: Executor = {
    async run() { return { code: 1, stdout: "", stderr: "ffmpeg quebrou" }; },
  };
  await expect(extractVisualFrames(source, window, exec))
    .rejects.toThrow(/extração de frames/);
});

it("propaga o sinal de cancelamento ao executor do FFmpeg", async () => {
  const source = await sourceInTemp();
  const seen: ExecCall[] = [];
  const exec: Executor = {
    async run(call) {
      seen.push(call);
      const pattern = call.args.at(-1)!;
      await mkdir(dirname(pattern), { recursive: true });
      await writeFile(pattern.replace("%03d", "001"), "jpeg-a");
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const ac = new AbortController();
  await extractVisualFrames(source, { start: 0, end: 1, fetchStart: 0 }, exec, { signal: ac.signal });
  expect(seen[0]?.signal).toBe(ac.signal);
});
