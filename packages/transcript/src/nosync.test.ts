import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { alignText } from "./transcribe.ts";

// Só POSIX: no Windows o spawn não executa script com shebang sem extensão,
// então o `uv` e o `ffmpeg` falsos não existem para ele.
it.skipIf(process.platform === "win32")("alignText sobe o sidecar com uv run --no-sync", async () => {
  // PATH só com binários falsos: o shebang é o node absoluto, porque
  // `#!/usr/bin/env node` não acharia o node neste PATH.
  const dir = await mkdtemp(join(tmpdir(), "nosync-"));
  const log = join(dir, "argv.log");
  const bin = join(dir, "bin");
  await mkdir(bin);
  const script = `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(process.env.DECUPA_ARGV_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv.includes("transcribe.py")) {
  process.stdout.write(JSON.stringify({
    language: "pt",
    words: [{ text: "ola", startMs: 0, endMs: 40 }],
  }) + "\\n");
}
process.exit(0);
`;
  for (const name of ["ffmpeg", "uv"]) {
    const path = join(bin, name);
    await writeFile(path, script, "utf8");
    await chmod(path, 0o755);
  }
  const previous = process.env.PATH;
  process.env.DECUPA_ARGV_LOG = log;
  process.env.PATH = bin;
  try {
    await alignText({ input: "x", text: "ola", startSeconds: 0, endSeconds: 1 });
    const lines = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    const sidecar = lines.find((args) => args.includes("transcribe.py"));
    expect(sidecar?.slice(0, 4)).toEqual(["run", "--no-sync", "python", "transcribe.py"]);
  } finally {
    process.env.PATH = previous;
    delete process.env.DECUPA_ARGV_LOG;
    await rm(dir, { recursive: true, force: true });
  }
});
