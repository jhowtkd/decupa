// PR 6: o DRP é servido por revisão (project/resolve-drp/<rev>) e a prévia de
// uma revisão antiga nunca libera aprovação nem exportação da revisão nova.
// A regra pura de approveFinal/exportApproved já é coberta em revisions.test.ts
// ("recusa proposta obsoleta e prévia atrasada") e export.test.ts ("recusa export
// com aprovação final desatualizada"); aqui ficam as rotas, que é o que o
// studio usa.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { startApp } from "../server.ts";
import type { DeliveryRecord } from "./delivery.ts";
import { blankProject } from "./routes.ts";
import { createProject } from "./store.ts";
import type { Project } from "./types.ts";

let stop: (() => Promise<void>) | null = null;
afterEach(async () => { await stop?.(); stop = null; });

async function boot(over: Partial<Project>) {
  const dir = await mkdtemp(join(tmpdir(), "assembly-revisao-"));
  const project = { ...blankProject("p"), ...over } as Project;
  await createProject(dir, project);
  const app = await startApp({ projectDir: dir, port: 0 });
  stop = app.close;
  return { dir, base: `http://127.0.0.1:${app.port}` };
}

async function registra(dir: string, revision: number, extra: Partial<DeliveryRecord> = {}, conteudo?: string) {
  const raiz = join(dir, "deliveries", String(revision));
  await mkdir(raiz, { recursive: true });
  let drpPath: string | undefined;
  if (conteudo !== undefined) {
    // A ponte grava o .drp na pasta da entrega da revisão; a rota só serve de lá.
    drpPath = join(raiz, `projeto-r${revision}.drp`);
    await writeFile(drpPath, conteudo);
  }
  const record: DeliveryRecord = {
    operationId: `op-${revision}`, revision, assemblySha256: "a".repeat(64), status: "ready",
    stage: "ready", projectName: `p-r${revision}`, pid: process.pid, ...(drpPath ? { drpPath } : {}), ...extra,
  };
  await writeFile(join(raiz, "resolve-delivery.json"), JSON.stringify(record));
}

const post = (base: string, path: string, body: unknown) => fetch(`${base}${path}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

it("resolve-drp/<rev> serve o DRP daquela revisão, nunca o da atual", async () => {
  const { dir, base } = await boot({ revision: 6, previewRevision: 6, finalApprovedRevision: 6 });
  await registra(dir, 5, {}, "drp-da-5");
  await registra(dir, 6, {}, "drp-da-6");
  const r5 = await fetch(`${base}/project/resolve-drp/5`);
  expect(r5.status).toBe(200);
  expect(await r5.text()).toBe("drp-da-5");
  const r6 = await fetch(`${base}/project/resolve-drp/6`);
  expect(r6.status).toBe(200);
  expect(await r6.text()).toBe("drp-da-6");
});

it("sem revisão na rota (legacy) continua servindo o DRP da revisão atual", async () => {
  const { dir, base } = await boot({ revision: 6, previewRevision: 6, finalApprovedRevision: 6 });
  await registra(dir, 5, {}, "drp-da-5");
  await registra(dir, 6, {}, "drp-da-6");
  const res = await fetch(`${base}/project/resolve-drp`);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("drp-da-6");
});

it("resolve-drp/<rev> responde 404 sem entrega, sem drpPath, com revisão inválida ou caminho extra", async () => {
  const { dir, base } = await boot({ revision: 6, previewRevision: 6, finalApprovedRevision: 6 });
  await registra(dir, 5, {}, "drp-da-5");
  await registra(dir, 4); // entrega registrada, mas sem DRP
  await registra(dir, 3, { revision: 9 }, "drp-de-outra"); // registro de outra revisão na pasta da 3
  const status = async (rota: string) => (await fetch(`${base}/project/${rota}`)).status;
  expect(await status("resolve-drp/7")).toBe(404); // revisão sem entrega
  expect(await status("resolve-drp/4")).toBe(404); // registro sem drpPath
  expect(await status("resolve-drp/3")).toBe(404); // registro que não é da revisão pedida
  expect(await status("resolve-drp/abc")).toBe(404);
  expect(await status("resolve-drp/-1")).toBe(404);
  expect(await status("resolve-drp/5x")).toBe(404);
  expect(await status("resolve-drp/5/extra")).toBe(404);
  expect(await status("resolve-drp")).toBe(404); // a atual (6) não tem entrega
  expect(await status("resolve-drp/5")).toBe(200); // controle: a rota válida segue de pé
});

const artefato = (revision: number) => ({ revision, assemblySha256: "a".repeat(64), relativePath: "p.mp4", sha256: "b".repeat(64) });

it("approve-final recusa prévia de revisão anterior e watchedRevision diferente da atual", async () => {
  const { base } = await boot({ revision: 2, previewRevision: 1, previewArtifact: artefato(1), finalApprovedRevision: null });
  // Prévia antiga: nem declarando a revisão atual nem a da prévia a aprovação passa.
  expect((await post(base, "/project/approve-final", { baseRevision: 2, watchedRevision: 2 })).status).toBe(409);
  expect((await post(base, "/project/approve-final", { baseRevision: 2, watchedRevision: 1 })).status).toBe(409);
  const aprovada = await fetch(`${base}/project`).then((r) => r.json()) as { project: { finalApprovedRevision: number | null } };
  expect(aprovada.project.finalApprovedRevision).toBeNull();

  // Prévia atual, mas assistida de outra revisão: recusa com 400.
  const atual = await boot({ revision: 2, previewRevision: 2, previewArtifact: artefato(2), finalApprovedRevision: null });
  expect((await post(atual.base, "/project/approve-final", { baseRevision: 2, watchedRevision: 1 })).status).toBe(400);
});

it("export recusa quando só uma revisão anterior foi aprovada", async () => {
  const { base } = await boot({ revision: 2, previewRevision: 1, previewArtifact: artefato(1), finalApprovedRevision: 1 });
  const res = await post(base, "/project/export", { baseRevision: 2 });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error?: string }).error ?? "").toMatch(/aprovação final/);
});
