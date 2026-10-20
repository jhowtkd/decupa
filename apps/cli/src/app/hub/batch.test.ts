import { expect, it } from "vitest";
import { eligibleProjects, runProjectAction } from "./batch.js";

it("cada ação filtra a seleção e reutiliza a rota da revisão recebida", async () => {
  const projects = [
    { id: "a /b", atividade: { revision: 3, actions: { resume: true, cancel: false, export: false } } },
    { id: "b", atividade: { revision: 4, actions: { resume: true, cancel: true, export: false } } },
    { id: "c", atividade: { revision: 5, actions: { resume: false, cancel: false, export: true } } },
    { id: "d", atividade: { revision: 6, actions: { resume: false, cancel: false, export: false } } },
  ];
  const selected = new Set(projects.map(p => p.id));
  expect(eligibleProjects(projects, selected, "resume").map(p => p.id)).toEqual(["a /b", "b"]);
  expect(eligibleProjects(projects, selected, "cancel").map(p => p.id)).toEqual(["b"]);
  expect(eligibleProjects(projects, selected, "export").map(p => p.id)).toEqual(["c"]);
  const calls: Array<[string, any]> = [];
  const fetchImpl = async (url: string, init: any) => { calls.push([url, JSON.parse(init.body)]); return { ok: true, json: async () => ({ operation: { stage: "cancelled" } }) }; };
  for (const action of ["resume", "cancel", "export"]) {
    for (const project of eligibleProjects(projects, selected, action)) await runProjectAction(project, action, fetchImpl);
  }
  expect(calls).toEqual([
    ["/projects/a%20%2Fb/project/prepare", { baseRevision: 3 }],
    ["/projects/b/project/prepare", { baseRevision: 4 }],
    ["/projects/b/project/cancel", { baseRevision: 4 }],
    ["/projects/c/project/export", { baseRevision: 5 }],
  ]);
  await expect(runProjectAction(projects[3], "export", fetchImpl)).rejects.toThrow("elegível");
  expect(calls).toHaveLength(4);
});

it("conflito ou falha de uma ação mantém a mensagem da rota", async () => {
  const project = { id: "p", atividade: { revision: 1, actions: { resume: true } } };
  await expect(runProjectAction(project, "resume", async () => ({ ok: false, json: async () => ({ error: "revisão desatualizada" }) }))).rejects.toThrow("revisão desatualizada");
});


it("não confirma Cancelar sem a resposta de cancelamento da operação", async () => {
  const project = { id: "p", atividade: { revision: 1, actions: { cancel: true } } };
  await expect(runProjectAction(project, "cancel", async () => ({ ok: true, json: async () => ({ operation: { stage: "ready" } }) }))).rejects.toThrow(/cancelamento/);
});

it("Limpeza usa o job persistível e as rotas existentes de Cancelar e Exportar MP4", async () => {
  const jobId = "00000000-0000-4000-8000-000000000001";
  const project = { id: "limpeza com espaço", fluxo: "limpeza", atividade: { jobId, revision: null, exportKind: "mp4", actions: { resume: false, cancel: true, export: true } } };
  const calls: Array<[string, object]> = [];
  const fetchImpl = async (url: string, init: any) => {
    calls.push([url, JSON.parse(init.body)]);
    return { ok: true, json: async () => ({ ok: true, downloadUrl: `/projects/limpeza%20com%20espa%C3%A7o/jobs/${jobId}/download/mp4` }) };
  };
  await runProjectAction(project, "export", fetchImpl);
  await runProjectAction(project, "cancel", fetchImpl);
  await expect(runProjectAction(project, "resume", fetchImpl)).rejects.toThrow("elegível");
  expect(calls).toEqual([
    [`/projects/limpeza%20com%20espa%C3%A7o/jobs/${jobId}/export`, { kind: "mp4" }],
    [`/projects/limpeza%20com%20espa%C3%A7o/jobs/${jobId}/cancel`, {}],
  ]);
});
