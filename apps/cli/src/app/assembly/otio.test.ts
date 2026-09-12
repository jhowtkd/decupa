import { expect, it } from "vitest";
import { fixtureAssembly } from "./fixture.ts";
import { buildOtio, davinciImportSettings, timelineDurationFrames } from "./otio.ts";
import { validateAssembly } from "./validate.ts";

it("estrutura contém três Track, Gap de 25 frames em V2 e A1 referencia A", () => {
  const doc = JSON.parse(buildOtio(fixtureAssembly()));
  expect(doc.OTIO_SCHEMA).toBe("Timeline.1");
  expect(doc.tracks.children).toHaveLength(3);
  expect(doc.tracks.children[1].children[0].OTIO_SCHEMA).toBe("Gap.1");
  expect(doc.tracks.children[1].children[0].source_range.duration.value).toBe(25);
  const audioClip = doc.tracks.children[2].children[0];
  expect(audioClip.media_reference.target_url).toContain("fala.mp4");
});

it("declara fps e canvas da montagem para o diálogo de importação", () => {
  const a = fixtureAssembly();
  const doc = JSON.parse(buildOtio(a));
  expect(doc.global_start_time).toEqual({ OTIO_SCHEMA: "RationalTime.1", value: 25 * 3600, rate: 25 });
  expect(doc.metadata.decupa).toMatchObject({ width: 320, height: 240, fps: { num: 25, den: 1 } });
  expect(doc.metadata.Resolve).toEqual({
    timelineFrameRate: "25",
    timelineResolutionWidth: "320",
    timelineResolutionHeight: "240",
  });
  expect(doc.tracks.source_range.duration).toEqual({
    OTIO_SCHEMA: "RationalTime.1", value: 50, rate: 25,
  });
  const videoRef = doc.tracks.children[0].children[0].media_reference;
  expect(videoRef.available_image_bounds.max).toEqual({ OTIO_SCHEMA: "V2d.1", x: 320, y: 240 });
  expect(timelineDurationFrames(a)).toBe(50);
  expect(davinciImportSettings(a).timelineResolutionWidth).toBe("320");
});

it("preserva espaço, acentos e # no nome do arquivo", () => {
  const a = fixtureAssembly();
  a.sources[0]!.path = "/tmp/decupa-fixture/fala da aula #1 áudio.mp4";
  const doc = JSON.parse(buildOtio(validateAssembly(a)));
  const url = doc.tracks.children[0].children[0].media_reference.target_url as string;
  expect(url).toContain("fala%20da%20aula%20%231%20");
  expect(decodeURIComponent(url)).toContain("fala da aula #1 áudio.mp4");
});

it("distingue dois arquivos com o mesmo basename", () => {
  const a = fixtureAssembly();
  a.sources[0]!.path = "/tmp/decupa-fixture/cam-a/take.mp4";
  a.sources[1]!.path = "/tmp/decupa-fixture/cam-b/take.mp4";
  const doc = JSON.parse(buildOtio(validateAssembly(a)));
  const urlA = doc.tracks.children[0].children[0].media_reference.target_url as string;
  const urlB = doc.tracks.children[1].children[1].media_reference.target_url as string;
  expect(urlA).toContain("cam-a");
  expect(urlB).toContain("cam-b");
  expect(urlA).not.toBe(urlB);
});

it("exporta início fracionário da fonte com mesma taxa e frames inteiros no start_time", () => {
  const a = fixtureAssembly();
  a.fps = { num: 30000, den: 1001 };
  const fps = 30000 / 1001;
  a.tracks[0]!.clips[0]!.sourceStartSeconds = 1.5;
  a.tracks[0]!.clips[0]!.durationFrames = 10;
  a.tracks[1]!.clips = [];
  a.tracks[2]!.clips[0]!.durationFrames = 10;
  const doc = JSON.parse(buildOtio(validateAssembly(a)));
  const clip = doc.tracks.children[0].children[0];
  const expectedStartFrame = Math.round(1.5 * fps);
  expect(clip.source_range.start_time.value).toBe(expectedStartFrame);
  expect(clip.source_range.start_time.rate).toBe(fps);
  expect(clip.source_range.start_time.rate).not.toBe(29.97);
  expect(clip.source_range.duration.value).toBe(10);
  expect(clip.source_range.duration.rate).toBe(fps);
  expect(clip.source_range.duration.rate).not.toBe(29.97);
  expect(doc.global_start_time.rate).toBe(fps);
  expect(doc.global_start_time.rate).not.toBe(29.97);
  expect(doc.global_start_time.value).toBe(fps * 3600);
});

it("available_range do media_reference usa a mesma rate do source_range do clipe", () => {
  const a = fixtureAssembly();
  a.fps = { num: 30000, den: 1001 };
  a.sources[0]!.fps = { num: 25, den: 1 };
  a.sources[0]!.durationSeconds = 3;
  a.tracks[1]!.clips = [];
  a.tracks[2]!.clips[0]!.durationFrames = 10;
  a.tracks[0]!.clips[0]!.durationFrames = 10;
  const doc = JSON.parse(buildOtio(validateAssembly(a)));
  const clip = doc.tracks.children[0].children[0];
  const fps = 30000 / 1001;
  expect(clip.source_range.start_time.rate).toBe(fps);
  expect(clip.media_reference.available_range.duration.rate).toBe(fps);
  expect(clip.media_reference.available_range.duration.rate)
    .toBe(clip.source_range.duration.rate);
  expect(clip.media_reference.available_range.duration.value).toBe(Math.round(3 * fps));
  expect(clip.media_reference.available_range.start_time.rate).toBe(fps);
});
