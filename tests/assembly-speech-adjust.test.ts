import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { startApp } from "../apps/cli/src/app/server.ts";
import type { ExecCall, Executor } from "../apps/cli/src/app/pipeline.ts";
import { FIXTURES } from "./fixtures/global-setup.ts";

let stop: (() => Promise<void>) | null = null;
afterEach(async () => { await stop?.(); stop = null; });

const INDEX = {
  units: [{
    id: "u001", index: 1, start: 0, end: 2, duration: 2,
    text: "oi é tipo tema valeu", has_terminal_punct: true, is_question: false,
    word_count: 5, cps: 2, lead_gap: 0,
    disfluency: { hard: [], soft: [], stutter: [] },
  }],
};

const TRANSCRIPT = {
  segments: [{
    words: ["oi", "é", "tipo", "tema", "valeu"].map((text, i) => ({
      text, start: i * 0.4, end: i * 0.4 + 0.3, confidence: 0.9,
    })),
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
  assembly: { sources: { id: string }[] };
  previewRevision: number | null;
  finalApprovedRevision: number | null;
  scenes: { id: string; takes: { id: string; sourceId: string; speechId: string; removed: { start: number; end: number }[] }[] }[];
  analyses: { sourceId: string; speech: { id: string; text: string }[]; words: { id: string }[] }[];
};

type SpeechProposal = {
  id: string;
  baseRevision: number;
  scope: { sourceId: string; speechId: string; sceneIds: string[] };
  cuts: { wordIds: string[]; reason?: string }[];
  skippedProtected: number;
  before: { durationSeconds: number; text: string };
  after: { durationSeconds: number; text: string };
};

async function view(base: string): Promise<{ project: ProjectView; speechProposal: SpeechProposal | null }> {
  const res = await fetch(`${base}/project`);
  return res.json() as Promise<{ project: ProjectView; speechProposal: SpeechProposal | null }>;
}

/** Semeia um projeto com uma cena/take de fala já montada. */
async function seed(base: string): Promise<ProjectView> {
  const opened = (await view(base)).project;
  await post(base, "/project/input", {
    baseRevision: opened.revision,
    kind: "brief", text: "contar o tema", targetSeconds: 2,
  });
  const analyze = await post(base, "/project/analyze", {
    sourceIds: opened.assembly?.sources?.map((s: { id: string }) => s.id) ?? [],
  });
  const analyzed = (await analyze.json() as { project: ProjectView }).project;
  const speechId = analyzed.analyses[0]!.speech[0]!.id;
  await post(base, "/project/propose", {
    baseRevision: analyzed.revision,
    proposal: {
      id: "prop-1", baseRevision: analyzed.revision,
      changedSceneIds: ["s1"], explanation: "abertura",
      scenes: [{ id: "s1", objective: "abrir", rationale: "tema", speechIds: [speechId], support: [], gaps: [] }],
    },
  });
  const applied = (await (await post(base, "/project/apply", {
    baseRevision: analyzed.revision, proposalId: "prop-1",
  })).json() as { project: ProjectView }).project;
  return applied;
}

it("ajuste localizado de fala: comparar, aceitar, desfazer (#64)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-speech-"));
  const speech = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), speech);
  // Provedor simulado: corta a terceira palavra listada no escopo.
  const app = await startApp({
    projectDir: dir, inputs: [speech], port: 0,
    executor: executor(),
    allowPaidModel: true,
    proposeSend: async (content) => {
      const text = (content as { text: string }[])[0]!.text;
      const ids = [...text.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]!);
      expect(ids.length).toBeGreaterThanOrEqual(5);
      return JSON.stringify({ cuts: [{ wordIds: [ids[2]], reason: "preenchimento" }] });
    },
  });
  stop = app.close;
  const base = `http://127.0.0.1:${app.port}`;

  const project = await seed(base);
  const take = project.scenes[0]!.takes[0]!;
  expect(take.speechId).toBeTruthy();

  // Pedido com escopo explícito → proposta com comparação antes/depois.
  const proposed = await post(base, "/project/speech-proposal", {
    baseRevision: project.revision,
    sourceId: take.sourceId, speechId: take.speechId,
    request: "tira a muleta",
  });
  expect(proposed.status).toBe(200);
  const withProposal = await view(base);
  const proposal = withProposal.speechProposal!;
  expect(proposal.scope.speechId).toBe(take.speechId);
  expect(proposal.cuts).toHaveLength(1);
  expect(proposal.after.text).not.toContain("tipo");
  expect(proposal.after.durationSeconds).toBeLessThan(proposal.before.durationSeconds);
  // Propor não muda a montagem.
  expect(withProposal.project.revision).toBe(project.revision);

  // Aceitar → revisão nova, aprovação/prévia invalidadas, corte no take.
  const accepted = await post(base, "/project/speech-accept", {
    baseRevision: project.revision, proposalId: proposal.id,
  });
  expect(accepted.status).toBe(200);
  const afterAccept = await view(base);
  expect(afterAccept.speechProposal).toBeNull();
  expect(afterAccept.project.revision).toBe(project.revision + 1);
  expect(afterAccept.project.finalApprovedRevision).toBeNull();
  expect(afterAccept.project.scenes[0]!.takes[0]!.removed.length).toBeGreaterThan(0);

  // Desfazer recupera o estado anterior à aplicação.
  const undone = await post(base, "/project/undo", {
    baseRevision: afterAccept.project.revision,
    revision: project.revision,
  });
  expect(undone.status).toBe(200);
  const restored = await view(base);
  expect(restored.project.scenes[0]!.takes[0]!.removed).toHaveLength(0);
});

it("corte fora do escopo é recusado e rejeitar preserva o projeto (#64)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-speech-out-"));
  const speech = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), speech);
  let calls = 0;
  const app = await startApp({
    projectDir: dir, inputs: [speech], port: 0,
    executor: executor(),
    allowPaidModel: true,
    proposeSend: async (content) => {
      calls += 1;
      if (calls === 1) return JSON.stringify({ cuts: [{ wordIds: ["outra-fonte:w0"] }] });
      const text = (content as { text: string }[])[0]!.text;
      const ids = [...text.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]!);
      return JSON.stringify({ cuts: [{ wordIds: [ids[0]] }] });
    },
  });
  stop = app.close;
  const base = `http://127.0.0.1:${app.port}`;

  const project = await seed(base);
  const take = project.scenes[0]!.takes[0]!;

  // O provedor insiste num corte fora do escopo: a rota recusa com 400.
  const refused = await post(base, "/project/speech-proposal", {
    baseRevision: project.revision,
    sourceId: take.sourceId, speechId: take.speechId,
    request: "corta outra fala",
  });
  expect(refused.status).toBe(400);
  expect(((await refused.json()) as { error: string }).error).toMatch(/fora do escopo/);
  expect((await view(base)).speechProposal).toBeNull();

  // Proposta válida seguida de rejeição: nada muda na montagem.
  const ok = await post(base, "/project/speech-proposal", {
    baseRevision: project.revision,
    sourceId: take.sourceId, speechId: take.speechId,
    request: "tira a primeira palavra",
  });
  expect(ok.status).toBe(200);
  const proposal = (await view(base)).speechProposal!;
  const rejected = await post(base, "/project/speech-reject", {
    baseRevision: project.revision, proposalId: proposal.id,
  });
  expect(rejected.status).toBe(200);
  const afterReject = await view(base);
  expect(afterReject.speechProposal).toBeNull();
  expect(afterReject.project.revision).toBe(project.revision);
  expect(afterReject.project.scenes[0]!.takes[0]!.removed).toHaveLength(0);

  // Aceitar id de proposta que não existe mais é recusado.
  const gone = await post(base, "/project/speech-accept", {
    baseRevision: project.revision, proposalId: proposal.id,
  });
  expect(gone.status).toBe(409);
});

it("proposta desatualizada é recusada ao aceitar (#64)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-speech-stale-"));
  const speech = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), speech);
  const app = await startApp({
    projectDir: dir, inputs: [speech], port: 0,
    executor: executor(),
    allowPaidModel: true,
    proposeSend: async (content) => {
      const text = (content as { text: string }[])[0]!.text;
      const ids = [...text.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]!);
      return JSON.stringify({ cuts: [{ wordIds: [ids[0]] }] });
    },
  });
  stop = app.close;
  const base = `http://127.0.0.1:${app.port}`;

  const project = await seed(base);
  const take = project.scenes[0]!.takes[0]!;
  const proposed = await post(base, "/project/speech-proposal", {
    baseRevision: project.revision,
    sourceId: take.sourceId, speechId: take.speechId,
    request: "tira o início",
  });
  expect(proposed.status).toBe(200);
  const proposal = (await view(base)).speechProposal!;

  // Outra edição chega primeiro: a proposta ficou desatualizada.
  const moved = await post(base, "/project/edit", {
    baseRevision: project.revision,
    action: { type: "protect", sceneId: "s1", takeId: take.id, wordIds: [project.analyses[0]!.words[4]!.id] },
  });
  // Se a ação falhar por payload, usamos input para avançar a revisão.
  if (!moved.ok) {
    await post(base, "/project/input", {
      baseRevision: project.revision,
      kind: "brief", text: "novo recorte", targetSeconds: 2,
    });
  }
  const current = (await view(base)).project;
  expect(current.revision).toBeGreaterThan(project.revision);

  const stale = await post(base, "/project/speech-accept", {
    baseRevision: project.revision, proposalId: proposal.id,
  });
  expect(stale.status).toBe(409);
});
