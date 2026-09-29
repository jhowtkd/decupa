import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

it("process.exit no meio da transcrição apaga o WAV temporário", async () => {
  // O finally de transcribe() não roda no process.exit. O hook de exit é
  // quem apaga a pasta; sem ele o WAV de uma hora fica em /tmp.
  const url = pathToFileURL(fileURLToPath(new URL("./transcribe.ts", import.meta.url))).href;
  const script = `
    import { writeFileSync } from "node:fs";
    const { transcribe } = await import(${JSON.stringify(url)});
    await transcribe({ input: "x" }, {
      extract: async ({ output }) => {
        writeFileSync(output, "wav");
        process.stdout.write(output + "\\n", () => process.exit(0));
      },
      worker: () => new Promise(() => {}),
    });
  `;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    cwd: dirname(fileURLToPath(new URL("../../../package.json", import.meta.url))),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout!.on("data", (chunk) => { out += String(chunk); });
  child.stderr!.on("data", (chunk) => { err += String(chunk); });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`filho não saiu\n${err}`)), 15_000);
      child.once("exit", (status) => { clearTimeout(timer); resolve(status); });
    });
    expect(code, err).toBe(0);
    const wav = out.trim();
    expect(wav).toMatch(/audio\.wav$/);
    await expect(access(dirname(wav))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});
