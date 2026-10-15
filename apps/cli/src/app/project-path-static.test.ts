import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

const FRONTEND = new URL(".", import.meta.url);
const PROJECT_PATH = /["'`](\/)(?:project(?:[/?#"'`]|$)|media(?:[/?#"'`]|$)|editor\/(?:[^"'`]|$)|jobs(?:[/?#"'`]|$))/;

it("não espalha caminhos absolutos do Projeto pelo frontend", async () => {
  const entries = await readdir(FRONTEND, { recursive: true, withFileTypes: true });
  const violations: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(?:html|js)$/.test(entry.name) || entry.name === "project-path.js" || entry.parentPath.endsWith("/templates")) continue;
    const file = join(entry.parentPath, entry.name);
    const source = await readFile(file, "utf8");
    if (PROJECT_PATH.test(source)) violations.push(file);
  }
  expect(violations).toEqual([]);
});
