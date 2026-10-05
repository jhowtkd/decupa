import { spawn, type ChildProcess } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { FIXTURES } from "../../../tests/fixtures/global-setup.ts";

const ROOT = dirname(fileURLToPath(new URL("../../../package.json", import.meta.url)));

function vivo(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function portaLivre(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function filhoNaoSobreviveAoSinal(
  sinal: "SIGHUP" | "SIGTERM",
  ignoraSinais: boolean,
  cancelaAntes = false,
): Promise<void> {
  // ffmpeg/ffprobe/uv falsos: -version sai na hora (preflight), pcm_s16le também
  // (extração via execFile, que o shutdown não alcança). O resto grava o pid
  // e dorme — o proxy detached nasce no primeiro GET e o SIGHUP tem de matá-lo.
  const tmp = await mkdtemp(join(tmpdir(), "cli-sighup-"));
  const input = join(tmp, "clip.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), input);
  const home = join(tmp, "home");
  await mkdir(join(home, ".decupa"), { recursive: true });
  await writeFile(join(home, ".decupa", "credentials"), JSON.stringify({ preset: "zai", apiKey: "k" }));
  const engine = join(tmp, "engine");
  const tools = join(engine, "mcp", "ve_tools");
  await mkdir(tools, { recursive: true });
  await writeFile(join(tools, "condense.py"), "#\n");
  await writeFile(join(tools, "condense_lang.py"), '_TERMINAL_PUNCT = ".!?"\nFILLERS_SOFT_PT = ["tipo"]\n');
  const bin = join(tmp, "bin");
  await mkdir(bin);
  const pidFile = join(tmp, "pids");
  await writeFile(pidFile, "");
  const script = `#!/bin/sh
name=$(basename "$0")
if [ "$name" = "open" ] || [ "$name" = "xdg-open" ]; then exit 0; fi
case "$*" in
  *-version*) exit 0 ;;
  *pcm_s16le*) exit 0 ;;
esac
${ignoraSinais ? "trap '' TERM HUP INT\n" : ""}echo $$ >> "$DECUPA_FAKE_PIDS"
${ignoraSinais ? "while :; do sleep 1; done" : "exec sleep 60"}
`;
  for (const name of ["ffmpeg", "ffprobe", "uv", "open", "xdg-open"]) {
    const path = join(bin, name);
    await writeFile(path, script, "utf8");
    await chmod(path, 0o755);
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "path" || /key|token|secret|password|credential/i.test(key)) delete env[key];
  }
  // O binário falso vem primeiro. /bin fica no PATH só para `sleep` e
  // `basename`: sem eles o script morre na hora e o pid gravado já está morto.
  env.PATH = [bin, "/bin", "/usr/bin", dirname(process.execPath)].join(delimiter);
  env.HOME = home;
  env.USERPROFILE = home;
  env.DECUPA_FAKE_PIDS = pidFile;
  env.VE_PLUGIN_ROOT = engine;

  const port = await portaLivre();
  const child = spawn(process.execPath, [
    "--experimental-strip-types", join(ROOT, "apps/cli/src/index.ts"),
    "limpar", "--input", input, "--port", String(port),
  ], { cwd: ROOT, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let saida = "";
  child.stdout!.on("data", (chunk) => { saida += String(chunk); });
  child.stderr!.on("data", (chunk) => { saida += String(chunk); });
  const saiu = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  try {
    // O ingest (e o ffmpeg detached do proxy) só nasce no primeiro GET.
    const subiu = Date.now() + 15_000;
    let pagina = 0;
    let html = "";
    while (Date.now() < subiu && child.exitCode === null) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) });
        pagina = res.status;
        if (pagina === 200) { html = await res.text(); break; }
      } catch { /* ainda subindo */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(pagina, saida).toBe(200);

    const limite = Date.now() + 10_000;
    let pids: number[] = [];
    while (Date.now() < limite && child.exitCode === null) {
      const texto = await readFile(pidFile, "utf8").catch(() => "");
      pids = [...new Set(texto.split("\n").map((line) => Number(line.trim())).filter((n) => n > 0))].filter(vivo);
      if (pids.length >= 1) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    // Pid já morto no arquivo não prova nada: o filho tem de estar vivo
    // no instante do SIGHUP. No código anterior ele continua depois.
    expect(pids, `nenhum filho vivo; saída:\n${saida}`).not.toEqual([]);
    if (cancelaAntes) {
      // /cancel chama killAll e esvazia a lista do executor; o shutdown que
      // vem logo depois ainda tem de esperar o grupo que ignora TERM.
      const jobId = /get\("job"\)\s*\|\|\s*("(?:[^"\\]|\\.)*")/.exec(html)?.[1];
      expect(jobId, `sem __JOB__ no HTML:\n${html.slice(0, 300)}`).toBeDefined();
      const res = await fetch(`http://127.0.0.1:${port}/jobs/${JSON.parse(jobId!) as string}/cancel`, { method: "POST" });
      expect(res.status, saida).toBeLessThan(300);
    }
    process.kill(child.pid!, sinal);
    const mortos = Date.now() + 8_000;
    let vivos = pids.filter(vivo);
    while (vivos.length > 0 && Date.now() < mortos) {
      await new Promise((r) => setTimeout(r, 200));
      vivos = pids.filter(vivo);
    }
    // No código anterior o SIGHUP mata o CLI e o filho detached fica.
    expect(vivos, `filho sobreviveu ao ${sinal}: ${vivos.join(",")}\n${saida}`).toEqual([]);
    const code = await Promise.race([
      saiu,
      new Promise<number | null>((resolve) => setTimeout(() => resolve(child.exitCode), 8_000)),
    ]);
    expect(code, saida).toBe(0);
  } finally {
    if (child.pid && vivo(child.pid)) {
      try { process.kill(child.pid, "SIGKILL"); } catch { /* saiu */ }
    }
    const texto = await readFile(pidFile, "utf8").catch(() => "");
    for (const pid of texto.split("\n").map((line) => Number(line.trim())).filter((n) => n > 0)) {
      // Grupo inteiro: o filho detached é líder, e o `sleep` do laço é do grupo.
      try { process.kill(-pid, "SIGKILL"); } catch { /* saiu */ }
      try { process.kill(pid, "SIGKILL"); } catch { /* saiu */ }
    }
    await rm(tmp, { recursive: true, force: true });
  }
}

it.skipIf(process.platform === "win32")("SIGHUP no CLI não deixa filho vivo", () =>
  filhoNaoSobreviveAoSinal("SIGHUP", false), 40_000);

// Filho com `trap '' TERM`: o shutdown não pode chamar process.exit logo
// depois do SIGTERM ignorado; tem de esperar o grupo sumir (SIGKILL após ~2 s).
it.skipIf(process.platform === "win32").each(["SIGHUP", "SIGTERM"] as const)(
  "%s no CLI não deixa vivo o filho que ignora SIGTERM",
  (sinal) => filhoNaoSobreviveAoSinal(sinal, true),
  40_000,
);

it.skipIf(process.platform === "win32")(
  "/cancel seguido de SIGHUP não deixa vivo o filho que ignora SIGTERM",
  () => filhoNaoSobreviveAoSinal("SIGHUP", true, true),
  40_000,
);

it("montar numa porta ocupada diz qual porta usar", async () => {
  const holder = createServer();
  await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
  const port = (holder.address() as AddressInfo).port;
  const tmp = await mkdtemp(join(tmpdir(), "cli-porta-"));
  const home = join(tmp, "home");
  await mkdir(home);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "path" || /key|token|secret|password|credential/i.test(key)) delete env[key];
  }
  env.PATH = tmp;
  env.HOME = home;
  env.USERPROFILE = home;
  const child: ChildProcess = spawn(process.execPath, [
    "--experimental-strip-types", join(ROOT, "apps/cli/src/index.ts"),
    "montar", "--project", tmp, "--port", String(port),
  ], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
  child.stdout!.on("data", () => {});
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`não saiu\n${stderr}`)), 20_000);
      child.once("exit", (status) => { clearTimeout(timer); resolve(status); });
    });
    expect(stderr).toContain(`porta ${port} ocupada; use --port`);
    expect(code).toBe(1);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await new Promise<void>((resolve) => holder.close(() => resolve()));
    await rm(tmp, { recursive: true, force: true });
  }
}, 30_000);
