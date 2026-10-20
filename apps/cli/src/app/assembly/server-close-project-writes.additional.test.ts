import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import { startApp } from "../server.ts";
import { resourceLedgerForProject } from "../resource-ledger.ts";
import { blankProject } from "./routes.ts";
import { fixtureAssembly } from "./fixture.ts";
import { createProject, saveProject } from "./store.ts";
import type { Executor } from "../pipeline.ts";
import type { Project, Source } from "./types.ts";

let app: Awaited<ReturnType<typeof startApp>> | undefined;
let shutdown: Promise<void> | undefined;
let releaseLedger!: () => void;
const roots: string[] = [];
afterEach(async () => {
  releaseLedger?.();
  releaseLedger = undefined!;
  if (shutdown) await shutdown.catch(() => undefined);
  else if (app) await app.close().catch(() => undefined);
  app = undefined;
  shutdown = undefined;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("runtime close waits for project.json's following ledger write", async () => {
  const dir = await mkdtemp(join(tmpdir(), "project-close-ledger-"));
  roots.push(dir);
  const sourcePath = join(dir, "source.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), sourcePath);
  const project = blankProject("close-ledger");
  project.assembly.sources = [{ ...fixtureAssembly().sources[0]!, path: sourcePath } as Source];
  await createProject(dir, project as Project);
  const executor: Executor = { async run() { return { code: 0, stdout: "", stderr: "" }; } };
  app = await startApp({ projectDir: dir, port: 0, executor });

  let reachedLedger!: () => void;
  const ledgerEntered = new Promise<void>(resolve => { reachedLedger = resolve; });
  let resume!: () => void;
  const ledgerGate = new Promise<void>(resolve => { resume = resolve; });
  releaseLedger = resume;
  const ledger = resourceLedgerForProject(dir);
  const originalSyncProject = ledger.syncProject.bind(ledger);
  let holdNextProjectSync = true;
  ledger.syncProject = async (...args: Parameters<typeof ledger.syncProject>) => {
    if (holdNextProjectSync && args[0] === dir) {
      holdNextProjectSync = false;
      reachedLedger();
      await ledgerGate;
    }
    return originalSyncProject(...args);
  };

  const save = saveProject(dir, 0, current => ({
    ...current,
    input: { ...current.input, text: "published before the ledger finishes" },
  }));
  await ledgerEntered;
  // saveProject publishes project.json before syncProject; the writer is held here.
  const { loadProject } = await import("./store.ts");
  expect((await loadProject(dir)).input.text).toBe("published before the ledger finishes");

  let closeResolved = false;
  shutdown = app.close().then(() => { closeResolved = true; });
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  expect(closeResolved).toBe(false);

  resume();
  await save;
  await shutdown;
  expect(closeResolved).toBe(true);
});
