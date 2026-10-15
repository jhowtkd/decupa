import { spawn } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "index.ts");

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

async function waitForHealth(port: number, output: string[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) });
      if (response.status === 200) return;
    } catch { /* o processo ainda está subindo */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`serve não subiu; saída:\n${output.join("")}`);
}

it("decupa serve sobe a Raiz sem abrir Projeto inicial", async () => {
  const home = await mkdtemp(join(tmpdir(), "decupa-serve-home-"));
  const projectsRoot = join(home, "projects");
  const port = await freePort();
  const output: string[] = [];
  const child = spawn(process.execPath, ["--experimental-strip-types", CLI, "serve", "--projects-root", projectsRoot, "--port", String(port)], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      DECUPA_AUTH_PASSWORD: "",
      DECUPA_BIND_HOST: "127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Registrado já no spawn: se o processo sair antes do healthcheck (porta tomada,
  // erro de subida), a limpeza não fica esperando um evento que já passou.
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  child.stdout.on("data", chunk => output.push(String(chunk)));
  child.stderr.on("data", chunk => output.push(String(chunk)));
  try {
    await waitForHealth(port, output);
    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Nenhum Projeto");
    expect(output.join("")).toContain("servidor na Raiz de Projetos");
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await closed;
    await rm(home, { recursive: true, force: true });
  }
});
