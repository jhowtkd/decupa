import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { blankProject } from "./assembly/routes.ts";
import { createProject } from "./assembly/store.ts";
import { projectActivity } from "./hub-activity.ts";

it("Retomar no Hub preserva a confirmação de substituição das cenas editadas", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hub-edited-scenes-"));
  const p = blankProject("p");
  p.assembly.sources = [{ id: "s", name: "fala", path: join(dir, "fala.wav"), sha256: "a".repeat(64), durationSeconds: 1, hasVideo: false, hasAudio: true, role: "speech", included: true, fps: null, width: null, height: null }];
  p.revision = 3; p.preparedRevision = 2;
  p.scenes = [{ id: "manual", objective: "Edição manual", rationale: "", speechIds: [], visualEvidenceIds: [], takes: [], support: [], gaps: [] }];
  p.preparation = { id: "prep", revision: 2, mode: "prepare", request: "", status: "attention", stage: "preview", sources: {} };
  await createProject(dir, p);
  try {
    const activity = await projectActivity(dir, "p", "assembly", Date.now, {});
    expect(activity.actions.resume).toBe(false);
    expect(activity.notice).toMatch(/Projeto|editor/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("um waiter observado não habilita Cancelar e seu tempo não vem de uma operação antiga", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hub-foreign-waiter-"));
  await mkdir(join(dir, "out"));
  await createProject(dir, blankProject("p"));
  try {
    const activity = await projectActivity(dir, "p", "assembly", () => 20_000, {
      runtime: async () => ({ busy: false, operation: { stage: "ready" }, startedAt: 1_000 }),
      queue: [{ projectId: "p", stage: "visual", position: 1, at: 19_000 }],
    });
    expect(activity.busy).toBe(true);
    expect(activity.actions.cancel).toBe(false);
    expect(activity.elapsedMs).toBe(1_000);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
