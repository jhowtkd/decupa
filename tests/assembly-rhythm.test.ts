import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { startApp } from "../apps/cli/src/app/server.ts";
import { saveProject } from "../apps/cli/src/app/assembly/store.ts";
import type { ExecCall, Executor } from "../apps/cli/src/app/pipeline.ts";
import { FIXTURES } from "./fixtures/global-setup.ts";

let stop: (() => Promise<void>) | null = null;
afterEach(async () => { await stop?.(); stop = null; });

const INDEX = {
  units: [{
    id: "u001", index: 1, start: 0, end: 2, duration: 2,
    text: "w0 w1 w2", has_terminal_punct: true, is_question: false,
    word_count: 3, cps: 1, lead_gap: 0,
    disfluency: { hard: [], soft: [], stutter: [] },
  }],
};

// Pausa grande no meio da fala (0.3–1.4 = 1.1s), alinhada por palavra;
// a segunda pausa (1.6–1.95 = 0.35s+) só é cortada pelo perfil direto.
const TRANSCRIPT = {
  segments: [{
    words: [
      { text: "w0", start: 0, end: 0.3, confidence: 0.9 },
      { text: "w1", start: 1.4, end: 1.6, confidence: 0.9 },
      { text: "w2", start: 1.95, end: 2.0, confidence: 0.9 },
    ],
  }],
};

function executor(): Executor {
  return {
    async run(call: ExecCall) {
      const work = call.env?.CLAUDE_PROJECT_DIR ?? call.cwd ?? "";
      if (work && call.args.includes("index")) {
        const { mkdir, writeFile } = await import("node:fs/promises");
        await mkdir(join(work, "out"), { recursive: true });
        await writeFile(join(work, "out", "speech_index.json"), `${JSON.stringify(INDEX)}\n`);
        await writeFile(join(work, "transcript.json"), `${JSON.stringify(TRANSCRIPT)}\n`);
      }
      // Render da amostra/prévia: materializa o mp4 no diretório de trabalho.
      if (work) await copyFile(join(FIXTURES, "clip.mp4"), join(work, "reference.mp4"));
      return { code: 0, stdout: "ok", stderr: "" };
    },
  };
}

async function post(base: string, path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

type ProjectView = {
  revision: number;
  previewRevision: number | null;
  finalApprovedRevision: number | null;
  assembly: { sources: { id: string }[]; rhythmProfile?: string | null };
  scenes: {
    id: string;
    takes: {
      id: string; sourceId: string; speechId: string;
      removed: { start: number; end: number }[];
      rhythm?: { profile: string; removed: { start: number; end: number }[] };
    }[];
  }[];
  analyses: { sourceId: string; speech: { id: string; text: string }[] }[];
};

type RhythmProposal = {
  id: string;
  baseRevision: number;
  profileId: string;
  beforeSeconds: number;
  afterSeconds: number;
  takes: {
    takeId: string;
    pauses: { start: number; end: number; duration: number; keep: number; protectedPart: boolean }[];
    cuts: { start: number; end: number }[];
  }[];
  unaligned: { takeId: string; sourceId: string }[];
  sample: { sceneId: string; takeId: string; start: number; end: number } | null;
};

async function view(base: string): Promise<{
  project: ProjectView;
  rhythmProposal: RhythmProposal | null;
  rhythmProfiles: Record<string, { id: string; name: string }>;
  undoRevision: number | null;
}> {
  const res = await fetch(`${base}/project`);
  return res.json() as Promise<{
    project: ProjectView;
    rhythmProposal: RhythmProposal | null;
    rhythmProfiles: Record<string, { id: string; name: string }>;
    undoRevision: number | null;
  }>;
}

it("controle de ritmo: comparar perfis, amostra, aplicar e desfazer (#66)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-rhythm-"));
  const speech = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), speech);
  const app = await startApp({
    projectDir: dir, inputs: [speech], port: 0,
    executor: executor(),
    allowPaidModel: true,
  });
  stop = app.close;
  const base = `http://127.0.0.1:${app.port}`;

  // Semeia: brief + análise + montagem com a fala toda.
  const opened = (await view(base)).project;
  await post(base, "/project/input", {
    baseRevision: opened.revision,
    kind: "brief", text: "contar o tema", targetSeconds: 2,
  });
  const analyze = await post(base, "/project/analyze", {
    sourceIds: opened.assembly.sources.map((s) => s.id),
  });
  const analyzed = (await analyze.json() as { project: ProjectView }).project;
  const speechId = analyzed.analyses[0]!.speech[0]!.id;
  const sourceId = analyzed.assembly.sources[0]!.id;
  // Montagem sem a compactação automática do tightenSpeechTake: take cru
  // 0–2s, como uma montagem feita antes do alinhamento existir.
  await saveProject(dir, analyzed.revision, (current) => ({
    ...current,
    scenes: [{
      id: "s1", objective: "abrir", rationale: "tema", speechIds: [speechId],
      takes: [{
        id: "s1:t1", sourceId, speechId, start: 0, end: 2,
        removed: [], protected: [],
      }],
      visualEvidenceIds: [], support: [], gaps: [],
    }],
  }));
  const applied = (await view(base)).project;

  // Perfis documentados e proposta determinística (sem chamada paga).
  const list = await view(base);
  expect(Object.keys(list.rhythmProfiles)).toEqual(["natural", "direto"]);
  const proposed = await post(base, "/project/rhythm-proposal", {
    baseRevision: applied.revision, profileId: "direto",
  });
  expect(proposed.status).toBe(200);
  const withProposal = await view(base);
  const proposal = withProposal.rhythmProposal!;
  expect(proposal.profileId).toBe("direto");
  expect(proposal.unaligned).toEqual([]);
  expect(proposal.takes[0]!.pauses.length).toBeGreaterThan(0);
  expect(proposal.afterSeconds).toBeLessThan(proposal.beforeSeconds);
  // Propor não muda a montagem.
  expect(withProposal.project.revision).toBe(applied.revision);
  expect(withProposal.project.assembly.rhythmProfile).toBeUndefined();

  // Amostra auditável: mesmo trecho, antes e depois, servido como mídia.
  expect(proposal.sample).not.toBeNull();
  for (const which of ["antes", "depois"]) {
    const sample = await fetch(`${base}/project/rhythm-sample/${proposal.id}/${which}`);
    expect(sample.status).toBe(200);
    expect(sample.headers.get("content-type")).toContain("video/mp4");
    expect((await sample.arrayBuffer()).byteLength).toBeGreaterThan(0);
  }

  // Aceitar aplica a camada de ritmo e invalida prévia/aprovação.
  const accepted = await post(base, "/project/rhythm-accept", {
    baseRevision: applied.revision, proposalId: proposal.id,
  });
  expect(accepted.status).toBe(200);
  const after = await view(base);
  expect(after.rhythmProposal).toBeNull();
  expect(after.project.revision).toBe(applied.revision + 1);
  expect(after.project.assembly.rhythmProfile).toBe("direto");
  expect(after.project.previewRevision).toBeNull();
  expect(after.project.finalApprovedRevision).toBeNull();
  const take = after.project.scenes[0]!.takes[0]!;
  expect(take.rhythm!.profile).toBe("direto");
  expect(take.removed.length).toBeGreaterThan(0);

  // Desfazer restaura takes e montagem pelo mecanismo de revisão.
  expect(after.undoRevision).not.toBeNull();
  const undone = await post(base, "/project/undo", {
    baseRevision: after.project.revision, revision: after.undoRevision,
  });
  expect(undone.status).toBe(200);
  const restored = await view(base);
  const restoredTake = restored.project.scenes[0]!.takes[0]!;
  expect(restoredTake.rhythm).toBeUndefined();
  expect(restoredTake.removed).toEqual([]);
  expect(restored.project.assembly.rhythmProfile).toBeNull();

  // Rejeitar dispensa a proposta sem tocar a montagem.
  const reposted = await post(base, "/project/rhythm-proposal", {
    baseRevision: restored.project.revision, profileId: "natural",
  });
  expect(reposted.status).toBe(200);
  const again = (await view(base)).rhythmProposal!;
  const rejected = await post(base, "/project/rhythm-reject", { proposalId: again.id });
  expect(rejected.status).toBe(200);
  const final = await view(base);
  expect(final.rhythmProposal).toBeNull();
  expect(final.project.revision).toBe(restored.project.revision);
});
