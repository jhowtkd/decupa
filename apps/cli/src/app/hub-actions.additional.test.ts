import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { expect, it } from "vitest";
import { FIXTURES } from "../../../../tests/fixtures/global-setup.ts";
import { referenceForAssembly } from "../../../../tests/fixtures/timeline-reference.ts";
import { hashFile } from "@decupa/media";
import { blankProject } from "./assembly/routes.ts";
import { fixtureAssembly } from "./assembly/fixture.ts";
import { createProject, loadProject, validateProject } from "./assembly/store.ts";
import type { Project } from "./assembly/types.ts";
import { EDIT_RESERVATION_FILE } from "./edit-reservation.ts";
import { eligibleProjects, runProjectAction } from "./hub/batch.js";
import type { ExecCall, Executor } from "./pipeline.ts";
import { startApp } from "./server.ts";

type HubProject = {
  id: string;
  atividade: {
    revision: number | null;
    busy: boolean;
    actions: { resume: boolean; cancel: boolean; export: boolean };
  };
};

const executor = { async run() { return { code: 0, stdout: "", stderr: "" }; } };

async function waitUntil(label: string, probe: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function makeActiveResumeProject(root: string, id: string): Promise<void> {
  const dir = join(root, id);
  await mkdir(dir);
  const mediaPath = join(dir, "fala.mp4");
  await writeFile(mediaPath, "local fake media");
  const mediaStat = await stat(mediaPath);
  const project = blankProject(id, id);
  project.assembly.sources = [{
    id: "source", name: "fala.mp4", path: mediaPath,
    sha256: createHash("sha256").update("local fake media").digest("hex"),
    size: mediaStat.size, mtimeMs: mediaStat.mtimeMs, durationSeconds: 2,
    hasVideo: false, hasAudio: true, included: true, role: "speech",
    fps: null, width: null, height: null,
  }];
  project.permissions.model = true;
  project.preparation = {
    id: "preparation-before-resume", revision: project.revision, mode: "prepare", request: "",
    status: "interrupted", stage: "audio", sources: {},
  };
  await createProject(dir, project);
}

const localPreparationExecutor: Executor = {
  async run(call: ExecCall) {
    const work = call.env?.CLAUDE_PROJECT_DIR ?? call.cwd ?? "";
    if (work && call.args.includes("index")) {
      await mkdir(join(work, "out"), { recursive: true });
      await writeFile(join(work, "out", "speech_index.json"), JSON.stringify({ units: [] }));
    }
    if (call.command === "ffmpeg") {
      const destination = call.args.at(-1) ?? "";
      if (destination.startsWith("/")) {
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination.includes("%03d") ? destination.replace("%03d", "000") : destination, "local derivative");
      }
    }
    if (call.command === "python3" && call.args.includes("--out")) {
      const output = call.args[call.args.indexOf("--out") + 1];
      if (output) {
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, "local transcript");
      }
    }
    return { code: 0, stdout: "", stderr: "" };
  },
};

function localFakeProposal(_content: unknown[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("fake local proposal cancelled"));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    void resolve;
  });
}

it("Retomar aceita dois Projetos com dependências locais e Cancelar envia as duas ações reais", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-actions-resume-cancel-"));
  await Promise.all([makeActiveResumeProject(root, "resume-a"), makeActiveResumeProject(root, "resume-b")]);
  const app = await startApp({
    projectsRoot: root, port: 0, autoStart: false, executor: localPreparationExecutor,
    proposeSend: localFakeProposal,
    env: { DECUPA_ASSEMBLY_TEXT_PROVIDER: "openai", OPENAI_API_KEY: "fake-local-only" },
  });
  const base = `http://127.0.0.1:${app.port}`;
  const statuses: number[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    const response = await fetch(`${base}${url}`, init);
    statuses.push(response.status);
    return response;
  };
  try {
    const initial = await (await fetch(`${base}/api/projects`)).json() as HubProject[];
    const selected = new Set(initial.map((project) => project.id));
    const resumable = eligibleProjects(initial, selected, "resume");
    expect(resumable.map((project) => project.id).sort()).toEqual(["resume-a", "resume-b"]);
    for (const project of resumable) await runProjectAction(project, "resume", fetchImpl);
    expect(statuses).toEqual([202, 202]);

    let current: HubProject[] = [];
    await waitUntil("both preparations visible as busy", async () => {
      current = await (await fetch(`${base}/api/projects`)).json() as HubProject[];
      return current.length === 2 && current.every((project) => project.atividade.actions.cancel);
    });
    const cancelSelection = new Set(current.map((project) => project.id));
    const cancellable = eligibleProjects(current, cancelSelection, "cancel");
    expect(cancellable).toHaveLength(2);
    for (const project of cancellable) await runProjectAction(project, "cancel", fetchImpl);
    expect(statuses).toEqual([202, 202, 200, 200]);

    await waitUntil("both preparations finish draining after cancellation", async () => {
      const projects = await (await fetch(`${base}/api/projects`)).json() as HubProject[];
      return projects.every((project) => !project.atividade.busy);
    });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function makeResumeProject(root: string, id: string): Promise<void> {
  const dir = join(root, id);
  await mkdir(dir);
  const project = blankProject(id, id);
  project.assembly.sources = [{
    id: "source", name: "fala.wav", path: join(dir, "fala.wav"), sha256: "a".repeat(64),
    size: 5, mtimeMs: 1, durationSeconds: 10, hasVideo: false, hasAudio: true,
    included: true, role: "speech", fps: null, width: null, height: null,
  }];
  project.preparation = {
    id: "interrupted-preparation", revision: project.revision, mode: "prepare", request: "",
    status: "interrupted", stage: "audio", sources: {},
  };
  await createProject(dir, project);
}

async function makeExportProject(root: string, id: string): Promise<void> {
  const dir = join(root, id);
  await mkdir(dir);
  const project = blankProject(id, id);
  project.previewRevision = project.revision;
  project.finalApprovedRevision = project.revision;
  project.previewArtifact = {
    revision: project.revision,
    assemblySha256: createHash("sha256").update(JSON.stringify(project.assembly)).digest("hex"),
    relativePath: "preview.mp4",
    sha256: "b".repeat(64),
  };
  await writeFile(join(dir, "preview.mp4"), "local preview");
  await createProject(dir, project);
}

async function makeApprovedExportProject(root: string, id: string): Promise<void> {
  const dir = join(root, id);
  await mkdir(dir);
  const speech = join(dir, "fala.mp4");
  const support = join(dir, "apoio.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), speech);
  await copyFile(join(FIXTURES, "clip.mp4"), support);

  const base = blankProject(id, id);
  base.revision = 1;
  base.assembly = fixtureAssembly();
  base.assembly.revision = base.revision;
  base.assembly.sources[0]!.path = speech;
  base.assembly.sources[0]!.sha256 = await hashFile(speech);
  base.assembly.sources[1]!.path = support;
  base.assembly.sources[1]!.sha256 = await hashFile(support);
  base.previewRevision = base.revision;
  base.finalApprovedRevision = base.revision;

  // Hash do gate calculado sobre o assembly canônico que o armazenamento
  // persistirá, não sobre uma fixture presumidamente já normalizada.
  const canonical: Project = validateProject(base);
  const reference = join(dir, `rev-${canonical.revision}`, "reference.mp4");
  await mkdir(dirname(reference), { recursive: true });
  await copyFile(await referenceForAssembly(canonical.assembly), reference);
  canonical.previewArtifact = {
    revision: canonical.revision,
    assemblySha256: createHash("sha256").update(JSON.stringify(canonical.assembly)).digest("hex"),
    relativePath: relative(dir, reference),
    sha256: await hashFile(reference),
  };
  await createProject(dir, canonical);
  const stored = await loadProject(dir);
  expect(stored.previewArtifact?.assemblySha256)
    .toBe(createHash("sha256").update(JSON.stringify(stored.assembly)).digest("hex"));
}

it("filtra e envia ações em lote a rotas reais; revisionamento e reserva retornam os erros atuais", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-actions-http-"));
  await Promise.all([
    makeResumeProject(root, "resume-a"),
    makeResumeProject(root, "resume-b"),
    makeExportProject(root, "export-stale"),
    makeExportProject(root, "export-a"),
    makeExportProject(root, "export-b"),
  ]);
  const app = await startApp({ projectsRoot: root, port: 0, autoStart: false, executor, env: {} });
  const base = `http://127.0.0.1:${app.port}`;
  const fetchImpl = (url: string, init: RequestInit) => fetch(`${base}${url}`, init);
  try {
    const listed = await fetch(`${base}/api/projects`);
    expect(listed.status).toBe(200);
    const projects = await listed.json() as HubProject[];
    const selected = new Set(projects.map((project) => project.id));
    const resumable = eligibleProjects(projects, selected, "resume");
    const exportable = eligibleProjects(projects, selected, "export");
    expect(resumable.map((project) => project.id).sort()).toEqual(["resume-a", "resume-b"]);
    expect(exportable.map((project) => project.id).sort()).toEqual(["export-a", "export-b", "export-stale"]);
    expect(eligibleProjects(projects, selected, "cancel")).toEqual([]);

    // Sem credencial de provedor, ambas as rotas reais informam que Retomar
    // exige configuração. O teste não inventa uma chamada paga para avançar.
    for (const project of resumable) {
      await expect(runProjectAction(project, "resume", fetchImpl)).rejects.toThrow(/Configure o provedor de texto primeiro/);
    }

    // Cancelar é idempotente no servidor; um snapshot de processo ocupado pode
    // ficar obsoleto antes do clique, e a rota ainda responde com sucesso.
    const cancelSnapshot = resumable.map((project) => ({
      ...project,
      atividade: { ...project.atividade, actions: { ...project.atividade.actions, cancel: true } },
    }));
    const cancellable = eligibleProjects(cancelSnapshot, new Set(cancelSnapshot.map((project) => project.id)), "cancel");
    expect(cancellable).toHaveLength(2);
    for (const project of cancellable) {
      await expect(runProjectAction(project, "cancel", fetchImpl)).resolves.toMatchObject({ ok: true });
    }

    const staleExport = exportable.find((project) => project.id === "export-stale")!;
    const stalePath = join(root, staleExport.id, "project.json");
    const staleDisk = JSON.parse(await readFile(stalePath, "utf8")) as { revision: number } & Record<string, unknown>;
    await writeFile(stalePath, JSON.stringify({ ...staleDisk, revision: staleDisk.revision + 1 }));
    await expect(runProjectAction(staleExport, "export", fetchImpl)).rejects.toThrow(/revisão desatualizada/);

    // A reserva pode chegar depois da lista. O POST real protege cada revisão,
    // mesmo que o cartão ainda mostrasse Exportar como elegível.
    for (const project of exportable.filter((item) => item.id !== "export-stale")) {
      await writeFile(join(root, project.id, EDIT_RESERVATION_FILE), JSON.stringify({
        tabId: `tab-${project.id}`, nome: "Ana", ultimoSinal: Date.now(),
      }));
      await expect(runProjectAction(project, "export", fetchImpl)).rejects.toThrow(/reservado para edição/);
    }
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("exporta dois projetos aprovados por HTTP e conserva a conferência pendente no Hub", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-actions-export-success-"));
  await Promise.all([
    makeApprovedExportProject(root, "approved-a"),
    makeApprovedExportProject(root, "approved-b"),
  ]);
  const app = await startApp({ projectsRoot: root, port: 0, autoStart: false, executor, env: {} });
  const base = `http://127.0.0.1:${app.port}`;
  const fetchImpl = (url: string, init: RequestInit) => fetch(`${base}${url}`, init);
  try {
    const response = await fetch(`${base}/api/projects`);
    expect(response.status).toBe(200);
    const projects = await response.json() as HubProject[];
    const selected = new Set(projects.map((project) => project.id));
    const exportable = eligibleProjects(projects, selected, "export");
    expect(exportable.map((project) => project.id).sort()).toEqual(["approved-a", "approved-b"]);

    for (const project of exportable) {
      const result = await runProjectAction(project, "export", fetchImpl) as {
        path: string;
        verificacao: { status: string; revision: number };
      };
      const revision = project.atividade.revision!;
      const dest = join(root, project.id, "exports", String(revision));
      expect(result.path).toBe(dest);
      expect(result.verificacao).toMatchObject({ status: "pendente", revision });

      const manifest = JSON.parse(await readFile(join(dest, "manifest.json"), "utf8")) as {
        revision: number;
        timeline: string;
        reference: string;
        verificacao: string;
      };
      const otioBytes = await readFile(join(dest, "timeline.otio"));
      const otioText = otioBytes.toString("utf8");
      const verification = JSON.parse(await readFile(join(dest, "verificacao.json"), "utf8")) as {
        status: string;
        revision: number;
      };
      expect(manifest).toMatchObject({ revision, verificacao: "pendente" });
      expect(manifest.timeline).toBe(createHash("sha256").update(otioBytes).digest("hex"));
      expect(manifest.reference).toBe((await loadProject(join(root, project.id))).previewArtifact?.sha256);
      expect(otioText).toContain("v1-a");
      expect(otioText).toContain("v2-b");
      expect(verification).toEqual({
        status: "pendente",
        revision,
        artefato: expect.any(Object),
        origem: null,
        legendas: expect.any(Object),
      });
    }

    const afterExport = await (await fetch(`${base}/api/projects`)).json() as (HubProject & {
      atividade: HubProject["atividade"] & { lifecycle: { state: string } };
    })[];
    expect(afterExport).toHaveLength(2);
    expect(afterExport.every((project) => project.atividade.lifecycle.state !== "entregue")).toBe(true);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
