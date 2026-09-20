// tests/redesign-theme.test.ts
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

const CSS_URL = new URL("../apps/cli/src/app/assembly/page.css", import.meta.url);

it("page.css usa os tokens grafite/dourado-fosco do redesign", async () => {
  const css = await readFile(CSS_URL, "utf8");
  for (const token of [
    "--bg: #111214",
    "--panel: #191A1D",
    "--panel2: #202226",
    "--line: #303238",
    "--ink: #F0F0ED",
    "--muted: #AAADB5",
    "--accent: #F0CA6E",
    "--green: #9FC9B2",
    "--red: #EFAAA0",
  ]) {
    expect(css).toContain(token);
  }
});

it("aliases antigos continuam resolvendo (sem var órfã)", async () => {
  const css = await readFile(CSS_URL, "utf8");
  for (const alias of ["--bg-0: var(--bg)", "--bg-1: var(--panel)", "--bg-2: var(--panel2)", "--ok: var(--green)", "--warn: var(--red)"]) {
    expect(css).toContain(alias);
  }
});

it("limpeza usa os mesmos tokens da montagem", async () => {
  const html = await readFile(new URL("../apps/cli/src/app/page.html", import.meta.url), "utf8");
  for (const token of ["--bg: #111214", "--panel: #191A1D", "--accent: #F0CA6E"]) {
    expect(html).toContain(token);
  }
});
