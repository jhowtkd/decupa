// Caracterização estática do shell studio: mesmas regiões que a legacy, mais
// a meta e o studio.css. A legacy (page.html) não pode ganhar nada disso.
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

const ASSEMBLY = new URL("../apps/cli/src/app/assembly/", import.meta.url);
const read = (name: string) => readFile(new URL(name, ASSEMBLY), "utf8");

function values(html: string, attr: string): string[] {
  return [...html.matchAll(new RegExp(`\\b${attr}="([^"]*)"`, "g"))].map((m) => m[1]!).sort();
}

it("studio.html tem exatamente os mesmos ids e data-stage que page.html", async () => {
  const [legacy, studio] = [await read("page.html"), await read("studio.html")];
  expect(values(studio, "id")).toEqual(values(legacy, "id"));
  expect(values(studio, "data-stage")).toEqual(values(legacy, "data-stage"));
  expect(values(studio, "id").length).toBeGreaterThan(10);
});

it("studio.html declara a meta studio, o link do studio.css e o script do bootstrap", async () => {
  const studio = await read("studio.html");
  expect(studio).toContain('<meta name="decupa-editor-ui" content="studio">');
  expect(studio).toContain('href="__DECUPA_STUDIO_CSS__"');
  expect(studio).toContain("__DECUPA_PROJECT_JS__");
  expect(studio).not.toContain("__DECUPA_PROJECT_CSS__");
});

it("page.html (legacy) não conhece a meta nem o studio.css", async () => {
  const legacy = await read("page.html");
  expect(legacy).not.toContain("decupa-editor-ui");
  expect(legacy).not.toContain("STUDIO_CSS");
  expect(legacy).toContain("__DECUPA_PROJECT_CSS__");
});

it("studio.css importa page.css por URL relativa para seguir o prefixo do Projeto", async () => {
  const css = await read("studio.css");
  const imports = [...css.matchAll(/@import\s+url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1]);
  expect(imports).toEqual(["page.css"]);
  expect(imports[0]!.startsWith("/")).toBe(false);
});
