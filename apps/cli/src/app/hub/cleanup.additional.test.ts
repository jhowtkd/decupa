import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const renameFailure = vi.hoisted(() => ({ failAt: 0, calls: 0 }));
const purgeFailure = vi.hoisted(() => ({ enabled: false, calls: 0 }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: vi.fn(async (...args: Parameters<typeof actual.rename>) => {
      if (String(args[1]).includes("cleanup-trash")) {
        renameFailure.calls++;
        if (renameFailure.failAt !== 0 && renameFailure.calls === renameFailure.failAt) throw new Error("cleanup interrupted for boot recovery");
      }
      return actual.rename(...args);
    }),
    rm: vi.fn(async (...args: Parameters<typeof actual.rm>) => {
      const options = args[1] as { recursive?: boolean } | undefined;
      if (purgeFailure.enabled && String(args[0]).includes("cleanup-trash") && !options?.recursive) {
        purgeFailure.calls++;
        if (purgeFailure.calls === 1) throw new Error("purge interrupted after commit");
      }
      return actual.rm(...args);
    }),
  };
});

import { startApp } from "../server.ts";
import { initializeResourceLedger, mediaKey, ResourceLedger } from "../resource-ledger.ts";

const roots: string[] = [];
const executor = { async run() { return { code: 0, stdout: "", stderr: "" }; } };
const now = 50 * 86_400_000;
const sha = "d".repeat(64);
afterEach(async () => {
  renameFailure.failAt = 0; renameFailure.calls = 0;
  purgeFailure.enabled = false; purgeFailure.calls = 0;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "f4-t4-cleanup-http-")); roots.push(root);
  const projectsRoot = join(root, "projects");
  const projectDir = join(projectsRoot, "one");
  const sourcePath = join(projectDir, "imports", "source.mp4");
  await mkdir(join(projectDir, "imports"), { recursive: true });
  await writeFile(sourcePath, "source media");
  await writeFile(join(projectDir, "project.json"), JSON.stringify({
    revision: 1,
    finalApprovedRevision: 1,
    lifecycle: { state: "entregue", revision: 1, enteredAt: { entregue: now - 8 * 86_400_000 } },
    assembly: { name: "Projeto de teste", sources: [{ sha256: sha, path: sourcePath }] },
  }));
  await mkdir(join(projectDir, "exports", "1"), { recursive: true });
  await writeFile(join(projectDir, "exports", "1", "manifest.json"), JSON.stringify({ sources: { camera: sha } }));
  return { root, projectsRoot, projectDir, sourcePath };
}

async function start(projectsRoot: string) {
  return startApp({ projectsRoot, port: 0, autoStart: false, executor, now: () => now, env: {} });
}

function post(base: string, path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function rawStatus(base: string, path: string): Promise<number> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: url.hostname, port: url.port, path }, response => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.on("error", reject);
    request.end();
  });
}

it("serve a visão de limpeza, lista e plano, exige confirmação e acknowledgement, recusa plano obsoleto e confirma o plano novo", async () => {
  const f = await fixture();
  const app = await start(f.projectsRoot);
  const base = `http://127.0.0.1:${app.port}`;
  const confirmPath = "/api/cleanup/projects/one/confirm";
  try {
    const page = await fetch(`${base}/cleanup`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Limpar arquivos");
    for (const asset of ["/hub/cleanup.js", "/hub/cleanup.css"]) expect((await fetch(`${base}${asset}`)).status).toBe(200);

    const listed = await (await fetch(`${base}/api/cleanup/projects`)).json() as Array<Record<string, unknown>>;
    expect(listed).toEqual(expect.arrayContaining([expect.objectContaining({ id: "one", eligible: true, state: "elegível" })]));

    const firstPlanResponse = await fetch(`${base}/api/cleanup/projects/one/plan`);
    expect(firstPlanResponse.status).toBe(200);
    const firstPlan = await firstPlanResponse.json() as { planId: string; warning?: string };
    expect(firstPlan.warning).toMatch(/offline/i);

    const declined = await post(base, confirmPath, { planId: firstPlan.planId, confirmed: false, acknowledgeOffline: true });
    expect(declined.status).toBe(400);
    expect(await readFile(f.sourcePath, "utf8")).toBe("source media");

    const unacknowledged = await post(base, confirmPath, { planId: firstPlan.planId, confirmed: true });
    expect(unacknowledged.status).toBe(409);
    expect(await readFile(f.sourcePath, "utf8")).toBe("source media");

    await writeFile(f.sourcePath, "changed media");
    const stale = await post(base, confirmPath, { planId: firstPlan.planId, confirmed: true, acknowledgeOffline: true });
    expect(stale.status).toBe(409);
    expect(await readFile(f.sourcePath, "utf8")).toBe("changed media");

    const currentPlanResponse = await fetch(`${base}/api/cleanup/projects/one/plan`);
    expect(currentPlanResponse.status).toBe(200);
    const currentPlan = await currentPlanResponse.json() as { planId: string };
    const confirmed = await post(base, confirmPath, { planId: currentPlan.planId, confirmed: true, acknowledgeOffline: true });
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({ completed: true });
    await expect(readFile(f.sourcePath)).rejects.toMatchObject({ code: "ENOENT" });

    const cleanedPlan = await (await fetch(`${base}/api/cleanup/projects/one/plan`)).json() as { cleaned: boolean; eligible: boolean };
    expect(cleanedPlan).toMatchObject({ cleaned: true, eligible: false });
    const cleanedList = await (await fetch(`${base}/api/cleanup/projects`)).json() as Array<Record<string, unknown>>;
    expect(cleanedList).toEqual(expect.arrayContaining([expect.objectContaining({ id: "one", eligible: false })]));
  } finally {
    await app.close();
  }
});

it("rejeita traversal e diretório de Projeto simbólico na API de limpeza", async () => {
  const f = await fixture();
  const outsideDir = join(f.root, "outside-project");
  await mkdir(outsideDir, { recursive: true });
  await writeFile(join(outsideDir, "project.json"), JSON.stringify({ assembly: { sources: [] } }));
  await symlink(outsideDir, join(f.projectsRoot, "linked-project"));
  const app = await start(f.projectsRoot);
  const base = `http://127.0.0.1:${app.port}`;
  try {
    expect((await fetch(`${base}/api/cleanup/projects/linked-project/plan`)).status).toBe(404);
    expect(await rawStatus(base, "/api/cleanup/projects/%2e%2e%2foutside-project/plan")).toBe(404);
    expect(await readFile(join(outsideDir, "project.json"), "utf8")).toContain("assembly");
  } finally {
    await app.close();
  }
});

it("reconcilia a quarentena parcial no próximo boot e volta a servir referências", async () => {
  const f = await fixture();
  const journalDir = join(f.projectDir, ".decupa", "metrics");
  await mkdir(journalDir, { recursive: true });
  await writeFile(join(journalDir, "journal.jsonl"), "journal data");
  let app = await start(f.projectsRoot);
  const firstBase = `http://127.0.0.1:${app.port}`;
  let planId = "";
  try {
    const response = await fetch(`${firstBase}/api/cleanup/projects/one/plan`);
    expect(response.status).toBe(200);
    planId = ((await response.json()) as { planId: string }).planId;
    renameFailure.calls = 0;
    renameFailure.failAt = 2;
    const interrupted = await post(firstBase, "/api/cleanup/projects/one/confirm", {
      planId, confirmed: true, acknowledgeOffline: true,
    });
    expect(interrupted.status).toBe(409);
    expect(renameFailure.calls).toBe(2);
    renameFailure.failAt = 0;
    await app.close();
  } finally {
    renameFailure.failAt = 0;
    await app.close();
  }

  app = await start(f.projectsRoot);
  const nextBase = `http://127.0.0.1:${app.port}`;
  try {
    // Planning calls ledger.references after server boot recovery. Retry only while
    // the server's asynchronous boot reconciliation has not completed.
    let recovered: Response | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      recovered = await fetch(`${nextBase}/api/cleanup/projects/one/plan`);
      if (recovered.status === 200) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(recovered?.status).toBe(200);
    expect(await readFile(f.sourcePath, "utf8")).toBe("source media");
    expect(await readFile(join(journalDir, "journal.jsonl"), "utf8")).toBe("journal data");
    const resolvedPlan = await recovered!.json() as { eligible: boolean; items: { path: string }[] };
    expect(resolvedPlan.eligible).toBe(true);
    expect(resolvedPlan.items.map(item => item.path)).toContain(f.sourcePath);
  } finally {
    await app.close();
  }
});

it("termina a purga comprometida no próximo boot e mantém o Projeto limpo sem referências", async () => {
  const f = await fixture();
  let app = await start(f.projectsRoot);
  const firstBase = `http://127.0.0.1:${app.port}`;
  try {
    const planResponse = await fetch(`${firstBase}/api/cleanup/projects/one/plan`);
    expect(planResponse.status).toBe(200);
    const { planId } = await planResponse.json() as { planId: string };

    purgeFailure.calls = 0;
    purgeFailure.enabled = true;
    const interrupted = await post(firstBase, "/api/cleanup/projects/one/confirm", {
      planId, confirmed: true, acknowledgeOffline: true,
    });
    expect(interrupted.status).toBe(409);
    expect(purgeFailure.calls).toBe(1);
    expect(await readFile(f.sourcePath).catch(() => null)).toBeNull();
    purgeFailure.enabled = false;
    await app.close();
  } finally {
    purgeFailure.enabled = false;
    await app.close();
  }

  app = await start(f.projectsRoot);
  const nextBase = `http://127.0.0.1:${app.port}`;
  try {
    let recovered: Response | undefined;
    let state: { cleaned: boolean; eligible: boolean } | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      recovered = await fetch(`${nextBase}/api/cleanup/projects/one/plan`);
      if (recovered.status === 200) {
        state = await recovered.json() as { cleaned: boolean; eligible: boolean };
        if (state.cleaned) break;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(state).toMatchObject({ cleaned: true, eligible: false });
    await expect(readFile(f.sourcePath)).rejects.toMatchObject({ code: "ENOENT" });

    const ledger = await initializeResourceLedger({ root: f.projectsRoot, projectsRoot: f.projectsRoot, now: () => now, env: {} });
    expect(await ledger.references(mediaKey(sha))).toHaveLength(0);
    const listing = await (await fetch(`${nextBase}/api/cleanup/projects`)).json() as Array<Record<string, unknown>>;
    expect(listing).toEqual(expect.arrayContaining([expect.objectContaining({ id: "one", eligible: false })]));
  } finally {
    await app.close();
  }
});

it("reconcilia o ledger uma vez ao listar vinte Projetos", async () => {
  const root = await mkdtemp(join(tmpdir(), "f4-t4-cleanup-list-")); roots.push(root);
  const projectsRoot = join(root, "projects");
  await mkdir(projectsRoot, { recursive: true });
  for (let i = 0; i < 20; i++) {
    const dir = join(projectsRoot, `project-${String(i).padStart(2, "2")}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "project.json"), JSON.stringify({ revision: 1, assembly: { sources: [] } }));
  }

  const originalReconcile = ResourceLedger.prototype.reconcile;
  let finishBoot!: () => void;
  const bootFinished = new Promise<void>(resolve => { finishBoot = resolve; });
  let bootResolved = false;
  const reconcileSpy = vi.spyOn(ResourceLedger.prototype, "reconcile").mockImplementation(
    async function (this: ResourceLedger, ...args: Parameters<ResourceLedger["reconcile"]>) {
      try {
        return await originalReconcile.apply(this, args);
      } finally {
        if (!bootResolved) { bootResolved = true; finishBoot(); }
      }
    },
  );
  const app = await start(projectsRoot);
  const base = `http://127.0.0.1:${app.port}`;
  try {
    await bootFinished;
    reconcileSpy.mockClear();
    const response = await fetch(`${base}/api/cleanup/projects`);
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveLength(20);
    expect(reconcileSpy).toHaveBeenCalledTimes(1);
  } finally {
    reconcileSpy.mockRestore();
    await app.close();
  }
});
