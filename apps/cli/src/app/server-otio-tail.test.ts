import { describe, expect, it } from "vitest";
import { otioClipsForPlan } from "./server.ts";
import { validateAssembly } from "./assembly/validate.ts";
import type { Assembly } from "./assembly/types.ts";

function montagemCom(clips: Assembly["tracks"][number]["clips"]): Assembly {
  return {
    version: 1,
    revision: 1,
    name: "corte",
    fps: { num: 30, den: 1 },
    width: 320,
    height: 240,
    sources: [{
      id: "src1",
      path: "/tmp/v.mp4",
      sha256: "a".repeat(64),
      durationSeconds: 10,
      hasVideo: true,
      hasAudio: true,
      fps: { num: 30, den: 1 },
      width: 320,
      height: 240,
      role: "speech",
      included: true,
      name: "v.mp4",
    }],
    tracks: [
      { kind: "Video", name: "V1", clips },
      { kind: "Video", name: "V2", clips: [] },
      { kind: "Audio", name: "A1", clips: [] },
    ],
  };
}

describe("otioClipsForPlan (cauda sub-frame no EOF)", () => {
  it("cauda de 1ms no EOF não gera clipe inválido", () => {
    const clips = otioClipsForPlan([{ start: 9.999, end: 10.0 }], 30, 10);
    expect(() => validateAssembly(montagemCom(clips))).not.toThrow();
  });

  it("clipe normal preservado", () => {
    const clips = otioClipsForPlan([{ start: 1, end: 2 }], 30, 10);
    expect(clips).toHaveLength(1);
    expect(clips[0]!.durationFrames).toBe(30);
  });

  it("clipe além da duração continua recusado", () => {
    expect(() => otioClipsForPlan([{ start: 9.9, end: 10.5 }], 30, 10))
      .toThrow(/ultrapassa a fonte/);
  });
});
