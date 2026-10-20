import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { blankProject } from "./assembly/routes.ts";
import { createProject } from "./assembly/store.ts";
import type { HubActivityOptions } from "./hub-activity.ts";
import { projectActivity } from "./hub-activity.ts";
import { listProjectRootEntries } from "./project-root.ts";

const now = 50_000;

async function projectDir(root: string, id: string): Promise<string> {
  const dir = join(root, id);
  await mkdir(dir);
  await createProject(dir, blankProject(id, id));
  return dir;
}

it("distingue correção pendente sem alinhamento ativo do alinhamento real", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-runtime-cancellable-"));
  const correctionDir = join(root, "correction");
  await mkdir(correctionDir);
  const correction = blankProject("correction", "Correção pendente");
  correction.assembly.sources = [{
    id: "speech", name: "fala.wav", path: join(root, "fala.wav"), sha256: "b".repeat(64),
    size: 5, mtimeMs: 1, durationSeconds: 5, hasVideo: false, hasAudio: true,
    included: true, role: "speech", fps: null, width: null, height: null,
  }];
  correction.corrections = [{
    id: "pending-align", sourceId: "speech", start: 0, end: 1,
    text: "corrigida", status: "pending", words: [],
  }];
  await createProject(correctionDir, correction);

  try {
    const waitingForEditor = await projectActivity(correctionDir, "correction", "assembly", () => now, {
      runtime: async () => ({ busy: false, cancellable: false, alignmentActive: false }),
    } as HubActivityOptions);
    expect(waitingForEditor.actions.cancel).toBe(false);
    expect(waitingForEditor.text).toBe("Correção pendente · abra o Projeto para alinhar");

    const activeAlignment = await projectActivity(correctionDir, "correction", "assembly", () => now, {
      runtime: async () => ({ busy: true, cancellable: false, alignmentActive: true }),
    } as HubActivityOptions);
    expect(activeAlignment).toMatchObject({ busy: true, actions: { cancel: false } });
    expect(activeAlignment.text).not.toBe("Correção pendente · abra o Projeto para alinhar");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("não deixa waiter do mesmo Projeto ocultar o slot ativo no resumo da atividade", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-holder-plus-waiter-"));
  const dir = await projectDir(root, "same-project");
  try {
    const activity = await projectActivity(dir, "same-project", "assembly", () => now, {
      runtime: async () => undefined,
      queue: [{ projectId: "same-project", stage: "rendering", position: 1, at: now - 50 }],
      holders: [{ projectId: "same-project", stage: "transcription", startedAt: now - 300 }],
    } as unknown as HubActivityOptions);
    expect(activity).toMatchObject({
      busy: true, executing: true, queuedCount: 1, queuePosition: 1,
      stage: "Transcrever áudio", elapsedMs: 300, actions: { cancel: false },
    });
    expect(activity.text).not.toBe("Aguardando na fila");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("degrada gracefully se queue ou holders falhar e a listagem continua disponível", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-queue-unavailable-"));
  await projectDir(root, "visible-project");
  const hubActivityModule = await import("./hub-activity.ts");
  const reader = (hubActivityModule as unknown as {
    readCoordinatorActivity?: (coordinator: unknown) => Promise<Record<string, unknown>>;
  }).readCoordinatorActivity;
  expect(reader).toBeTypeOf("function");
  if (!reader) {
    await rm(root, { recursive: true, force: true });
    return;
  }
  try {
    for (const failedMethod of ["queue", "holders"] as const) {
      const coordinator = {
        queue: async () => {
          if (failedMethod === "queue") throw new Error("queue indisponível");
          return [];
        },
        holders: async () => {
          if (failedMethod === "holders") throw new Error("holders indisponível");
          return [];
        },
      };
      const activity = await reader(coordinator);
      expect(activity.queueUnavailable).toBe(true);
      const entries = await listProjectRootEntries(root, () => now, {
        runtime: async () => undefined,
        ...activity,
      } as unknown as HubActivityOptions);
      expect(entries.map((entry) => entry.id)).toContain("visible-project");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
