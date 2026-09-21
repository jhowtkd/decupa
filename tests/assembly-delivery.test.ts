import { copyFile, mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { hashFile } from "../packages/media/src/hash.ts";
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
        const { mkdir, writeFile } = await import("node:fs/promises");
        await mkdir(join(work, "out"), { recursive: true });
        await writeFile(join(work, "out", "speech_index.json"), `${JSON.stringify(INDEX)}\n`);
      }
      if (work) await copyFile(join(FIXTURES, "clip.mp4"), join(work, "reference.mp4"));
      return { code: 0, stdout: "ok", stderr: "" };
    },
  };
}

type DeliveryProject = {
  revision: number;
  assembly: { sources: { id: string; included: boolean; path: string }[] };
  scenes: unknown[];
  previewRevision: number | null;
  previewArtifact: { revision: number; relativePath: string; sha256: string } | null;
  finalApprovedRevision: number | null;
};

async function post(base: string, path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getProject(base: string): Promise<DeliveryProject> {
  const res = await fetch(`${base}/project`);
  const data = await res.json() as { project: DeliveryProject };
  return data.project;
}

it("entrega vazia: checklist zerado, export recusado e saídas ausentes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-delivery-empty-"));
  const app = await startApp({ projectDir: dir, port: 0, executor: indexingAndRender() });
  stop = app.close;
  const base = `http://127.0.0.1:${app.port}`;

  // Estado que alimenta o checklist: sem mídia, sem seleção, sem revisão.
  const empty = await getProject(base);
  expect(empty.assembly.sources).toHaveLength(0);
  expect(empty.scenes).toHaveLength(0);
  expect(empty.finalApprovedRevision).toBeNull();

  // Ocioso: nada para baixar antes do export.
  expect((await fetch(`${base}/project/output/0/otio`)).status).toBe(404);
  expect((await fetch(`${base}/project/output/0/mp4`)).status).toBe(404);

  // Erro distinguível: servidor recusa sem aprovação, com mensagem.
  const denied = await post(base, "/project/export", { baseRevision: empty.revision });
  expect(denied.status).toBe(409);
  const deniedBody = await denied.json() as { error: string };
  expect(deniedBody.error).toMatch(/aprova/);
});

it("entrega após aprovação: checklist completo e export concluído com saídas", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-delivery-"));
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

  // Mídia presente e seleção feita, revisão ainda pendente.
  const opened = await getProject(base);
  expect(opened.assembly.sources.length).toBeGreaterThan(0);
  expect(opened.assembly.sources.some((s) => s.included)).toBe(true);
  expect(opened.finalApprovedRevision).toBeNull();

  expect((await post(base, "/project/input", {
    baseRevision: opened.revision,
    kind: "brief", text: "contar o tema", targetSeconds: 2,
  })).status).toBe(200);

  const analyze = await post(base, "/project/analyze", {
    sourceIds: opened.assembly.sources.map((s) => s.id),
  });
  expect(analyze.status).toBe(200);
  const analyzed = await analyze.json() as {
    project: { revision: number; analyses: { sourceId: string; speech: { id: string }[] }[] };
  };
  const speechId = analyzed.project.analyses[0]?.speech[0]?.id;
  expect(speechId).toMatch(/u001/);

  expect((await post(base, "/project/propose", {
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
  })).status).toBe(200);

  const apply = await post(base, "/project/apply", {
    baseRevision: analyzed.project.revision,
    proposalId: "prop-1",
  });
  expect(apply.status).toBe(200);
  const applied = await apply.json() as { project: { revision: number } };

  expect((await post(base, "/project/preview", {
    baseRevision: applied.project.revision,
  })).status).toBe(200);

  const previewed = await getProject(base);
  expect((await post(base, "/project/approve-final", {
    baseRevision: previewed.revision,
    watchedRevision: previewed.previewRevision,
  })).status).toBe(200);

  // Checklist completo: mídia, seleção e revisão pronta servidas.
  const ready = await getProject(base);
  expect(ready.assembly.sources.length).toBeGreaterThan(0);
  expect(ready.assembly.sources.some((s) => s.included)).toBe(true);
  expect(ready.scenes.length).toBeGreaterThan(0);
  expect(ready.previewArtifact?.revision).toBe(ready.revision);
  expect(ready.finalApprovedRevision).toBe(ready.revision);

  // Concluído: export 200 e saídas servidas.
  const exported = await post(base, "/project/export", { baseRevision: ready.revision });
  expect(exported.status).toBe(200);
  const otio = await fetch(`${base}/project/output/${ready.revision}/otio`);
  const mp4 = await fetch(`${base}/project/output/${ready.revision}/mp4`);
  expect(otio.status).toBe(200);
  expect(mp4.status).toBe(200);
  expect(await otio.text()).toContain("Timeline.1");
  const manifest = JSON.parse(
    await readFile(join(dir, "exports", String(ready.revision), "manifest.json"), "utf8"),
  ) as { revision: number; reference: string };
  expect(manifest.revision).toBe(ready.revision);
  // Exporta exatamente o MP4 assistido e aprovado — mesmo hash da prévia.
  expect(ready.previewArtifact).not.toBeNull();
  const approvedFile = join(dir, ready.previewArtifact!.relativePath);
  expect(await hashFile(approvedFile)).toBe(ready.previewArtifact!.sha256);
  expect(await hashFile(join(dir, "exports", String(ready.revision), "reference.mp4")))
    .toBe(ready.previewArtifact!.sha256);
  expect(manifest.reference).toBe(ready.previewArtifact!.sha256);
  // OTIO referencia os originais, nunca derivados.
  const otioText = await readFile(join(dir, "exports", String(ready.revision), "timeline.otio"), "utf8");
  const urls = [...otioText.matchAll(/"target_url":"([^"]+)"/g)].map((m) => m[1]!);
  expect(urls.length).toBeGreaterThan(0);
  const originals = new Set<string>();
  for (const source of ready.assembly.sources) {
    originals.add(pathToFileURL(await realpath(source.path)).href);
  }
  for (const url of urls) {
    expect(originals.has(url)).toBe(true);
  }
  expect(otioText).not.toContain("proxy.mp4");
  expect(otioText).not.toMatch(/media\/[0-9a-f]{64}\//);
});
