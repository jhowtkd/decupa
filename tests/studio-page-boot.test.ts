// A divisão legacy/studio no bootstrap (page.js), conferida no texto: page.js inteiro
// não roda no DOM falso (top-level await), e o studio não pode vazar para a legacy.
import { access, readFile } from "node:fs/promises";
import { beforeAll, expect, it } from "vitest";

const ASSEMBLY = new URL("../apps/cli/src/app/assembly/", import.meta.url);
let js = "";
let legacyHtml = "";

beforeAll(async () => {
  [js, legacyHtml] = await Promise.all([
    readFile(new URL("page.js", ASSEMBLY), "utf8"),
    readFile(new URL("page.html", ASSEMBLY), "utf8"),
  ]);
});

const linhas = () => js.split("\n");

it("editorUi vem só da meta decupa-editor-ui com content studio; o resto é legacy", () => {
  expect(js.match(/decupa-editor-ui/g)).toHaveLength(1);
  const declaracao = /const editorUi = ([\s\S]*?);\n/.exec(js)?.[1];
  expect(declaracao).toBeDefined();
  expect(declaracao!.replace(/\s+/g, " ")).toBe(
    "document.querySelector('meta[name=\"decupa-editor-ui\"]')?.getAttribute(\"content\") === \"studio\" ? \"studio\" : \"legacy\"",
  );
  // Lido uma vez: nenhuma outra leitura de variante no arquivo.
  expect(js.match(/getAttribute\("content"\) === "studio"/g)).toHaveLength(1);
  expect(js.match(/const editorUi\b/g)).toHaveLength(1);
});

it("os módulos do studio (bancada inclusive) só são importados quando editorUi é studio", () => {
  const usos = linhas().filter((linha) => linha.includes("studio-bancada"));
  expect(usos).toHaveLength(1);
  expect(usos[0]!.trim()).toBe('bancada: "editor/studio-bancada.js",');
  expect(js).not.toMatch(/^import .*studio-/m);
  // Dentro do Promise.all do boot: nenhuma ida e volta em série depois dos módulos.
  const boot = /await Promise\.all\(\[([\s\S]*?)\]\);/.exec(js)?.[1];
  expect(boot).toContain('editorUi === "studio" ? importarStudio() : null,');
});

it("a legacy chama mountLegacyMonitor() e abre em Materiais; o studio usa a bancada", () => {
  const ramo = /if \(bancada\) \{([\s\S]*?)\} else \{([\s\S]*?)\}\n/.exec(js);
  expect(ramo).not.toBeNull();
  const [, studio, legacy] = ramo!;
  expect(studio).toContain("setStage(bancada.initialStage)");
  expect(studio).not.toContain("mountLegacyMonitor");
  expect(legacy).toContain("mountLegacyMonitor();");
  expect(legacy).toContain('setStage("materiais");');
  // A definição existe uma vez e a única chamada é a da legacy.
  expect(js.match(/function mountLegacyMonitor\(/g)).toHaveLength(1);
  expect(js.match(/mountLegacyMonitor\(\)/g)).toHaveLength(2);
  expect(js).toContain('const bancada = editorUi === "studio" ? studio.bancada.mountBancada(');
  expect(js).toContain("const showStage = bancada ? bancada.show : applyStageDom;");
});

it("só mountRail, mountTexto e mountSequencia recebem ui", () => {
  const chamadas = [...js.matchAll(/^mount[A-Z]\w*\((\{[^}]*\})?\)/gm)];
  expect(chamadas.length).toBeGreaterThan(4);
  const comUi = chamadas.filter((chamada) => /\bui\b/.test(chamada[0]));
  expect(comUi.map((chamada) => chamada[0])).toEqual([
    "mountRail({ state, api, player, ui: editorUi })",
    "mountTexto({ state, api, player, ui: editorUi })",
    "mountSequencia({ state, api, player, ui: editorUi })",
  ]);
});

it("studio-busca.js só carrega no studio e a busca é montada sem api", () => {
  const usos = linhas().filter((linha) => linha.includes("studio-busca"));
  expect(usos).toHaveLength(1);
  expect(usos[0]!.trim()).toBe('busca: "editor/studio-busca.js",');
  expect(js).toContain('if (editorUi === "studio") studio.busca.mountBusca({ state });');
});

it("page.html segue sem nada da bancada do studio", () => {
  for (const marca of ['id="bancada"', "data-painel", 'id="palco"', 'id="inspector"', "decupa-editor-ui"]) {
    expect(legacyHtml, marca).not.toContain(marca);
  }
  for (const id of ["monitor", "monitorToggle", "closeMonitor", "stages"]) expect(legacyHtml).toContain(`id="${id}"`);
});

/** O objeto STUDIO_MODULOS do page.js: nome → caminho. */
function studioModulos(): Record<string, string> {
  const corpo = /const STUDIO_MODULOS = \{([\s\S]*?)\};/.exec(js)?.[1];
  expect(corpo, "STUDIO_MODULOS no page.js").toBeDefined();
  return Object.fromEntries([...corpo!.matchAll(/(\w+):\s*"([^"]+)"/g)].map((m) => [m[1]!, m[2]!]));
}

it("STUDIO_MODULOS liga cada nome a um editor/studio-*.js que existe", async () => {
  const modulos = studioModulos();
  expect(Object.keys(modulos).sort()).toEqual(["bancada", "busca", "formato", "legendas", "materiais", "renomear"]);
  for (const [nome, caminho] of Object.entries(modulos)) {
    expect(caminho, nome).toMatch(/^editor\/studio-[\w-]+\.js$/);
    await expect(access(new URL(caminho, ASSEMBLY)), caminho).resolves.toBeUndefined();
  }
});

it("cada uso studio.<nome>.<função>( do page.js tem o nome em STUDIO_MODULOS e a função exportada pelo arquivo", async () => {
  const modulos = studioModulos();
  const usos = [...js.matchAll(/\bstudio\.(\w+)\.(\w+)\(/g)].map((m) => ({ nome: m[1]!, funcao: m[2]! }));
  expect(usos.length).toBeGreaterThanOrEqual(3);
  for (const { nome, funcao } of usos) {
    expect(Object.keys(modulos), `studio.${nome}`).toContain(nome);
    const fonte = await readFile(new URL(modulos[nome]!, ASSEMBLY), "utf8");
    expect(fonte, `${modulos[nome]} exporta ${funcao}`).toMatch(new RegExp(`export (?:async )?function ${funcao}\\(`));
  }
  // Todo módulo do mapa tem pelo menos um uso: um nome sem uso seria import morto.
  expect(new Set(usos.map((uso) => uso.nome))).toEqual(new Set(Object.keys(modulos)));
});

it("nenhum outro import de studio-* no page.js além do mapa STUDIO_MODULOS", () => {
  const mencoes = linhas().filter((linha) => linha.includes("studio-") && !linha.trim().startsWith("//") && !linha.trim().startsWith("*"));
  const modulos = Object.values(studioModulos());
  // Só as linhas do próprio mapa citam um arquivo studio-*.
  expect(mencoes.map((linha) => linha.trim().replace(/^\w+:\s*"|",$/g, "")).sort()).toEqual([...modulos].sort());
  expect(js).not.toMatch(/import\s*\(\s*projectPath\(\s*["'][^"']*studio-/);
  expect(js).not.toMatch(/^import .*studio-/m);
});

it("o Modo Leitura pausa a fila de Materiais e o conflito do POST local chega à Reserva", () => {
  const onReadOnly = /onReadOnly: \(owner\) => \{([\s\S]*?)\n  \},/.exec(js)?.[1];
  expect(onReadOnly, "onReadOnly").toBeDefined();
  expect(onReadOnly).toContain("if (owner) materiais?.pausarPorReserva();");
  expect(js).toMatch(/studio\.materiais\.mountMateriais\(\{[\s\S]*?onConflitoDeReserva: \(body\) => reservationUI\.handleConflict\(body\),/);
});
