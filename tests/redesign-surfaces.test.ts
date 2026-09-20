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

it("mark-web usa os tokens e segue às cegas", async () => {
  const html = await readFile(new URL("../apps/cli/src/mark-web/page.html", import.meta.url), "utf8");
  for (const token of ["--bg: #111214", "--accent: #F0CA6E"]) {
    expect(html).toContain(token);
  }
  for (const banned of ["transcript", "predi", "sugest", "melhor posição"]) {
    expect(html.toLowerCase()).not.toContain(banned);
  }
});
