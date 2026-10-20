import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { blankProject } from "./assembly/routes.ts";

const cli = fileURLToPath(new URL("../index.ts", import.meta.url));

async function bootProject(parent: string, home: string) {
  const projectDir = join(parent, "projeto");
  await mkdir(projectDir);
  // Um projeto já existente só ganha índice após a reconstrução completa.
  await writeFile(join(projectDir, "project.json"), JSON.stringify(blankProject("projeto")));
  const before = (await readdir(parent)).sort();
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("porta de teste ausente");
  const port = address.port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const started = performance.now();
  const child = spawn(process.execPath, ["--experimental-strip-types", cli, "montar", "--project", projectDir, "--port", String(port)], {
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, DECUPA_NO_BROWSER: "1" },
    stdio: "ignore",
  });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  try {
    let healthy = false;
    while (performance.now() - started < 8_000 && child.exitCode === null) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) });
        await response.text();
        if (response.status === 200) { healthy = true; break; }
      } catch { /* ainda subindo */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(healthy, "--project deve servir /healthz em até 8 s").toBe(true);
    const elapsed = performance.now() - started;
    const rebuildDeadline = Date.now() + 8_000;
    while (!await stat(join(projectDir, ".decupa", "references.json")).catch(() => null)) {
      if (Date.now() >= rebuildDeadline || child.exitCode !== null) throw new Error("reconstrução do Projeto não publicou o índice");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return { elapsed, before, projectDir };
  } finally {
    child.kill("SIGTERM");
    const kill = setTimeout(() => child.kill("SIGKILL"), 8_000);
    try { await exited; } finally { clearTimeout(kill); }
  }
}

it("--project com 2.000 irmãos tem boot limitado ao projeto e não escreve no pai", async () => {
  const root = await mkdtemp(join(tmpdir(), "decupa-boot-scope-"));
  try {
    const empty = join(root, "vazio"), crowded = join(root, "cheio"), home = join(root, "home");
    await Promise.all([empty, crowded, home].map(dir => mkdir(dir)));
    // Batches limitam o I/O da preparação; o cronômetro cobre somente o boot.
    for (let offset = 0; offset < 2_000; offset += 50) {
      await Promise.all(Array.from({ length: 50 }, (_, i) => mkdir(join(crowded, `irmao-${offset + i}`))));
    }
    const siblingSha = "e".repeat(64);
    await writeFile(join(crowded, "irmao-0", "project.json"), JSON.stringify({ assembly: { sources: [{ sha256: siblingSha }] } }));
    const first = await bootProject(empty, home);
    const second = await bootProject(crowded, home);
    console.info(`boot --project: vazio=${Math.round(first.elapsed)}ms; 2000 irmãos=${Math.round(second.elapsed)}ms`);
    expect(second.elapsed).toBeLessThan(first.elapsed * 2 + 2_000);
    for (const [parent, result] of [[empty, first], [crowded, second]] as const) {
      expect((await readdir(parent)).sort(), "nenhum arquivo criado no pai").toEqual(result.before);
      expect(await stat(join(result.projectDir, ".decupa", "references.json"))).toBeTruthy();
      const snapshot = JSON.parse(await readFile(join(result.projectDir, ".decupa", "references.json"), "utf8")) as {
        entries: { owner: { projectDir: string }; resources: string[] }[];
      };
      expect(snapshot.entries.map(entry => entry.owner.projectDir)).toEqual([result.projectDir]);
      expect(snapshot.entries.flatMap(entry => entry.resources)).not.toContain(`media:${siblingSha}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
