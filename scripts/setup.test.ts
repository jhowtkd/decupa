import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";

async function fixture(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  // Em macOS o tmpdir vive sob /var -> /private/var; os caminhos retornados
  // por findNpmCli seguem o realpath, então as expectativas usam realRoot.
  const realRoot = await realpath(root);
  const create = async (path: string, content = "") => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  };
  return { root, realRoot, create };
}

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
  expect((await readFile(file, "utf8")).replace(/\r\n/g, "\n")).toBe("after\n");
  await writeFile(file, "my edit\n");
  await expect(installEngine(root, { pin, remote })).rejects.toThrow(/modificado/);
  expect(await readFile(file, "utf8")).toBe("my edit\n");
});

it("propaga falha do subprocesso", async () => {
  const { run } = await import("./setup.mjs");
  await expect(run(process.execPath, ["-e", "process.exit(7)"], process.cwd())).rejects.toThrow(/7/);
});

it("findNpmCli: layout Homebrew Cellar (bin + libexec/lib)", async () => {
  const { root, realRoot, create } = await fixture("npm-cellar-");
  const nodeExe = join(root, "bin/node");
  await create(nodeExe);
  const cli = join(realRoot, "libexec/lib/node_modules/npm/bin/npm-cli.js");
  await create(cli);
  const { findNpmCli } = await import("./setup.mjs");
  expect(await findNpmCli(nodeExe)).toBe(cli);
});

it("findNpmCli: layout Unix clássico (bin + lib)", async () => {
  const { root, realRoot, create } = await fixture("npm-unix-");
  const nodeExe = join(root, "bin/node");
  await create(nodeExe);
  const cli = join(realRoot, "lib/node_modules/npm/bin/npm-cli.js");
  await create(cli);
  const { findNpmCli } = await import("./setup.mjs");
  expect(await findNpmCli(nodeExe)).toBe(cli);
});

it("findNpmCli: symlink npm irmão resolvendo para npm-cli.js em outro lugar", async () => {
  const { root, realRoot, create } = await fixture("npm-sibling-");
  const nodeExe = join(root, "bin/node");
  await create(nodeExe);
  await create(join(root, "share/npm-pkg/bin/npm-cli.js"));
  await symlink(join(root, "share/npm-pkg/bin/npm-cli.js"), join(root, "bin/npm"));
  const { findNpmCli } = await import("./setup.mjs");
  expect(await findNpmCli(nodeExe)).toBe(join(realRoot, "share/npm-pkg/bin/npm-cli.js"));
});

it("findNpmCli: rejeita npm irmão que não aponta para npm-cli.js", async () => {
  const { root, create } = await fixture("npm-shell-");
  const nodeExe = join(root, "bin/node");
  await create(nodeExe);
  await create(join(root, "bin/npm"), "#!/bin/sh\nexec node npm-cli.js \"$@\"\n");
  const { findNpmCli } = await import("./setup.mjs");
  expect(await findNpmCli(nodeExe)).toBeNull();
});

it("findNpmCli: usa também o diretório do execPath sem realpath", async () => {
  const { root, create } = await fixture("npm-linkdir-");
  const realNode = join(root, "Cellar/node/bin/node");
  await create(realNode);
  await mkdir(join(root, "bin"), { recursive: true });
  const nodeExe = join(root, "bin/node");
  await symlink(realNode, nodeExe);
  // Candidato existe apenas sob o diretório do symlink (/opt/homebrew/bin),
  // não sob o diretório realpath'ado (Cellar).
  const cli = join(root, "lib/node_modules/npm/bin/npm-cli.js");
  await create(cli);
  const { findNpmCli } = await import("./setup.mjs");
  expect(await findNpmCli(nodeExe)).toBe(cli);
});

it("findNpmCli: lib vence libexec no mesmo diretório", async () => {
  const { root, realRoot, create } = await fixture("npm-order-");
  const nodeExe = join(root, "bin/node");
  await create(nodeExe);
  const lib = join(realRoot, "lib/node_modules/npm/bin/npm-cli.js");
  await create(lib);
  await create(join(realRoot, "libexec/lib/node_modules/npm/bin/npm-cli.js"));
  const { findNpmCli } = await import("./setup.mjs");
  expect(await findNpmCli(nodeExe)).toBe(lib);
});

it("findNpmCli: nada encontrável retorna null sem lançar", async () => {
  const { root, create } = await fixture("npm-none-");
  const nodeExe = join(root, "bin/node");
  await create(nodeExe);
  const { findNpmCli } = await import("./setup.mjs");
  expect(await findNpmCli(nodeExe)).toBeNull();
});
