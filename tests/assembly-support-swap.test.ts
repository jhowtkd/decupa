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
    text: "olá tema", has_terminal_punct: true, is_question: false,
    word_count: 2, cps: 1, lead_gap: 0,
    disfluency: { hard: [], soft: [], stutter: [] },
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
      }
      // Extração de frames da descrição visual: -t N + destino %03d.
      const dest = call.args.find((arg) => arg.includes("%03d"));
      const secondsIdx = call.args.indexOf("-t");
      if (dest && secondsIdx >= 0) {
        const { writeFile } = await import("node:fs/promises");
        const seconds = Number(call.args[secondsIdx + 1]!);
        for (let i = 0; i < seconds; i += 1) {
          await writeFile(dest.replace("%03d", String(i).padStart(3, "0")), `frame-${i}`);
        }
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

type SupportEntry = { visualId: string; offsetFrames: number; durationFrames: number };
type ProjectView = {
  revision: number;
  previewRevision: number | null;
  finalApprovedRevision: number | null;
  assembly: { sources: { id: string; role: string }[]; fps: { num: number; den: number } };
  scenes: {
    id: string;
    takes: { id: string; speechId: string; removed: { start: number; end: number }[] }[];
    support: SupportEntry[];
    visualEvidenceIds: string[];
  }[];
  analyses: { sourceId: string; speech: { id: string }[]; visual: { id: string }[] }[];
};

type SupportSwap = {
  id: string;
  baseRevision: number;
  scope: { sceneId: string; supportIndex: number };
  current: { visualId: string; sourceId: string; evidence: string };
  candidates: { id: string; sourceId: string; description: string; fullCoverage: boolean }[];
  gap: string | null;
};

async function view(base: string): Promise<{ project: ProjectView; supportSwap: SupportSwap | null }> {
  return (await fetch(`${base}/project`)).json() as Promise<{ project: ProjectView; supportSwap: SupportSwap | null }>;
}

async function analyzeAll(base: string, project: ProjectView): Promise<ProjectView> {
  const res = await post(base, "/project/analyze", {
    sourceIds: project.assembly.sources.map((s) => s.id),
    visual: true,
  });
  expect(res.status).toBe(200);
  return (await res.json() as { project: ProjectView }).project;
}

it("troca de apoio: candidatos com evidência, aplicação, desfazer (#65)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-swap-"));
  const speech = join(dir, "fala.mp4");
  const apoio = join(dir, "apoio.mp4");
  const extra = join(dir, "extra.mp4");
  for (const target of [speech, apoio, extra]) {
    await copyFile(join(FIXTURES, "clip.mp4"), target);
  }
  // describe por chamada: fala (vídeo de fala) → apoio → extra.
  const spansByCall: { id: string; start: number; end: number; text: string }[][] = [
    [],
    [{ id: "v0", start: 0, end: 1, text: "apoio antigo", confidence: "observed", tags: [] }],
    [
      { id: "v1", start: 0, end: 1, text: "candidato um", confidence: "observed", tags: [] },
      { id: "v2", start: 1, end: 2, text: "candidato dois", confidence: "observed", tags: [] },
    ],
  ];
  let describeCalls = 0;
  const app = await startApp({
    projectDir: dir, inputs: [speech, apoio, extra], port: 0,
    executor: executor(),
    allowPaidVisual: true,
    describeClient: {
      async send() {
        const spans = spansByCall[describeCalls++] ?? [];
        return JSON.stringify({ spans });
      },
    },
  });
  stop = app.close;
  const base = `http://127.0.0.1:${app.port}`;

  // Papéis: só a primeira fonte é speech; as outras viram apoio.
  const opened = (await view(base)).project;
  const [speechSrc, apoioSrc, extraSrc] = opened.assembly.sources;
  const roles = await post(base, "/project/source-role", {
    baseRevision: opened.revision,
    sourceIds: [apoioSrc!.id, extraSrc!.id], role: "support",
  });
  expect(roles.status).toBe(200);

  await post(base, "/project/input", {
    baseRevision: (await view(base)).project.revision,
    kind: "brief", text: "contar o tema", targetSeconds: 2,
  });
  const analyzed = await analyzeAll(base, await view(base).then((v) => v.project));
  const speechId = analyzed.analyses[0]!.speech[0]!.id;
  const apoioVisual = analyzed.analyses.find((a) => a.sourceId === apoioSrc!.id)!.visual[0]!.id;
  const fps = analyzed.assembly.fps.num / analyzed.assembly.fps.den;

  // Cena com take de fala + 1s do apoio antigo.
  await post(base, "/project/propose", {
    baseRevision: analyzed.revision,
    proposal: {
      id: "prop-1", baseRevision: analyzed.revision,
      changedSceneIds: ["s1"], explanation: "abertura",
      scenes: [{
        id: "s1", objective: "abrir", rationale: "tema",
        speechIds: [speechId], gaps: [],
        support: [{ visualId: apoioVisual, offsetFrames: Math.round(0.5 * fps), durationFrames: Math.round(1 * fps) }],
      }],
    },
  });
  const applied = (await (await post(base, "/project/apply", {
    baseRevision: analyzed.revision, proposalId: "prop-1",
  })).json() as { project: ProjectView }).project;
  expect(applied.scenes[0]!.support).toHaveLength(1);

  // Proposta de troca: candidatos com origem e evidência.
  const proposed = await post(base, "/project/support-swap", {
    baseRevision: applied.revision, sceneId: "s1", supportIndex: 0, request: "troca o apoio",
  });
  expect(proposed.status).toBe(200);
  const swap = (await view(base)).supportSwap!;
  expect(swap.current.visualId).toBe(apoioVisual);
  expect(swap.current.evidence).toBe("apoio antigo");
  expect(swap.candidates.length).toBeGreaterThan(0);
  expect(swap.candidates.every((c) => c.sourceId !== speechSrc!.id)).toBe(true);
  expect(swap.gap).toBeNull();
  const chosen = swap.candidates[0]!;

  // Aceitar: só o apoio muda; falas/cortes/demais apoios intactos.
  const accept = await post(base, "/project/support-swap-accept", {
    baseRevision: applied.revision, proposalId: swap.id, candidateId: chosen.id,
  });
  expect(accept.status).toBe(200);
  const afterAccept = await view(base);
  expect(afterAccept.supportSwap).toBeNull();
  expect(afterAccept.project.revision).toBe(applied.revision + 1);
  const scene = afterAccept.project.scenes[0]!;
  expect(scene.takes).toEqual(applied.scenes[0]!.takes);
  expect(scene.support[0]!.visualId).not.toBe(apoioVisual);
  expect(scene.support[0]!.offsetFrames).toBe(Math.round(0.5 * fps));

  // Desfazer recupera o apoio anterior.
  const undone = await post(base, "/project/undo", {
    baseRevision: afterAccept.project.revision, revision: applied.revision,
  });
  expect(undone.status).toBe(200);
  const restored = await view(base);
  expect(restored.project.scenes[0]!.support[0]!.visualId).toBe(apoioVisual);
});

it("sem candidato adequado a montagem é preservada e a lacuna explicada (#65)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-swap-empty-"));
  const speech = join(dir, "fala.mp4");
  const apoio = join(dir, "apoio.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), speech);
  await copyFile(join(FIXTURES, "clip.mp4"), apoio);
  let describeCalls = 0;
  const spansByCall = [
    [],
    [{ id: "v0", start: 0, end: 1, text: "único trecho", confidence: "observed", tags: [] }],
  ];
  const app = await startApp({
    projectDir: dir, inputs: [speech, apoio], port: 0,
    executor: executor(),
    allowPaidVisual: true,
    describeClient: {
      async send() {
        return JSON.stringify({ spans: spansByCall[describeCalls++] ?? [] });
      },
    },
  });
  stop = app.close;
  const base = `http://127.0.0.1:${app.port}`;

  const opened = (await view(base)).project;
  const [, apoioSrc] = opened.assembly.sources;
  const roles = await post(base, "/project/source-role", {
    baseRevision: opened.revision, sourceIds: [apoioSrc!.id], role: "support",
  });
  expect(roles.status).toBe(200);
  await post(base, "/project/input", {
    baseRevision: (await view(base)).project.revision,
    kind: "brief", text: "contar o tema", targetSeconds: 2,
  });
  const analyzed = await analyzeAll(base, await view(base).then((v) => v.project));
  const speechId = analyzed.analyses[0]!.speech[0]!.id;
  const apoioVisual = analyzed.analyses.find((a) => a.sourceId === apoioSrc!.id)!.visual[0]!.id;
  const fps = analyzed.assembly.fps.num / analyzed.assembly.fps.den;
  await post(base, "/project/propose", {
    baseRevision: analyzed.revision,
    proposal: {
      id: "prop-1", baseRevision: analyzed.revision,
      changedSceneIds: ["s1"], explanation: "abertura",
      scenes: [{
        id: "s1", objective: "abrir", rationale: "tema",
        speechIds: [speechId], gaps: [],
        support: [{ visualId: apoioVisual, offsetFrames: 0, durationFrames: Math.round(0.5 * fps) }],
      }],
    },
  });
  const applied = (await (await post(base, "/project/apply", {
    baseRevision: analyzed.revision, proposalId: "prop-1",
  })).json() as { project: ProjectView }).project;

  // O único trecho da única fonte de apoio já está em uso: não há candidato.
  const proposed = await post(base, "/project/support-swap", {
    baseRevision: applied.revision, sceneId: "s1", supportIndex: 0, request: "troca",
  });
  expect(proposed.status).toBe(200);
  const swap = (await view(base)).supportSwap!;
  expect(swap.candidates).toHaveLength(0);
  expect(swap.gap).toMatch(/sem candidato elegível/);
  const current = await view(base);
  expect(current.project.revision).toBe(applied.revision);
  expect(current.project.scenes[0]!.support[0]!.visualId).toBe(apoioVisual);

  // Aceitar sem candidato é recusado; rejeitar fecha a proposta intacta.
  const accept = await post(base, "/project/support-swap-accept", {
    baseRevision: applied.revision, proposalId: swap.id, candidateId: "inexistente",
  });
  expect(accept.status).toBe(400);
  const reject = await post(base, "/project/support-swap-reject", {
    baseRevision: applied.revision, proposalId: swap.id,
  });
  expect(reject.status).toBe(200);
  expect((await view(base)).supportSwap).toBeNull();
});
