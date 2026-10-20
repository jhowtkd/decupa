import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { FIXTURES } from "../../../../tests/fixtures/global-setup.ts";
import { eligibleProjects, runProjectAction } from "./hub/batch.js";
import { projectActivity } from "./hub-activity.ts";
import { EDIT_RESERVATION_FILE } from "./edit-reservation.ts";
import { claimWorkDir } from "./session.ts";
import type { ExecCall, Executor } from "./pipeline.ts";
import { startApp } from "./server.ts";

type CleanupHubProject = {
  id: string;
  fluxo?: string;
  atividade: {
    jobId: string;
    exportKind: "mp4";
    revision: number | null;
    busy: boolean;
    queuePosition: number | null;
    actions: { resume: boolean; cancel: boolean; export: boolean };
  };
};

const observedCalls: ExecCall[] = [];
const localRenderOnly: Executor = {
  async run(call: ExecCall) {
    observedCalls.push(call);
    if (call.args.includes("render")) {
      const destination = call.args.at(-1);
      if (!destination) return { code: 1, stdout: "", stderr: "render sem destino" };
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(FIXTURES, "clip.mp4"), destination);
      return { code: 0, stdout: "", stderr: "" };
    }
    // O ingest pode capturar falhas do executor; o teste verifica o registro
    // das chamadas ao final para que uma tentativa não passe despercebida.
    return { code: 1, stdout: "", stderr: "chamada fora do render local" };
  },
};

async function createCleanupProject(root: string, id: string): Promise<void> {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  const source = join(FIXTURES, "clip.mp4");
  await claimWorkDir(dir, source);
  await mkdir(join(dir, "out"), { recursive: true });
  await writeFile(join(dir, "out", "condense_plan.json"), JSON.stringify({
    clips: [{ start: 0, end: 1 }],
  }));
}

it("exibe Limpeza pronta sem Retomar e exporta dois MP4s por rotas HTTP após reiniciar", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-cleanup-actions-"));
  observedCalls.length = 0;
  await Promise.all([createCleanupProject(root, "cleanup-a"), createCleanupProject(root, "cleanup-b")]);
  let app = await startApp({ projectsRoot: root, port: 0, executor: localRenderOnly, env: {} });
  try {
    const firstBase = `http://127.0.0.1:${app.port}`;
    const response = await fetch(`${firstBase}/api/projects`);
    expect(response.status).toBe(200);
    const initial = await response.json() as CleanupHubProject[];
    expect(initial).toHaveLength(2);
    await app.close();

    // Reabre a raiz como um processo novo: só o plano persistido deve ser
    // necessário para exportar, sem disparar transcrição/indexação no boot.
    app = await startApp({ projectsRoot: root, port: 0, executor: localRenderOnly, env: {} });
    const base = `http://127.0.0.1:${app.port}`;
    const fetchImpl = (url: string, init: RequestInit) => fetch(`${base}${url}`, init);
    const projects = await (await fetch(`${base}/api/projects`)).json() as CleanupHubProject[];
    expect(projects).toHaveLength(2);
    expect(projects.every(project => project.atividade.actions.resume === false)).toBe(true);
    expect(projects.every(project => project.atividade.actions.export === true)).toBe(true);

    const selected = new Set(projects.map(project => project.id));
    expect(eligibleProjects(projects, selected, "resume")).toEqual([]);
    const exportable = eligibleProjects(projects, selected, "export");
    expect(exportable.map(project => project.id).sort()).toEqual(["cleanup-a", "cleanup-b"]);

    // Uma reserva pode surgir depois do snapshot elegível; a rota continua
    // sendo a autoridade e deve impedir o export daquele Projeto.
    const reserved = exportable[0]!;
    await writeFile(join(root, reserved.id, EDIT_RESERVATION_FILE), JSON.stringify({
      tabId: `tab-${reserved.id}`, nome: "Ana", ultimoSinal: Date.now(),
    }));
    await expect(runProjectAction(reserved, "export", fetchImpl)).rejects.toThrow(/reservado para edição/);
    await rm(join(root, reserved.id, EDIT_RESERVATION_FILE), { force: true });

    // O executor registra toda chamada. O único trabalho permitido é render;
    // uma tentativa de ingest seria registrada mesmo que o runtime a capturasse.
    for (const project of exportable) {
      const result = await runProjectAction(project, "export", fetchImpl) as {
        path: string;
        downloadUrl: string;
      };
      expect(result.path).toBe(join(root, project.id, "corte.mp4"));
      expect(result.downloadUrl).toBe(`/projects/${project.id}/jobs/${project.atividade.jobId}/download/mp4`);

      const downloaded = await fetch(`${base}${result.downloadUrl}`);
      expect(downloaded.status).toBe(200);
      expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(await readFile(join(FIXTURES, "clip.mp4")));
    }
    expect(observedCalls).toHaveLength(2);
    expect(observedCalls.every(call => call.command === "python3" && call.args.includes("render"))).toBe(true);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("busy só permite Cancelar quando o runtime é cancelável", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-cleanup-cancellable-"));
  const id = "cleanup-busy";
  await createCleanupProject(root, id);
  try {
    const dir = join(root, id);
    const nonCancellable = await projectActivity(dir, id, "cleanup", Date.now, {
      runtime: async () => ({ busy: true, cancellable: false, operation: { stage: "rendering" } }),
      queue: [], holders: [],
    });
    expect(nonCancellable.busy).toBe(true);
    expect(nonCancellable.actions.cancel).toBe(false);
    expect(nonCancellable.actions.export).toBe(false);

    const cancellable = await projectActivity(dir, id, "cleanup", Date.now, {
      runtime: async () => ({ busy: true, cancellable: true, operation: { stage: "rendering" } }),
      queue: [], holders: [],
    });
    expect(cancellable.busy).toBe(true);
    expect(cancellable.actions.cancel).toBe(true);
    expect(cancellable.actions.export).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
