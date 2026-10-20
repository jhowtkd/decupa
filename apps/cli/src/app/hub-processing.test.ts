import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { blankProject } from "./assembly/routes.ts";
import { createProject, loadProject } from "./assembly/store.ts";
import { startApp } from "./server.ts";

it("consolida dez projetos e corrige running órfão sem abrir os editores, inclusive após reinício", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-processing-"));
  const statuses = [null, "running", "cancelled", "interrupted", "attention", "ready", null, null, null, null] as const;
  for (let i = 0; i < 10; i++) {
    const dir = join(root, String(i));
    await mkdir(dir);
    const project = blankProject(String(i), `Projeto ${i}`);
    project.assembly.sources = [{ id: "source", name: "aula.wav", path: join(root, "aula.wav"),
      sha256: "a".repeat(64), size: 5, mtimeMs: 1, durationSeconds: 10, fps: null, width: null, height: null, hasVideo: false, hasAudio: true,
      included: true, role: "speech" }];
    await writeFile(join(root, "aula.wav"), "media");
    project.revision = 2;
    project.previewRevision = i >= 5 ? 2 : null;
    project.finalApprovedRevision = i >= 6 ? 2 : null;
    if (i >= 6) {
      project.previewArtifact = { revision: 2, assemblySha256: createHash("sha256").update(JSON.stringify(project.assembly)).digest("hex"), relativePath: "preview.mp4", sha256: "a".repeat(64) };
      await writeFile(join(dir, "preview.mp4"), "preview");
    }
    project.preparation = statuses[i] ? { id: "prep", revision: 2, mode: "prepare", request: "", status: statuses[i]!, stage: "audio", sources: {} } : null;
    await createProject(dir, project);
    if (i >= 6) {
      const disk = JSON.parse(await readFile(join(dir, "project.json"), "utf8"));
      disk.previewArtifact.assemblySha256 = createHash("sha256").update(JSON.stringify((await loadProject(dir)).assembly)).digest("hex");
      await writeFile(join(dir, "project.json"), JSON.stringify(disk));
    }
    if (i >= 7) {
      await mkdir(join(dir, "exports", "2"), { recursive: true });
      await writeFile(join(dir, "exports", "2", "verificacao.json"), JSON.stringify({ revision: 2, status: i === 7 ? "pendente" : "confirmada", confirmadaEm: new Date().toISOString() }));
    }
    if (i === 9) {
      const disk = JSON.parse(await readFile(join(dir, "project.json"), "utf8"));
      disk.lifecycle = { state: "arquivado", enteredAt: { arquivado: 1 } };
      await writeFile(join(dir, "project.json"), JSON.stringify(disk));
    }
  }
  try {
    for (let boot = 0; boot < 2; boot++) {
      const app = await startApp({ projectsRoot: root, port: 0, autoStart: false, executor: { async run() { throw new Error("não executar processamento"); } }, env: {} });
      try {
        const response = await fetch(`http://127.0.0.1:${app.port}/api/projects`);
        const projects = await response.json() as Array<{id: string; atividade: any}>;
        expect(projects).toHaveLength(10);
        const activity = (id: number) => projects.find(p => p.id === String(id))!.atividade;
        expect(activity(1)).toMatchObject({ busy: false, actions: { resume: true, cancel: false, export: false } });
        expect(activity(1).text).toContain("falha");
        expect(JSON.parse(await readFile(join(root, "1", "project.json"), "utf8")).preparation.status).toBe("interrupted");
        expect(activity(2).text).toContain("cancelada");
        expect(activity(3).actions.resume).toBe(true);
        expect(activity(4).actions.resume).toBe(true);
        expect(activity(5).result).toContain("pronta");
        expect(activity(5).actions.export).toBe(false);
        expect(activity(6).approval).toContain("aprovada");
        expect(activity(6).actions.export).toBe(true);
        expect(activity(7).lifecycle.state).toBe("ativo");
        expect(activity(8).lifecycle.state).toBe("entregue");
        expect(activity(9).lifecycle.state).toBe("arquivado");
        expect(projects.every(p => !p.atividade.busy)).toBe(true);
      } finally { await app.close(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
