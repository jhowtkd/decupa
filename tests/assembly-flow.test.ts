import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { startApp } from "../apps/cli/src/app/server.ts";
import type { ExecCall, Executor } from "../apps/cli/src/app/pipeline.ts";
import { FIXTURES } from "./fixtures/global-setup.ts";

let stop: (() => Promise<void>) | null = null;
afterEach(async () => { await stop?.(); stop = null; });

const INDEX = {
  units: [{
    id: "u001", index: 1, start: 0, end: 2, duration: 2,
    text: "olá tema", has_terminal_punct: true, is_question: false,
    word_count: 2, cps: 1, lead_gap: 0,
    disfluency: { hard: [], soft: [], stutter: [] },
  }],
};

function indexingAndRender(): Executor {
  return {
    async run(call: ExecCall) {
      const work = call.env?.CLAUDE_PROJECT_DIR ?? call.cwd ?? "";
      if (work && call.args.includes("index")) {
        await mkdir(join(work, "out"), { recursive: true });
        await writeFile(join(work, "out", "speech_index.json"), `${JSON.stringify(INDEX)}\n`);
      }
      if (work) await copyFile(join(FIXTURES, "clip.mp4"), join(work, "reference.mp4"));
      return { code: 0, stdout: "ok", stderr: "" };
    },
  };
}

it("não usa chave live nos testes de modelo", () => {
  expect(Boolean(process.env.ZAI_API_KEY)).toBe(false);
  expect(Boolean(process.env.OPENAI_API_KEY)).toBe(false);
});

const TRANSCRIPT = {
  segments: [{ words: [
    { text: "olá", start: 0.1, end: 0.5 },
    { text: "tema", start: 0.6, end: 1.0 },
  ] }],
};

function indexingAndRenderWithWords(): Executor {
  const base = indexingAndRender();
  return {
    async run(call: ExecCall) {
      const work = call.env?.CLAUDE_PROJECT_DIR ?? call.cwd ?? "";
      if (work && call.args.includes("index")) {
        await writeFile(join(work, "transcript.json"), `${JSON.stringify(TRANSCRIPT)}\n`);
      }
      return base.run(call);
    },
  };
}

it("percorre briefing → proposta local → exportação offline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-flow-"));
  const speech = join(dir, "fala.mp4");
  const support = join(dir, "apoio.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), speech);
  await copyFile(join(FIXTURES, "clip.mp4"), support);
  const app = await startApp({
    projectDir: dir,
    inputs: [speech, support],
    port: 0,
    executor: indexingAndRender(),
  });
  stop = app.close;
  const base = `http://127.0.0.1:${app.port}`;

  const opened = await (await fetch(`${base}/project`)).json() as {
    project: { revision: number; assembly: { sources: { id: string }[] } };
  };
  expect(opened.project.assembly.sources).toHaveLength(2);

  const brief = await fetch(`${base}/project/input`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseRevision: opened.project.revision,
      kind: "brief", text: "contar o tema", targetSeconds: 2,
    }),
  });
  expect(brief.status).toBe(200);

  const analyze = await fetch(`${base}/project/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceIds: opened.project.assembly.sources.map((s) => s.id) }),
  });
  expect(analyze.status).toBe(200);
  const analyzed = await analyze.json() as {
    project: {
      revision: number;
      analyses: { sourceId: string; speech: { id: string }[] }[];
    };
  };
  const speechId = analyzed.project.analyses[0]?.speech[0]?.id;
  expect(speechId).toMatch(/u001/);

  const paid = await fetch(`${base}/project/propose`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseRevision: analyzed.project.revision, request: "abrir" }),
  });
  expect(paid.status).toBe(402);

  const propose = await fetch(`${base}/project/propose`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseRevision: analyzed.project.revision,
      proposal: {
        id: "prop-1",
        baseRevision: analyzed.project.revision,
        changedSceneIds: ["s1"],
        explanation: "abertura com o tema",
        scenes: [{
          id: "s1", objective: "abrir", rationale: "tema",
          speechIds: [speechId], support: [], gaps: [],
        }],
      },
    }),
  });
  expect(propose.status).toBe(200);

  const apply = await fetch(`${base}/project/apply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseRevision: analyzed.project.revision,
      proposalId: "prop-1",
    }),
  });
  expect(apply.status).toBe(200);
  const applied = await apply.json() as { project: { revision: number } };

  expect((await fetch(`${base}/project/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseRevision: applied.project.revision }),
  })).status).toBe(200);

  const previewed = await (await fetch(`${base}/project`)).json() as {
    project: { revision: number; previewRevision: number | null };
  };

  expect((await fetch(`${base}/project/approve-final`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseRevision: previewed.project.revision,
      watchedRevision: previewed.project.previewRevision,
    }),
  })).status).toBe(200);

  const exported = await fetch(`${base}/project/export`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseRevision: applied.project.revision }),
  });
  expect(exported.status).toBe(200);
  const otio = await fetch(`${base}/project/output/${applied.project.revision}/otio`);
  const mp4 = await fetch(`${base}/project/output/${applied.project.revision}/mp4`);
  expect(otio.status).toBe(200);
  expect(mp4.status).toBe(200);
  const otioText = await otio.text();
  expect(otioText).toContain("Timeline.1");
  const manifest = JSON.parse(
    await readFile(join(dir, "exports", String(applied.project.revision), "manifest.json"), "utf8"),
  ) as { revision: number };
  expect(manifest.revision).toBe(applied.project.revision);
});

it("preparar monta sozinho: prepare 202 até cenas e prévia atuais", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-prepare-"));
  const speech = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), speech);
  let speechId = "desconhecida";
  const executor: Executor = {
    async run(call: ExecCall) {
      const work = call.env?.CLAUDE_PROJECT_DIR ?? call.cwd ?? "";
      if (work && call.args.includes("index")) {
        await mkdir(join(work, "out"), { recursive: true });
        await writeFile(join(work, "out", "speech_index.json"), `${JSON.stringify(INDEX)}\n`);
      }
      if (call.command === "ffmpeg") {
        await writeFile(call.args[call.args.length - 1], "clip");
      }
      if (call.command === "python3" && call.args.includes("--out")) {
        await copyFile(join(FIXTURES, "clip.mp4"), call.args[call.args.indexOf("--out") + 1]);
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const app = await startApp({
    projectDir: dir,
    inputs: [speech],
    port: 0,
    executor,
    proposeSend: async () =>
      JSON.stringify({
        scenes: [{ id: "sc-1", objective: "Abertura", selections: [{ speechId }] }],
        changedSceneIds: ["sc-1"],
        explanation: "fluxo automático",
      }),
    describeClient: {
      async send(content: unknown[]) {
        const match = /janela local: 0s → ([\d.]+)s/.exec(JSON.stringify(content));
        const end = match ? Number(match[1]) : 1;
        return JSON.stringify({
          spans: [{ start: 0, end, text: "pessoa falando", confidence: "observed", tags: [] }],
        });
      },
    },
  });
  stop = app.close;
  const base = `http://127.0.0.1:${app.port}`;

  const opened = await (await fetch(`${base}/project`)).json() as {
    project: { revision: number; assembly: { sources: { id: string }[] } };
  };
  expect(opened.project.assembly.sources).toHaveLength(1);
  speechId = `${opened.project.assembly.sources[0]!.id}:u001`;

  const response = await fetch(`${base}/project/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseRevision: opened.project.revision,
      request: "montar tudo",
      modelOptIn: true,
      visualOptIn: true,
    }),
  });
  expect(response.status).toBe(202);
  await vi.waitFor(async () => {
    const body = await (await fetch(`${base}/project`)).json() as {
      project: {
        revision: number;
        scenes: unknown[];
        preparation: { status: string } | null;
        previewArtifact: { revision: number } | null;
        finalApprovedRevision: number | null;
      };
    };
    expect(body.project.preparation?.status).toBe("ready");
    expect(body.project.scenes).toHaveLength(1);
    expect(body.project.previewArtifact?.revision).toBe(body.project.revision);
    expect(body.project.finalApprovedRevision).toBeNull();
  }, { timeout: 15000, interval: 200 });
});

it("edit→preview→export: /edit recompila o assembly que preview e export usam", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-edit-"));
  const speech = join(dir, "fala.mp4");
  const support = join(dir, "apoio.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), speech);
  await copyFile(join(FIXTURES, "clip.mp4"), support);
  const app = await startApp({
    projectDir: dir,
    inputs: [speech, support],
    port: 0,
    executor: indexingAndRenderWithWords(),
  });
  stop = app.close;
  const base = `http://127.0.0.1:${app.port}`;

  const opened = await (await fetch(`${base}/project`)).json() as {
    project: { revision: number; assembly: { sources: { id: string }[] } };
  };
  const brief = await fetch(`${base}/project/input`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseRevision: opened.project.revision,
      kind: "brief", text: "contar o tema", targetSeconds: 2,
    }),
  });
  expect(brief.status).toBe(200);

  const analyze = await fetch(`${base}/project/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceIds: opened.project.assembly.sources.map((s) => s.id) }),
  });
  expect(analyze.status).toBe(200);
  const analyzed = await analyze.json() as {
    project: {
      revision: number;
      analyses: { sourceId: string; speech: { id: string }[] }[];
    };
  };
  const speechId = analyzed.project.analyses[0]?.speech[0]?.id;
  expect(speechId).toMatch(/u001/);

  const propose = await fetch(`${base}/project/propose`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseRevision: analyzed.project.revision,
      proposal: {
        id: "prop-1",
        baseRevision: analyzed.project.revision,
        changedSceneIds: ["s1"],
        explanation: "abertura com o tema",
        scenes: [{
          id: "s1", objective: "abrir", rationale: "tema",
          speechIds: [speechId], support: [], gaps: [],
        }],
      },
    }),
  });
  expect(propose.status).toBe(200);

  const apply = await fetch(`${base}/project/apply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseRevision: analyzed.project.revision,
      proposalId: "prop-1",
    }),
  });
  expect(apply.status).toBe(200);
  const applied = await apply.json() as { project: { revision: number } };

  type FlowProject = {
    revision: number;
    scenes: { id: string; takes: { id: string }[] }[];
    analyses: { words: { id: string }[] }[];
    assembly: { tracks: { kind: string; clips: { durationFrames: number }[] }[] };
    previewRevision: number | null;
  };
  const before = await (await fetch(`${base}/project`)).json() as { project: FlowProject };
  expect(before.project.revision).toBe(applied.project.revision);
  const w = before.project.analyses[0]?.words[0];
  expect(w?.id).toMatch(/:w000000/);
  const videoBefore = before.project.assembly.tracks
    .find((t) => t.kind === "Video")!.clips.reduce((n, c) => n + c.durationFrames, 0);

  const edited = await fetch(`${base}/project/edit`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseRevision: before.project.revision,
      action: { type: "remove", sceneId: "s1", takeId: before.project.scenes[0]!.takes[0]!.id, wordIds: [w!.id] },
    }),
  });
  expect(edited.status).toBe(200);
  const after = await edited.json() as { project: FlowProject };
  // o assembly da resposta já reflete o corte (não espera o preview):
  const videoAfter = after.project.assembly.tracks
    .find((t) => t.kind === "Video")!.clips.reduce((n, c) => n + c.durationFrames, 0);
  expect(videoAfter).toBeLessThan(videoBefore);
  // preview e export da revisão editada usam esse assembly:
  expect((await fetch(`${base}/project/preview`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseRevision: after.project.revision }) })).status).toBe(200);
  const previewed = await (await fetch(`${base}/project`)).json() as { project: FlowProject };
  expect((await fetch(`${base}/project/approve-final`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseRevision: previewed.project.revision,
      watchedRevision: previewed.project.previewRevision,
    }),
  })).status).toBe(200);
  expect((await fetch(`${base}/project/export`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseRevision: after.project.revision }) })).status).toBe(200);
});

it("edição concorrente à preparação faz rebase: ready sem perder a correção (Task 11)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-prep-rebase-"));
  const speech = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), speech);
  let speechId = "desconhecida";
  // Executor lento no áudio (promise controlada); o resto é rápido.
  let audioGate: Promise<void> | null = null;
  let releaseAudio!: () => void;
  const executor: Executor = {
    async run(call: ExecCall) {
      const work = call.env?.CLAUDE_PROJECT_DIR ?? call.cwd ?? "";
      if (audioGate && (call.args.includes("condense-prep") || call.args.includes("index"))) {
        await audioGate;
      }
      if (work && call.args.includes("index")) {
        await mkdir(join(work, "out"), { recursive: true });
        await writeFile(join(work, "out", "speech_index.json"), `${JSON.stringify(INDEX)}\n`);
      }
      if (call.command === "ffmpeg") {
        await writeFile(call.args[call.args.length - 1], "clip");
      }
      if (call.command === "python3" && call.args.includes("--out")) {
        await copyFile(join(FIXTURES, "clip.mp4"), call.args[call.args.indexOf("--out") + 1]);
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const app = await startApp({
    projectDir: dir,
    inputs: [speech],
    port: 0,
    executor,
    proposeSend: async () =>
      JSON.stringify({
        scenes: [{ id: "sc-1", objective: "Abertura", selections: [{ speechId }] }],
        changedSceneIds: ["sc-1"],
        explanation: "fluxo com rebase",
      }),
    describeClient: {
      async send(content: unknown[]) {
        const match = /janela local: 0s → ([\d.]+)s/.exec(JSON.stringify(content));
        const end = match ? Number(match[1]) : 1;
        return JSON.stringify({
          spans: [{ start: 0, end, text: "pessoa falando", confidence: "observed", tags: [] }],
        });
      },
    },
  });
  stop = app.close;
  const base = `http://127.0.0.1:${app.port}`;

  const opened = await (await fetch(`${base}/project`)).json() as {
    project: { revision: number; assembly: { sources: { id: string }[] } };
  };
  expect(opened.project.assembly.sources).toHaveLength(1);
  const sourceId = opened.project.assembly.sources[0]!.id;
  speechId = `${sourceId}:u001`;

  audioGate = new Promise<void>((resolve) => {
    releaseAudio = resolve;
  });
  const preparing = await fetch(`${base}/project/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseRevision: opened.project.revision,
      request: "montar tudo",
      modelOptIn: true,
      visualOptIn: true,
    }),
  });
  expect(preparing.status).toBe(202);
  // A edição passa na frente com o áudio ainda preso no gate.
  await vi.waitFor(async () => {
    const body = await (await fetch(`${base}/project`)).json() as {
      project: { preparation: { status: string } | null };
    };
    expect(body.project.preparation?.status).toBe("running");
  });
  const edited = await fetch(`${base}/project/edit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseRevision: opened.project.revision,
      action: { type: "correct", sourceId, start: 0, end: 1, text: "tema corrigido" },
    }),
  });
  // correct alinha em background: 202 com a correção registrada.
  expect(edited.status).toBe(202);
  releaseAudio();
  audioGate = null;
  await vi.waitFor(async () => {
    const body = await (await fetch(`${base}/project`)).json() as {
      project: {
        revision: number;
        scenes: unknown[];
        analyses: { sourceId: string; status: string }[];
        corrections: { sourceId: string; text: string }[];
        preparation: { status: string } | null;
        previewArtifact: { revision: number } | null;
      };
    };
    expect(body.project.preparation?.status).toBe("ready");
    expect(body.project.analyses.find((a) => a.sourceId === sourceId)?.status).toBe("ready");
    expect(body.project.corrections).toHaveLength(1);
    expect(body.project.corrections[0]).toMatchObject({ sourceId, text: "tema corrigido" });
    expect(body.project.scenes).toHaveLength(1);
    expect(body.project.previewArtifact?.revision).toBe(body.project.revision);
    expect(body.project.revision).toBe(opened.project.revision + 2);
  }, { timeout: 15000, interval: 200 });
});
