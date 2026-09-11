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

  expect((await fetch(`${base}/project/approve-final`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseRevision: applied.project.revision }),
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
