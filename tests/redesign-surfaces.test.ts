// tests/redesign-surfaces.test.ts
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("provider-setup usa os tokens sem mudar copy de custódia", async () => {
  const html = await readFile(new URL("../apps/cli/src/app/provider-setup.html", import.meta.url), "utf8");
  for (const token of ["--bg: #111214", "--panel: #191A1D", "--accent: #F0CA6E", "--ink: #F0F0ED"]) {
    expect(html).toContain(token);
  }
  expect(html).toContain("protegida neste usuário do computador");
  expect(html).toContain('id="preset"');
  expect(html).toContain("/provider");
});

it("limpeza: a extensão de cada item de exportar é a do arquivo que o servidor entrega", async () => {
  const html = await readFile(new URL("../apps/cli/src/app/page.html", import.meta.url), "utf8");
  const server = await readFile(new URL("../apps/cli/src/app/server.ts", import.meta.url), "utf8");
  const block = server.slice(server.indexOf("const files: Record<string, string> = {"));
  const served = new Map(
    [...block.slice(0, block.indexOf("};")).matchAll(/(\w+): join\(workDir, (?:"[^"]+", )*"[^"]*\.(\w+)"\)/g)]
      .map((m) => [m[1], m[2]]),
  );
  const items = [...html.matchAll(/<button data-export="(\w+)">[^<]*\.(\w+)<\/button>/g)];
  expect(items.length).toBeGreaterThan(0);
  for (const [, kind, ext] of items) {
    expect(served.get(kind), `data-export="${kind}"`).toBe(ext);
  }
});

it("mark-web usa os tokens e segue às cegas", async () => {
  const html = await readFile(new URL("../apps/cli/src/mark-web/page.html", import.meta.url), "utf8");
  for (const token of ["--bg: #111214", "--accent: #F0CA6E"]) {
    expect(html).toContain(token);
  }
  for (const banned of ["transcript", "predi", "sugest", "melhor posição"]) {
    expect(html.toLowerCase()).not.toContain(banned);
  }
});
