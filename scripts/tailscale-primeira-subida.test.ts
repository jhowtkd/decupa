import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts/tailscale-primeira-subida.sh");
const FIXTURE_ENV = [
  "DECUPA_AUTH_PASSWORD=Senha-Ficticia-123",
  "DECUPA_TAILSCALE_AUTHKEY=tskey-auth-Ficticia-123",
  "DECUPA_TAILSCALE_HOSTNAME=decupa",
  "DECUPA_DOMAIN=decupa.falso.ts.net",
  "COMPOSE_FILE=docker-compose.yml:docker-compose.tailscale.yml",
  "",
].join("\n");

const PATH_TOOLS = ["cat", "chmod", "dirname", "grep", "head", "install", "mktemp", "rm", "sed", "seq", "sleep", "stat", "tail"];
const linuxIt = it.skipIf(process.platform !== "linux");

type RunResult = { code: number | null; output: string; root: string; calls: string };

async function fixture(envText = FIXTURE_ENV, mode = 0o600): Promise<{ root: string; pathDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "decupa-tailscale-wizard-"));
  const pathDir = join(root, "isolated-bin");
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "docker/tailscale"), { recursive: true });
  await mkdir(pathDir);
  await copyFile(SCRIPT, join(root, "scripts/tailscale-primeira-subida.sh"));
  await writeFile(join(root, "docker-compose.tailscale.yml"), "# fixture\n");
  await writeFile(join(root, "docker/tailscale/serve.json"), "{}\n");
  await writeFile(join(root, ".env.example"), "# fixture\n");
  await writeFile(join(root, ".env"), envText, { mode });
  await chmod(join(root, ".env"), mode);
  for (const tool of PATH_TOOLS) {
    await symlink(`/usr/bin/${tool}`, join(pathDir, tool));
  }
  await writeFile(join(pathDir, "docker"), `#!/bin/bash
printf '%s\\n' "$*" >> "$DOCKER_CALLS"
if [[ "$1" == info ]]; then exit 0; fi
if [[ "$1" == ps ]]; then
  if [[ "\${FAKE_DOCKER_RUNNING:-}" == yes ]]; then printf 'decupa-caddy Up\n'; fi
  exit 0
fi
if [[ "$1" == volume ]]; then
  if [[ "\${FAKE_VOLUME_EXISTS:-}" == yes ]]; then exit 0; fi
  exit 1
fi
if [[ "$1" == compose ]]; then
  shift
  case " $* " in
    *" version "*) printf 'Docker Compose fixture\\n';;
    *" exec -T tailscale tailscale serve status"*) printf 'https://decupa-1.falso.ts.net (tailnet only)\\n';;
    *) :;;
  esac
  exit 0
fi
exit 0
`, "utf8");
  await chmod(join(pathDir, "docker"), 0o700);
  await writeFile(join(pathDir, "tailscale"), "#!/bin/bash\nexit 97\n", "utf8");
  await chmod(join(pathDir, "tailscale"), 0o700);
  return { root, pathDir };
}

async function fixtureWithEnvSymlink(mode: number): Promise<{ root: string; pathDir: string; target: string; contents: string }> {
  const contents = FIXTURE_ENV.replace("DECUPA_DOMAIN=decupa.falso.ts.net\n", "");
  const { root, pathDir } = await fixture(contents, mode);
  const envFile = join(root, ".env");
  const target = join(root, ".env-target");
  await rename(envFile, target);
  await symlink(".env-target", envFile);
  return { root, pathDir, target, contents };
}

async function runWizard(root: string, pathDir: string, answers: string[], extra: Record<string, string> = {}): Promise<RunResult> {
  const calls = join(root, "docker-calls.log");
  const child = spawn("/bin/bash", [join(root, "scripts/tailscale-primeira-subida.sh")], {
    cwd: root,
    env: { PATH: pathDir, HOME: root, TMPDIR: root, DOCKER_CALLS: calls, ...extra },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
  child.stdin.end(answers.join("\n") + "\n");
  const code = await new Promise<number | null>((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`wizard demorou demais; saída: ${output}`));
    }, 5_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (status) => { clearTimeout(timer); resolveExit(status); });
  });
  let dockerCalls = "";
  try { dockerCalls = await readFile(calls, "utf8"); } catch { /* sem chamadas */ }
  return { code, output, root, calls: dockerCalls };
}

async function cleanup(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

linuxIt.each([
  ["apóstrofo", "Senha-Com'Apostrofo-123"],
  ["barra invertida", "Senha-Com\\Barra-123"],
])("recusa senha com %s antes de gravar e mantém o segredo fora da saída", async (_kind, rejectedSecret) => {
  const { root, pathDir } = await fixture(FIXTURE_ENV.replace("Senha-Ficticia-123", "troque-esta-senha"));
  const valid = "Senha-Valida-Ficticia-123";
  try {
    const answers = ["", "", rejectedSecret, rejectedSecret, valid, valid, "", "", "decupa.falso.ts.net", "", "", "", "", "n"];
    const result = await runWizard(root, pathDir, answers);
    const env = await readFile(join(root, ".env"), "utf8");
    expect(result.output).toMatch(/não pode conter apóstrofo/);
    expect(env).toContain(valid);
    expect(env).not.toContain(rejectedSecret);
    expect(result.output).not.toContain(rejectedSecret);
    expect(result.output).not.toContain(valid);
    expect(result.calls).not.toContain(valid);
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/Parei antes do build/);
    expect(result.calls).not.toMatch(/compose build/);
  } finally { await cleanup(root); }
});

linuxIt.each([
  ["apóstrofo", "Senha-Com'Apostrofo-123"],
  ["barra invertida", "Senha-Com\\Barra-123"],
])("não grava senha com %s quando não há fallback válido", async (_kind, rejectedSecret) => {
  const initialEnv = FIXTURE_ENV.replace("Senha-Ficticia-123", "troque-esta-senha");
  const { root, pathDir } = await fixture(initialEnv);
  try {
    // Antes da correção, a segunda tentativa é lida como confirmação da primeira
    // e acaba gravada. Com a validação, ambas são recusadas e EOF interrompe o
    // wizard antes da primeira gravação.
    const result = await runWizard(root, pathDir, ["", "", rejectedSecret, rejectedSecret]);
    expect(await readFile(join(root, ".env"), "utf8")).toBe(initialEnv);
    expect(result.output).toMatch(/não pode conter apóstrofo/);
    expect(result.output).not.toContain(rejectedSecret);
    expect(result.code).toBe(1);
  } finally { await cleanup(root); }
});

linuxIt("recusa authkey fora de tskey-[A-Za-z0-9-]+ e persiste apenas a chave válida", async () => {
  const { root, pathDir } = await fixture(FIXTURE_ENV.replace("tskey-auth-Ficticia-123", ""));
  const invalid = "tskey-auth-INVALID_under_score";
  const valid = "tskey-auth-Ficticia-456";
  try {
    const result = await runWizard(root, pathDir, ["", "", "", "", "decupa.falso.ts.net", "", "", invalid, valid, "", "n"]);
    const env = await readFile(join(root, ".env"), "utf8");
    expect(result.output).toMatch(/seguida só de letras, números e hífen/);
    expect(env).toContain(valid);
    expect(env).not.toContain(invalid);
    expect(result.output).not.toContain(invalid);
    expect(result.output).not.toContain(valid);
    expect(result.calls).not.toContain(valid);
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/Parei antes do build/);
    expect(result.calls).not.toMatch(/compose build/);
  } finally { await cleanup(root); }
});

linuxIt("avisa sobre .env 644 e corrige para 600 quando aceito", async () => {
  const { root, pathDir } = await fixture(FIXTURE_ENV, 0o644);
  try {
    const result = await runWizard(root, pathDir, ["", "y", "", "", "decupa.falso.ts.net", "", "", "", "", "n"]);
    expect(result.output).toMatch(/644|permiss|chmod 600/i);
    const info = await stat(join(root, ".env"));
    expect(info.mode & 0o777).toBe(0o600);
  } finally { await cleanup(root); }
});

linuxIt("aceita s para chmod 600 do .env", async () => {
  const { root, pathDir } = await fixture(FIXTURE_ENV, 0o644);
  try {
    const result = await runWizard(root, pathDir, ["", "s", "", "", "", "decupa.falso.ts.net", "", "", "", "", "n"]);
    expect(result.output).toMatch(/Restringir as permissões/);
    expect((await stat(join(root, ".env"))).mode & 0o777).toBe(0o600);
  } finally { await cleanup(root); }
});

linuxIt("não avisa quando .env aponta para alvo com modo 600", async () => {
  const { root, pathDir, target, contents } = await fixtureWithEnvSymlink(0o600);
  try {
    const result = await runWizard(root, pathDir, [""]);
    expect(result.code).toBe(1);
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(await readFile(target, "utf8")).toBe(contents);
    expect(result.output).not.toMatch(/\.env está com modo/);
  } finally { await cleanup(root); }
});

linuxIt("avisa modo 644 do alvo e chmod s altera o alvo para 600", async () => {
  const { root, pathDir, target, contents } = await fixtureWithEnvSymlink(0o644);
  try {
    const result = await runWizard(root, pathDir, ["", "s"]);
    expect(result.code).toBe(1);
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(await readFile(target, "utf8")).toBe(contents);
    expect(result.output).toMatch(/\.env está com modo 644/);
  } finally { await cleanup(root); }
});

linuxIt("avisa modo 644 do alvo e mantém o modo ao recusar chmod", async () => {
  const { root, pathDir, target, contents } = await fixtureWithEnvSymlink(0o644);
  try {
    const result = await runWizard(root, pathDir, ["", "n"]);
    expect(result.code).toBe(1);
    expect((await stat(target)).mode & 0o777).toBe(0o644);
    expect(await readFile(target, "utf8")).toBe(contents);
    expect(result.output).toMatch(/\.env está com modo 644/);
  } finally { await cleanup(root); }
});

linuxIt("preserva modo 644 quando a correção é recusada", async () => {
  const { root, pathDir } = await fixture(FIXTURE_ENV, 0o644);
  try {
    const result = await runWizard(root, pathDir, ["", "n", "", "", "decupa.falso.ts.net", "", "", "", "", "n"]);
    expect(result.output).toMatch(/permissão|chmod 600|modo 644/i);
    const info = await stat(join(root, ".env"));
    expect(info.mode & 0o777).toBe(0o644);
  } finally { await cleanup(root); }
});

linuxIt("registra chmod recusado como pendência no resumo", async () => {
  const envWithoutDomain = FIXTURE_ENV.replace("DECUPA_DOMAIN=decupa.falso.ts.net\n", "");
  const { root, pathDir } = await fixture(envWithoutDomain, 0o644);
  try {
    const answers = ["", "n", "", "", "", "falso.ts.net", "", "", "", "", "y", "", "n", "", "s", "", "n", "", "n", "", "n", "", "n", ""];
    const result = await runWizard(root, pathDir, answers);
    expect(result.output).toMatch(/Setup complete/);
    expect(result.output).toMatch(/chmod 600 \.env/);
    expect((await stat(join(root, ".env"))).mode & 0o777).toBe(0o644);
    expect(result.code).toBe(0);
  } finally { await cleanup(root); }
});

linuxIt.each([0o600, 0o400])("não avisa para .env com modo %o", async (mode) => {
  const { root, pathDir } = await fixture(FIXTURE_ENV, mode);
  try {
    const result = await runWizard(root, pathDir, ["", "", "", "decupa.falso.ts.net", "", "", "", "", "n"]);
    expect(result.output).not.toMatch(/permissão|chmod 600|modo 644/i);
    const info = await stat(join(root, ".env"));
    expect(info.mode & 0o777).toBe(mode);
  } finally { await cleanup(root); }
});

linuxIt("mantém DECUPA_DOMAIN decupa-1.exemplo.ts.net ao interromper o rerun antes do build", async () => {
  const expected = "decupa-1.exemplo.ts.net";
  const { root, pathDir } = await fixture(FIXTURE_ENV.replace("decupa.falso.ts.net", expected));
  try {
    // Enter mantém o domínio completo no prompt novo; no fluxo antigo, os
    // valores de contingência ainda fazem o wizard terminar antes do build.
    const result = await runWizard(root, pathDir, ["", "", "", "", "", "", "", "", "n"]);
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/Parei antes do build/);
    const env = await readFile(join(root, ".env"), "utf8");
    expect(env).toContain("DECUPA_TAILSCALE_HOSTNAME='decupa'");
    expect(env).toContain(`DECUPA_DOMAIN='${expected}'`);
    expect(result.calls).not.toMatch(/compose build/);
  } finally { await cleanup(root); }
});

linuxIt("salva o domínio completo escolhido em um rerun", async () => {
  const chosen = "equipe.falso.ts.net";
  const { root, pathDir } = await fixture(FIXTURE_ENV.replace("decupa.falso.ts.net", "decupa-1.falso.ts.net"));
  try {
    const result = await runWizard(root, pathDir, ["", "", "", "", chosen, "", "", "", "n"]);
    expect(result.code).toBe(1);
    const env = await readFile(join(root, ".env"), "utf8");
    expect(env).toContain(`DECUPA_DOMAIN='${chosen}'`);
    expect(env).toContain("DECUPA_TAILSCALE_HOSTNAME='equipe'");
    expect(result.calls).not.toMatch(/compose build/);
  } finally { await cleanup(root); }
});

linuxIt.each(["s", "S", "sim"]) ("aceita confirmação em português (%s)", async (answer) => {
  const { root, pathDir } = await fixture(FIXTURE_ENV);
  try {
    const result = await runWizard(root, pathDir, ["", "", "", answer, "", "decupa.falso.ts.net", "", "", "", "", "n"], { FAKE_DOCKER_RUNNING: "yes" });
    expect(result.calls).toMatch(/compose --profile caddy down/);
  } finally { await cleanup(root); }
});

linuxIt("registra no resumo a authkey que ficou no .env após recusar a remoção", async () => {
  const envWithoutDomain = FIXTURE_ENV.replace("DECUPA_DOMAIN=decupa.falso.ts.net\n", "");
  const { root, pathDir } = await fixture(envWithoutDomain);
  try {
    const answers = ["", "", "", "", "falso.ts.net", "", "", "", "", "y", "", "n", "", "n", "", "n", "", "n", "", "n", "", "n", ""];
    const result = await runWizard(root, pathDir, answers);
    expect(result.output).toMatch(/Setup complete/);
    expect(result.output).toMatch(/apagar DECUPA_TAILSCALE_AUTHKEY do \.env/);
    expect(await readFile(join(root, ".env"), "utf8")).toContain("DECUPA_TAILSCALE_AUTHKEY='tskey-auth-Ficticia-123'");
    expect(result.code).toBe(0);
  } finally { await cleanup(root); }
});

linuxIt("não registra authkey pendente quando não há authkey no .env", async () => {
  const envWithoutKeyAndDomain = FIXTURE_ENV
    .replace("DECUPA_TAILSCALE_AUTHKEY=tskey-auth-Ficticia-123\n", "")
    .replace("DECUPA_DOMAIN=decupa.falso.ts.net\n", "");
  const { root, pathDir } = await fixture(envWithoutKeyAndDomain);
  try {
    const answers = ["", "", "", "", "falso.ts.net", "", "", "s", "", "y", "", "n", "", "", "n", "", "n", "", "n", "", "n", ""];
    const result = await runWizard(root, pathDir, answers, { FAKE_VOLUME_EXISTS: "yes" });
    expect(result.output).toMatch(/Setup complete/);
    expect(result.output).not.toMatch(/apagar DECUPA_TAILSCALE_AUTHKEY do \.env/);
    expect(result.code).toBe(0);
  } finally { await cleanup(root); }
});

linuxIt("aceita s para apagar authkey e não a registra como pendente", async () => {
  const envWithoutDomain = FIXTURE_ENV.replace("DECUPA_DOMAIN=decupa.falso.ts.net\n", "");
  const { root, pathDir } = await fixture(envWithoutDomain);
  try {
    const answers = ["", "", "", "", "falso.ts.net", "", "", "", "", "y", "", "n", "", "s", "", "n", "", "n", "", "n", "", "n", ""];
    const result = await runWizard(root, pathDir, answers);
    expect(result.output).toMatch(/Setup complete/);
    expect(result.output).not.toMatch(/apagar DECUPA_TAILSCALE_AUTHKEY do \.env/);
    expect(await readFile(join(root, ".env"), "utf8")).not.toContain("DECUPA_TAILSCALE_AUTHKEY=");
    expect(result.code).toBe(0);
  } finally { await cleanup(root); }
});

it("docs instruem a esvaziar DECUPA_ALLOWED_HOSTS e explicam que causa 403", async () => {
  const text = await readFile(join(ROOT, "docs/implantacao-docker.md"), "utf8");
  expect(text).toContain("DECUPA_ALLOWED_HOSTS=");
  expect(text).toMatch(/403[\s\S]{0,180}DECUPA_ALLOWED_HOSTS|DECUPA_ALLOWED_HOSTS[\s\S]{0,180}403/);
});

it("docs criam o .env com modo 600", async () => {
  const text = await readFile(join(ROOT, "docs/implantacao-docker.md"), "utf8");
  expect(text).toContain("install -m 600 .env.example .env");
});

it("workflow inclui o script do wizard no filtro paths do pull_request", async () => {
  const text = await readFile(join(ROOT, ".github/workflows/docker.yml"), "utf8");
  const paths = text.match(/on:\s*\n\s+pull_request:\s*\n\s+paths:\s*\n([\s\S]*?)\n\s+workflow_dispatch:/)?.[1];
  expect(paths).toContain("- scripts/tailscale-primeira-subida.sh");
});

it("job tailscale-config executa bash -n no wizard", async () => {
  const text = await readFile(join(ROOT, ".github/workflows/docker.yml"), "utf8");
  const job = text.match(/  tailscale-config:\s*\n([\s\S]*?)(?=\n  [a-z][a-z0-9-]*:\s*\n|$)/)?.[1];
  expect(job).toMatch(/bash\s+-n\s+scripts\/tailscale-primeira-subida\.sh/);
});
