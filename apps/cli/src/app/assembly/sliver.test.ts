import { expect, it } from "vitest";
import { compileScenes } from "./scenes.ts";
import { buildSpeechProposal, applySpeechProposal } from "./speech-proposal.ts";
import { blankProject } from "./routes.ts";
import type { Assembly, Project, SpeechTake } from "./types.ts";
import { validateProject } from "./store.ts";
import { applyTextEdit } from "./words.ts";

/**
 * Caso da auditoria: então[0,0.9] é[1,1.3] tipo[1.36,1.6] assim[1.7,2]
 * começamos[2.1,2.8], 30 fps, take [0, 2.8].
 */
function sliverProject(): Project {
  const fps = { num: 30, den: 1 };
  const project = blankProject("p");
  project.revision = 1;
  project.assembly.revision = 1;
  project.assembly.fps = fps;
  project.assembly.sources = [{
    id: "s1",
    path: "/tmp/x.mp4",
    sha256: "a".repeat(64),
    durationSeconds: 10,
    hasVideo: true,
    hasAudio: true,
    fps,
    width: 320,
    height: 240,
    role: "speech",
    included: true,
    name: "x.mp4",
  }];
  project.analyses = [{
    sourceId: "s1",
    key: "k",
    speech: [{ id: "s1:u1", sourceId: "s1", start: 0, end: 2.8, text: "então é tipo assim começamos" }],
    visual: [],
    status: "ready",
    words: [
      { id: "s1:w0", sourceId: "s1", text: "então", confidence: 0.9, start: 0, end: 0.9 },
      { id: "s1:w1", sourceId: "s1", text: "é", confidence: 0.9, start: 1, end: 1.3 },
      { id: "s1:w2", sourceId: "s1", text: "tipo", confidence: 0.9, start: 1.36, end: 1.6 },
      { id: "s1:w3", sourceId: "s1", text: "assim", confidence: 0.9, start: 1.7, end: 2 },
      { id: "s1:w4", sourceId: "s1", text: "começamos", confidence: 0.9, start: 2.1, end: 2.8 },
    ],
    wordsStatus: "ready",
    visualCoverage: { requested: [], returned: [], missing: [] },
  }];
  project.scenes = [{
    id: "c1",
    objective: "",
    rationale: "",
    speechIds: ["s1:u1"],
    visualEvidenceIds: [],
    support: [],
    gaps: [],
    takes: [{
      id: "t1", sourceId: "s1", speechId: "s1:u1", start: 0, end: 2.8, removed: [], protected: [],
    }],
  }];
  return project;
}

const scope = { sourceId: "s1", speechId: "s1:u1" };

function v1(assembly: Assembly): [number, number][] {
  return assembly.tracks[0]!.clips.map((clip) => [clip.sourceStartSeconds, clip.durationFrames]);
}

function compiled(project: Project): [number, number][] {
  return v1(compileScenes(project, project.scenes));
}

it("cortar é tipo assim vira um corte e a timeline não tem fatia", () => {
  const project = sliverProject();
  const proposal = buildSpeechProposal(project, scope, "tirar muleta", [
    { wordIds: ["s1:w1", "s1:w2", "s1:w3"] },
  ]);
  expect(proposal.cuts.map((cut) => [cut.start, cut.end])).toEqual([[1, 2]]);
  const applied = applySpeechProposal(project, proposal);
  const clips = v1(applied.assembly);
  expect(clips).toEqual([[0, 30], [2, 24]]);
  expect(clips.every(([, frames]) => frames >= 4)).toBe(true);
  const frames = applied.assembly.tracks[0]!.clips.reduce((total, clip) => total + clip.durationFrames, 0);
  const fps = applied.assembly.fps.num / applied.assembly.fps.den;
  expect(frames / fps).toBeCloseTo(proposal.after.durationSeconds, 6);
});

it("remover é e depois tipo equivale a remover as duas numa ação", () => {
  const project = sliverProject();
  const once = applyTextEdit(project, {
    type: "remove", sceneId: "c1", takeId: "t1", wordIds: ["s1:w1", "s1:w2"],
  });
  const twice = applyTextEdit(
    applyTextEdit(project, { type: "remove", sceneId: "c1", takeId: "t1", wordIds: ["s1:w1"] }),
    { type: "remove", sceneId: "c1", takeId: "t1", wordIds: ["s1:w2"] },
  );
  expect(compiled(twice)).toEqual(compiled(once));
  expect(compiled(twice).every(([, frames]) => frames >= 4)).toBe(true);
});

it("modelo devolvendo uma palavra por corte também não deixa fatia", () => {
  const project = sliverProject();
  const proposal = buildSpeechProposal(project, scope, "tirar muleta", [
    { wordIds: ["s1:w1"] },
    { wordIds: ["s1:w2"] },
    { wordIds: ["s1:w3"] },
  ]);
  const applied = applySpeechProposal(project, proposal);
  const clips = v1(applied.assembly);
  expect(clips).toEqual([[0, 30], [2, 24]]);
  expect(clips.every(([, frames]) => frames >= 4)).toBe(true);
  const frames = applied.assembly.tracks[0]!.clips.reduce((total, clip) => total + clip.durationFrames, 0);
  expect(frames / 30).toBeCloseTo(proposal.after.durationSeconds, 6);
});

it("não funde vão que ainda contém palavra mantida", () => {
  const project = sliverProject();
  const edited = applyTextEdit(project, {
    type: "remove", sceneId: "c1", takeId: "t1", wordIds: ["s1:w1", "s1:w3"],
  });
  const clips = compileScenes(edited, edited.scenes).tracks[0]!.clips;
  const coversTipo = clips.some((clip) => {
    const start = clip.sourceStartSeconds;
    const end = start + clip.durationFrames / 30;
    return start < 1.6 && end > 1.36;
  });
  expect(coversTipo).toBe(true);
});

it("não funde vão protegido entre dois cortes", () => {
  const project = sliverProject();
  project.scenes[0]!.takes[0]!.protected = [{ start: 1.3, end: 1.36 }];
  const edited = applyTextEdit(
    applyTextEdit(project, { type: "remove", sceneId: "c1", takeId: "t1", wordIds: ["s1:w1"] }),
    { type: "remove", sceneId: "c1", takeId: "t1", wordIds: ["s1:w2"] },
  );
  const clips = compileScenes(edited, edited.scenes).tracks[0]!.clips;
  const sliver = clips.find((clip) => Math.abs(clip.sourceStartSeconds - 1.3) < 0.02);
  expect(sliver).toBeDefined();
  expect(sliver!.durationFrames).toBeLessThan(4);
});

it("compileScenes descarta sobra de menos de um quadro e preserva take curto", () => {
  const between = sliverProject();
  const take: SpeechTake = {
    id: "t1", sourceId: "s1", speechId: "s1:u1", start: 0, end: 2,
    // A sobra [1.31, 1.33] (0,6 quadro) fica no silêncio entre "é" e "tipo".
    removed: [{ start: 1.3, end: 1.31 }, { start: 1.33, end: 1.36 }],
    protected: [],
  };
  between.scenes[0]!.takes = [take];
  expect(compileScenes(between, between.scenes).tracks[0]!.clips).toHaveLength(2);

  const whole = sliverProject();
  whole.scenes[0]!.takes = [{
    id: "t1", sourceId: "s1", speechId: "s1:u1", start: 5, end: 5.01, removed: [], protected: [],
  }];
  expect(compileScenes(whole, whole.scenes).tracks[0]!.clips.map((clip) => clip.durationFrames)).toEqual([1]);
});

type W = [string, number, number];

/** Fala longa de 12 s a 30 fps com as palavras dadas e um take [0, takeEnd]. */
function wordsProject(words: W[], takeEnd: number): Project {
  const project = sliverProject();
  project.assembly.sources[0]!.durationSeconds = Math.max(takeEnd, project.assembly.sources[0]!.durationSeconds);
  const analysis = project.analyses[0]!;
  analysis.speech = [{ id: "s1:u1", sourceId: "s1", start: 0, end: takeEnd, text: "x" }];
  analysis.words = words.map(([id, start, end]) => ({
    id: `s1:${id}`, sourceId: "s1", text: id, confidence: 0.9, start, end,
  }));
  project.scenes[0]!.takes = [{
    id: "t1", sourceId: "s1", speechId: "s1:u1", start: 0, end: takeEnd, removed: [], protected: [],
  }];
  return project;
}

function subframeProject(words: W[], protectedRanges: { start: number; end: number }[]): Project {
  const project = wordsProject(words, 3);
  const take = project.scenes[0]!.takes[0]!;
  take.removed = [{ start: 1, end: 2 }, { start: 2.02, end: 2.5 }];
  take.protected = protectedRanges;
  return project;
}

const kept: W = ["k0", 0, 0.9];
const tail: W = ["k3", 2.5, 3];

it("fragmento subquadro com palavra e trecho protegido não some (V1 e A1)", () => {
  const project = subframeProject([kept, ["w", 2, 2.02], tail], [{ start: 2, end: 2.02 }]);
  expect(() => validateProject(JSON.parse(JSON.stringify(project)))).not.toThrow();
  const assembly = compileScenes(project, project.scenes);
  const tracks = assembly.tracks.filter((track) => track.clips.length > 0);
  expect(tracks.length).toBeGreaterThanOrEqual(2);
  for (const track of tracks) {
    const clip = track.clips.find((item) => Math.abs(item.sourceStartSeconds - 2) < 0.02);
    expect(clip, `trilha ${track.name} sem clipe em ~2 s`).toBeDefined();
    expect(clip!.durationFrames).toBeGreaterThanOrEqual(1);
  }
});

it("fragmento subquadro só com palavra mantém 1 quadro", () => {
  const project = subframeProject([kept, ["w", 2, 2.02], tail], []);
  const clips = compileScenes(project, project.scenes).tracks[0]!.clips;
  const clip = clips.find((item) => Math.abs(item.sourceStartSeconds - 2) < 0.02);
  expect(clip?.durationFrames).toBe(1);
});

it("fragmento subquadro só com proteção mantém 1 quadro", () => {
  const project = subframeProject([kept, tail], [{ start: 2, end: 2.02 }]);
  const clips = compileScenes(project, project.scenes).tracks[0]!.clips;
  const clip = clips.find((item) => Math.abs(item.sourceStartSeconds - 2) < 0.02);
  expect(clip?.durationFrames).toBe(1);
});

const longWords: W[] = [["w0", 0, 0.9], ["w1", 1, 2], ["w2", 9, 10], ["w3", 11, 12]];

function ranges(project: Project): [number, number][] {
  return project.scenes[0]!.takes[0]!.removed.map((range) => [range.start, range.end]);
}

it("remover duas palavras distantes em duas ações mantém o miolo de 7 s", () => {
  const project = wordsProject(longWords, 12);
  const edited = applyTextEdit(
    applyTextEdit(project, { type: "remove", sceneId: "c1", takeId: "t1", wordIds: ["s1:w1"] }),
    { type: "remove", sceneId: "c1", takeId: "t1", wordIds: ["s1:w2"] },
  );
  expect(ranges(edited)).toEqual([[1, 2], [9, 10]]);
  expect(compiled(edited)).toEqual([[0, 30], [2, 210], [10, 60]]);
});

it("proposta com um corte de palavras distantes não engole o miolo", () => {
  const project = wordsProject(longWords, 12);
  const proposal = buildSpeechProposal(project, scope, "tirar", [{ wordIds: ["s1:w1", "s1:w2"] }]);
  const applied = applySpeechProposal(project, proposal);
  expect(ranges(applied)).toEqual([[1, 2], [9, 10]]);
  expect(v1(applied.assembly)).toEqual([[0, 30], [2, 210], [10, 60]]);
  const frames = applied.assembly.tracks[0]!.clips.reduce((total, clip) => total + clip.durationFrames, 0);
  expect(frames / 30).toBeCloseTo(proposal.after.durationSeconds, 6);
});

const removeAB = (project: Project) => applyTextEdit(
  applyTextEdit(project, { type: "remove", sceneId: "c1", takeId: "t1", wordIds: ["s1:a"] }),
  { type: "remove", sceneId: "c1", takeId: "t1", wordIds: ["s1:b"] },
);

it("vão de 0,9 s (27 quadros) funde; vão de 1,2 s (36 quadros) não", () => {
  const short = removeAB(wordsProject([["a", 1, 2], ["b", 2.9, 3.7], ["z", 4, 5]], 6));
  expect(ranges(short)).toEqual([[1, 3.7]]);
  const long = removeAB(wordsProject([["a", 1, 2], ["b", 3.2, 3.7], ["z", 4, 5]], 6));
  expect(ranges(long)).toEqual([[1, 2], [3.2, 3.7]]);
});

it("a 24 fps o vão de 24 quadros (1,0 s) funde e o de 25 quadros não", () => {
  const at24 = (words: W[]) => {
    const project = wordsProject(words, 6);
    project.assembly.fps = { num: 24, den: 1 };
    project.assembly.sources[0]!.fps = { num: 24, den: 1 };
    return project;
  };
  const fused = removeAB(at24([["a", 1, 2], ["b", 3, 4], ["z", 4.5, 5]]));
  expect(ranges(fused)).toEqual([[1, 4]]);
  const bStart = 2 + 25 / 24;
  const apart = removeAB(at24([["a", 1, 2], ["b", bStart, 4], ["z", 4.5, 5]]));
  expect(ranges(apart)).toEqual([[1, 2], [bStart, 4]]);
});
