import { writeFile } from "node:fs/promises";
import type { Executor } from "../pipeline.ts";
import { fixtureAssembly } from "./fixture.ts";
import { compileScenes } from "./scenes.ts";
import type { Project } from "./types.ts";
import { fillerReport, fillerSignature, fillerSnapKey, type FillerSnaps } from "./fillers.ts";

export function fillerProject(text = "hã"): Project {
  const assembly = fixtureAssembly();
  const project: Project = {
    version: 2, id: "fillers", revision: 1, input: { kind: "brief", text: "tema", targetSeconds: 0 },
    assembly: { ...assembly, revision: 1, sources: [assembly.sources[0]!] },
    scenes: [{ id: "s1", objective: "abrir", rationale: "tema", speechIds: ["a:u1"],
      takes: [{ id: "t1", sourceId: "a", speechId: "a:u1", start: 0, end: 1.5, removed: [], protected: [] }],
      visualEvidenceIds: [], support: [], gaps: [] }],
    analyses: [{ sourceId: "a", key: "k", status: "ready", wordsStatus: "ready", visual: [],
      speech: [{ id: "a:u1", sourceId: "a", start: 0, end: 1.5, text: `eu ${text} acho` }],
      words: [{ id: "w1", sourceId: "a", start: 0.1, end: 0.5, text: "eu", confidence: 0.9 },
        { id: "w2", sourceId: "a", start: 0.6, end: 0.8, text, confidence: 0.9 },
        { id: "w3", sourceId: "a", start: 0.9, end: 1.3, text: "acho", confidence: 0.9 }],
      visualCoverage: { requested: [], returned: [], missing: [] } }],
    proposal: null, previewRevision: 1, finalApprovedRevision: 1, previewArtifact: null,
    preparation: null, permissions: { model: true, visual: true }, corrections: [],
  };
  return { ...project, assembly: compileScenes(project, project.scenes) };
}

export function fixedFillerSnaps(project: Project, start = 0.55, end = 0.85): FillerSnaps {
  const item = fillerReport(project).occurrences[0]!;
  const take = project.scenes[0]!.takes[0]!;
  return { [fillerSnapKey(item)]: { signature: fillerSignature(project, take), range: { start, end } } };
}

/** PCM sintético: prova a mecânica, sem alegar qualidade da emenda por escuta. */
export function fillerPcmExec(onCall?: () => void): Executor {
  return { run: async call => {
    onCall?.();
    const duration = Number(call.args[call.args.indexOf("-t") + 1]);
    await writeFile(call.args.at(-1)!, Buffer.alloc(Math.round(duration * 16000) * 2));
    return { code: 0, stdout: "", stderr: "" };
  } };
}
