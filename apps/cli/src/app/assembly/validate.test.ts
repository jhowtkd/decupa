import { expect, it } from "vitest";
import { fixtureAssembly } from "./fixture.ts";
import { validateAssembly } from "./validate.ts";

it("recusa clipe que ultrapassa a fonte", () => {
  const a = fixtureAssembly();
  a.tracks[0]!.clips[0]!.sourceStartSeconds = 99;
  expect(() => validateAssembly(a)).toThrow(/fonte/);
});

it("aceita uma montagem com fala e apoio sobreposto em outra pista", () => {
  expect(validateAssembly(fixtureAssembly()).tracks).toHaveLength(3);
});

it("recusa NaN em tempos e frames", () => {
  const a = fixtureAssembly();
  a.tracks[0]!.clips[0]!.sourceStartSeconds = Number.NaN;
  expect(() => validateAssembly(a)).toThrow(/finito|NaN|número/i);
});

it("aceita fps 30000/1001 sem arredondar", () => {
  const a = fixtureAssembly();
  a.fps = { num: 30000, den: 1001 };
  a.tracks[0]!.clips[0]!.durationFrames = 1;
  a.tracks[0]!.clips[0]!.sourceStartSeconds = 0;
  // 1 frame a 30000/1001 dura 1001/30000 s, bem abaixo dos 3 s da fonte.
  a.tracks[1]!.clips[0]!.durationFrames = 1;
  a.tracks[1]!.clips[0]!.startFrame = 1;
  a.tracks[2]!.clips[0]!.durationFrames = 1;
  const validated = validateAssembly(a);
  expect(validated.fps).toEqual({ num: 30000, den: 1001 });
});

it("recusa fonte ausente", () => {
  const a = fixtureAssembly();
  a.tracks[0]!.clips[0]!.sourceId = "inexistente";
  expect(() => validateAssembly(a)).toThrow(/fonte/);
});

it("recusa sobreposição na mesma pista", () => {
  const a = fixtureAssembly();
  a.tracks[0]!.clips.push({
    id: "overlap",
    sceneId: "s1",
    sourceId: "a",
    sourceStartSeconds: 0,
    startFrame: 25,
    durationFrames: 10,
  });
  expect(() => validateAssembly(a)).toThrow(/sobreposição|sobreposto/i);
});
