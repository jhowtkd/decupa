import type { Assembly } from "./types.ts";

const HASH_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

export function fixtureAssembly(): Assembly {
  return {
    version: 1,
    revision: 1,
    name: "fixture",
    fps: { num: 25, den: 1 },
    width: 320,
    height: 240,
    sources: [
      {
        id: "a",
        path: "/tmp/decupa-fixture/fala.mp4",
        sha256: HASH_A,
        durationSeconds: 3,
        hasVideo: true,
        hasAudio: true,
        fps: { num: 25, den: 1 },
        width: 320,
        height: 240,
        role: "speech",
        included: true,
        name: "fala.mp4",
      },
      {
        id: "b",
        path: "/tmp/decupa-fixture/apoio.mp4",
        sha256: HASH_B,
        durationSeconds: 3,
        hasVideo: true,
        hasAudio: false,
        fps: { num: 25, den: 1 },
        width: 320,
        height: 240,
        role: "support",
        included: true,
        name: "apoio.mp4",
      },
    ],
    tracks: [
      {
        kind: "Video",
        name: "V1",
        clips: [
          {
            id: "v1-a",
            sceneId: "s1",
            sourceId: "a",
            sourceStartSeconds: 0,
            startFrame: 0,
            durationFrames: 50,
          },
        ],
      },
      {
        kind: "Video",
        name: "V2",
        clips: [
          {
            id: "v2-b",
            sceneId: "s1",
            sourceId: "b",
            sourceStartSeconds: 0,
            startFrame: 25,
            durationFrames: 25,
          },
        ],
      },
      {
        kind: "Audio",
        name: "A1",
        clips: [
          {
            id: "a1-a",
            sceneId: "s1",
            sourceId: "a",
            sourceStartSeconds: 0,
            startFrame: 0,
            durationFrames: 50,
          },
        ],
      },
    ],
  };
}
