import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { summarizeReuseJournals } from "./index.ts";

const roots: string[] = [];
const hash = (char: string): string => char.repeat(64);

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function project(root: string, name: string, contents: string): Promise<void> {
  const dir = join(root, name, ".decupa", "metrics");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "operation.jsonl"), contents);
}

function event(atMs: number, outcome: string, durationMs: number, configKey = hash("b"), stage = "analysis", sha256 = hash("a")): string {
  return JSON.stringify({ kind: "cache", atMs, data: { stage, sha256, configKey, outcome, durationMs } });
}

it("separa configurações e conta sucessos por projeto, sem transformar hits repetidos em builds", async () => {
  const root = await mkdtemp(join(tmpdir(), "reuse-groups-"));
  roots.push(root);
  await project(root, "first", [
    event(50, "hit", 0), event(30, "hit", 0), event(20, "built", 700),
    event(60, "built", 990), // rebuild dentro do mesmo projeto não economizaria entre projetos
    event(70, "hit", 0, hash("c")),
  ].join("\n") + "\n");
  await project(root, "second", [
    event(10, "built", 1200), // linha anterior, mas atMs anterior: é o primeiro projeto de sucesso
    event(80, "built", 1300),
    event(90, "hit", 0, hash("c")),
  ].join("\n") + "\n");
  await project(root, "third", event(100, "hit-or-shared", 0) + "\n");

  const result = await summarizeReuseJournals(root);
  const primary = result.groups.find(group => group.configKey === hash("b"))!;
  expect(primary).toMatchObject({ projects: 3, builds: 4, hits: 3, reuseOpportunities: 2, redundantBuilds: 1, estimatedSavingsMs: 700 });
  expect(result.groups.find(group => group.configKey === hash("c"))).toMatchObject({ projects: 2, reuseOpportunities: 1, redundantBuilds: 0 });
  expect(result.reusableDerivatives).toBe(2);
  expect(result.reuseOpportunities).toBe(3);
  expect(result.redundantBuilds).toBe(1);
  expect(result.estimatedSavingsMs).toBe(700);
});

it("não credita erros como reuso e isola chaves visuais que codificam janelas diferentes", async () => {
  const root = await mkdtemp(join(tmpdir(), "reuse-identity-"));
  roots.push(root);
  await project(root, "one", [event(1, "error", 500), event(2, "built", 100, hash("d"), "visual")].join("\n") + "\n");
  await project(root, "two", event(3, "built", 200, hash("e"), "visual") + "\n");
  await project(root, "three", event(4, "not-applicable", 800, hash("d"), "visual") + "\n");

  const result = await summarizeReuseJournals(root);
  expect(result).toMatchObject({ reusableDerivatives: 0, reuseOpportunities: 0, redundantBuilds: 0, estimatedSavingsMs: 0 });
  expect(result.groups).toHaveLength(3);
  expect(result.groups.find(group => group.configKey === hash("d"))).toMatchObject({ stage: "visual", projects: 1, builds: 1, errors: 0, unmeasuredBuilds: 0 });
  expect(result.groups.find(group => group.configKey === hash("e"))).toMatchObject({ projects: 1, reuseOpportunities: 0 });
  expect(result.groups.find(group => group.stage === "analysis")).toMatchObject({ projects: 0, builds: 0, errors: 1, reuseOpportunities: 0 });
});

it("tolera truncamento e linhas malformadas, ignora diretórios e journals via symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "reuse-malformed-"));
  roots.push(root);
  await project(root, "normal", `${event(1, "built", 50)}\n{"kind":"cache","atMs":`);
  const target = join(root, "normal", ".decupa", "metrics", "operation.jsonl");
  await symlink(join(root, "normal"), join(root, "linked-project"), "dir");
  const linkedDir = join(root, "another", ".decupa", "metrics");
  await mkdir(linkedDir, { recursive: true });
  await symlink(target, join(linkedDir, "linked-journal.jsonl"));

  const result = await summarizeReuseJournals(root);
  expect(result).toMatchObject({ journalsScanned: 1, malformedLines: 1, reusableDerivatives: 0 });
  expect(result.groups).toHaveLength(1);
});

it("ignora eventos antigos sem identidade e não segue journals symlinkados", async () => {
  const root = await mkdtemp(join(tmpdir(), "reuse-unreadable-"));
  roots.push(root);
  await project(root, "legacy", JSON.stringify({ kind: "cache", atMs: 1, data: { stage: "analysis", outcome: "built" } }) + "\n");
  const dir = join(root, "broken", ".decupa", "metrics");
  await mkdir(dir, { recursive: true });
  // Dangling journal symlinks are skipped as links; the legacy event is the only ignored cache event.
  await symlink(join(root, "missing.jsonl"), join(dir, "dangling.jsonl"));
  const result = await summarizeReuseJournals(root);
  expect(result).toMatchObject({ ignoredCacheEvents: 1, unreadableJournals: 0, reusableDerivatives: 0 });
});
