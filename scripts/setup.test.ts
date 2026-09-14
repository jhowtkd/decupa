import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("não altera motor existente incompatível", async () => {
  const root = await mkdtemp(join(tmpdir(), "setup space "));
  const engine = join(root, "work/video-agent-kit-plugin");
  await mkdir(engine, { recursive: true });
  execFileSync("git", ["init", engine]);
  await writeFile(join(engine, "user.txt"), "preservar");
  const { installEngine } = await import("./setup.mjs");
  await expect(installEngine(root)).rejects.toThrow(/motor existente/);
  expect(await readFile(join(engine, "user.txt"), "utf8")).toBe("preservar");
});

it("instala uma vez, repete e preserva alteração posterior", async () => {
  const root = await mkdtemp(join(tmpdir(), "setup-repeat-"));
  const remote = join(root, "remote");
  await mkdir(remote);
  const git = (args: string[]) => execFileSync("git", ["-C", remote, ...args], { encoding: "utf8" });
  git(["init"]); git(["config", "user.email", "test@example.test"]); git(["config", "user.name", "Test"]);
  await writeFile(join(remote, "lexicon.txt"), "before\n");
  git(["add", "lexicon.txt"]); git(["commit", "-m", "fixture"]);
  const pin = git(["rev-parse", "HEAD"]).trim();
  await writeFile(join(remote, "lexicon.txt"), "after\n");
  const patch = git(["diff"]);
  git(["restore", "lexicon.txt"]);
  await mkdir(join(root, "scripts/engine"), { recursive: true });
  await writeFile(join(root, "scripts/engine/pt-br-lexicon.patch"), patch);
  const { installEngine } = await import("./setup.mjs");
  await installEngine(root, { pin, remote });
  await installEngine(root, { pin, remote });
  const file = join(root, "work/video-agent-kit-plugin/lexicon.txt");
  expect(await readFile(file, "utf8")).toBe("after\n");
  await writeFile(file, "my edit\n");
  await expect(installEngine(root, { pin, remote })).rejects.toThrow(/modificado/);
  expect(await readFile(file, "utf8")).toBe("my edit\n");
});

it("propaga falha do subprocesso", async () => {
  const { run } = await import("./setup.mjs");
  await expect(run(process.execPath, ["-e", "process.exit(7)"], process.cwd())).rejects.toThrow(/7/);
});
