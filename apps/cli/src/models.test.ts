import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { runModelsFetch } from "./models.ts";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "index.ts");

function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", CLI, ...args], {
      env: { ...process.env, NODE_NO_WARNINGS: "1", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += String(data); });
    child.stderr.on("data", (data) => { stderr += String(data); });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

it("baixa os modelos de fala pelo preparo do sidecar", async () => {
  const execute = vi.fn(async () => undefined);

  await runModelsFetch({ execute });

  expect(execute).toHaveBeenCalledWith(
    "uv",
    ["run", "--no-sync", "python", "transcribe.py", "--prepare-models"],
    expect.stringMatching(/[\\/]services[\\/]speech$/),
  );
});

it("transforma falha de rede ou de espaço numa mensagem acionável", async () => {
  const execute = vi.fn(async () => {
    throw new Error("uv: falha de rede");
  });

  await expect(runModelsFetch({ execute })).rejects.toThrow(
    "não foi possível baixar os modelos de fala",
  );
  await expect(runModelsFetch({ execute })).rejects.toThrow(/rede|espaço/);
});

it("falha do download sai com código 1 e só a mensagem acionável no stderr", async () => {
  const dir = await mkdtemp(join("/tmp", "decupa-models-cli-"));
  try {
    const fakeUv = join(dir, "uv");
    await writeFile(fakeUv, "#!/usr/bin/env node\nconsole.error('falha de rede'); process.exit(1);\n");
    await chmod(fakeUv, 0o755);

    const result = await runCli(["models", "fetch"], {
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      DECUPA_DEBUG: "1",
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("não foi possível baixar os modelos de fala");
    expect(result.stderr).toContain("Confira a rede e o espaço disponível");
    expect(result.stderr).not.toContain("at index");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("models sem fetch mostra o uso correto", async () => {
  const result = await runCli(["models"]);

  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("uso: decupa models fetch");
});
