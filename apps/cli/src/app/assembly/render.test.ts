import { copyFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FakeExecutor, type Executor } from "../pipeline.ts";
import { hashFile } from "@decupa/media";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import { fixtureAssembly } from "./fixture.ts";
import { renderAssembly, toEngineTimeline } from "./render.ts";

it("preserva as três pistas e não duplica áudio", () => {
  const result = toEngineTimeline(fixtureAssembly()) as {
    project: { assets: unknown[]; name: string };
    assets: { id: string; path: string }[];
    tracks: any[];
  };
  expect(result.project.name).toBe("fixture");
  expect(result.project.assets).toHaveLength(2);
  expect(result.assets).toHaveLength(2);
  expect(result.tracks.map(t => t.type)).toEqual(["video", "video", "audio"]);
  expect(result.tracks[0].clips[0].volume).toBe(0);
  expect(result.tracks[0].clips[0].muted).toBe(true);
  expect(result.tracks[1].clips[0].muted).toBe(true);
  expect(result.tracks[0].clips[0].reason).toBe("speech");
  expect(result.tracks[1].clips[0].reason).toBe("support");
  expect(result.tracks[2].clips[0].volume).toBe(1);
  expect(result.tracks[2].clips[0].muted).toBe(false);
  expect(result.tracks[2].clips[0].reason).toBe("speech");
  expect(result.tracks[1].clips[0].timeline_start).toBe(1);
  expect(result.tracks.every((t) => t.clips.every((c: { reason: string }) => c.reason))).toBe(true);
});

it("recusa path relativo no contrato do motor", () => {
  const a = fixtureAssembly();
  a.sources[0]!.path = "fala.mp4";
  expect(() => toEngineTimeline(a)).toThrow(/absoluto/);
});

async function assemblyWithMedia(dir: string) {
  const media = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), media);
  const assembly = fixtureAssembly();
  for (const source of assembly.sources) {
    source.path = media;
    source.sha256 = await hashFile(media);
  }
  return assembly;
}

it("não trata falha do Executor como sucesso", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-render-"));
  const exec = new FakeExecutor({ code: 1, stderr: "[ERROR] motor ausente" });
  await expect(renderAssembly(await assemblyWithMedia(dir), dir, exec)).rejects.toThrow(/render|falhou|código 1/i);
});

it("não declara sucesso se o mp4 não existe", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-render-"));
  const exec = new FakeExecutor({ code: 0, stdout: "ok" });
  await expect(renderAssembly(await assemblyWithMedia(dir), dir, exec)).rejects.toThrow(/saída|mp4|não/i);
});

it("devolve o mp4 quando o Executor conclui e o arquivo existe", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-render-"));
  const media = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), media);
  const assembly = fixtureAssembly();
  for (const source of assembly.sources) {
    source.path = media;
    source.sha256 = await hashFile(media);
  }
  const exec: Executor = {
    async run(call) {
      const work = call.env?.CLAUDE_PROJECT_DIR ?? call.cwd ?? "";
      await copyFile(join(FIXTURES, "clip.mp4"), join(work, "reference.mp4"));
      return { code: 0, stdout: "ok", stderr: "" };
    },
  };
  await expect(renderAssembly(assembly, dir, exec)).resolves.toBe(
    join(dir, "rev-1", "reference.mp4"),
  );
});

it("recusa fonte substituída antes de renderizar", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-render-"));
  const media = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), media);
  const assembly = fixtureAssembly();
  assembly.sources[0]!.path = media;
  assembly.sources[0]!.sha256 = "0".repeat(64);
  const exec: Executor = {
    async run() {
      return { code: 0, stdout: "ok", stderr: "" };
    },
  };
  await expect(renderAssembly(assembly, dir, exec)).rejects.toThrow(/substituída/);
});

it("mapeia startFrame 25 no mesmo fps float do canvas em 25 e 30000/1001", () => {
  for (const fps of [{ num: 25, den: 1 }, { num: 30000, den: 1001 }]) {
    const assembly = fixtureAssembly();
    assembly.fps = fps;
    const result = toEngineTimeline(assembly) as {
      output_canvas: { fps: number };
      tracks: { clips: { timeline_start: number; startFrame?: number }[] }[];
    };
    const canvasFps = result.output_canvas.fps;
    expect(canvasFps).toBe(fps.num / fps.den);
    const start = result.tracks[1]!.clips[0]!.timeline_start;
    expect(start).toBe(25 / canvasFps);
    expect(Math.round(start * canvasFps)).toBe(25);
  }
});
