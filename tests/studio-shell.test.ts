// Caracterização estática do shell studio: tem toda região que o bootstrap e
// os módulos consultam, a meta e os dois CSS. A legacy (page.html) não pode
// ganhar nada disso.
import { readdir, readFile } from "node:fs/promises";
import { expect, it } from "vitest";

const APP = new URL("../apps/cli/src/app/", import.meta.url);
const ASSEMBLY = new URL("assembly/", APP);
const read = (name: string) => readFile(new URL(name, ASSEMBLY), "utf8");

/** Ids que só a gaveta do monitor da legacy usa (mountLegacyMonitor). */
const SO_LEGACY = ["monitor", "monitorToggle", "closeMonitor"];
/** Ids que o servidor injeta no HTML servido (withVisualNotice), fora do shell. */
const DO_SERVIDOR = ["visual-provider-notice"];

/**
 * Fontes do cliente da Montagem: bootstrap, Reserva e editor/*.js servidos.
 * Os editor/studio-*.js só carregam no studio.
 */
async function cliente(variante: "legacy" | "studio"): Promise<string> {
  const editor = (await readdir(new URL("editor/", ASSEMBLY)))
    .filter((name) => name.endsWith(".js") && !name.includes(".test."))
    .filter((name) => variante === "studio" || !name.startsWith("studio-"));
  const files = [
    new URL("page.js", ASSEMBLY),
    new URL("edit-reservation-ui.js", APP),
    ...editor.map((name) => new URL(`editor/${name}`, ASSEMBLY)),
  ];
  return (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
}

/** Ids que o cliente procura no documento e não cria ele mesmo. */
async function idsDoShell(variante: "legacy" | "studio"): Promise<string[]> {
  const js = await cliente(variante);
  const queried = new Set([...js.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]!));
  const created = new Set([
    ...[...js.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!),
    ...[...js.matchAll(/\.id = "([^"]+)"/g)].map((m) => m[1]!),
  ]);
  return [...queried].filter((id) => !created.has(id) && !SO_LEGACY.includes(id) && !DO_SERVIDOR.includes(id)).sort();
}

it("studio.html contém todo id que page.js, a Reserva e os editor/*.js consultam", async () => {
  const studio = await read("studio.html");
  const ids = await idsDoShell("studio");
  expect(ids.length).toBeGreaterThan(15);
  for (const id of ids) expect(studio, id).toContain(`id="${id}"`);
});

it("page.html (legacy) segue com todo id que o cliente dela consulta, inclusive o monitor", async () => {
  const legacy = await read("page.html");
  for (const id of [...await idsDoShell("legacy"), ...SO_LEGACY]) expect(legacy, id).toContain(`id="${id}"`);
});

it("studio.html tem uma tab por etapa do topbar.js", async () => {
  const studio = await read("studio.html");
  const topbar = await read("editor/topbar.js");
  const etapas = [...topbar.matchAll(/\{ id: "([a-z]+)", label: "[^"]+" \}/g)].map((m) => m[1]);
  expect(etapas).toEqual(["materiais", "edicao", "revisao", "entrega"]);
  const tabs = [...studio.matchAll(/<button type="button" role="tab" id="etapa-([a-z]+)" data-stage="\1"/g)].map((m) => m[1]);
  expect(tabs).toEqual(etapas);
});

it("studio.html declara a meta studio, os dois CSS em ordem e o script do bootstrap", async () => {
  const studio = await read("studio.html");
  expect(studio).toContain('<meta name="decupa-editor-ui" content="studio">');
  const links = [...studio.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
  expect(links).toEqual(["__DECUPA_PROJECT_CSS__", "__DECUPA_STUDIO_CSS__"]);
  expect(studio).toContain("__DECUPA_PROJECT_JS__");
});

it("page.html (legacy) não conhece a meta nem o studio.css", async () => {
  const legacy = await read("page.html");
  expect(legacy).not.toContain("decupa-editor-ui");
  expect(legacy).not.toContain("STUDIO_CSS");
  expect(legacy).toContain("__DECUPA_PROJECT_CSS__");
});

it("studio.css não importa page.css (o HTML já liga os dois em paralelo)", async () => {
  expect(await read("studio.css")).not.toMatch(/@import/);
});
