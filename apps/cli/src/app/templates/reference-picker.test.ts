import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { installDom } from "../assembly/editor/fake-dom.test-helper.ts";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const recipe = {
  id: "recipe-1", name: "Receita", revision: 4, status: "draft",
  analysis: { status: "ready", stage: "complete" }, rules: [],
};
type TestRecipe = typeof recipe;

async function openPage() {
  const document = installDom("", { autoIds: true });
  const urls: string[] = [];
  const fetch = vi.fn(async (url: string) => {
    urls.push(String(url));
    if (String(url) === "/api/media") return { ok: true, json: async () => [{ id: "a".repeat(64), nome: "Acervo R2.mp4" }] };
    if (String(url) === "/templates/api") return { ok: true, json: async () => ({ recipes: [] }) };
    if (String(url).includes("/relink")) return { ok: true, json: async () => ({ recipe: { ...recipe, revision: 5 } }) };
    return { ok: true, json: async () => ({}) };
  });
  const source = await readFile(new URL("./page.js", import.meta.url), "utf8");
  const vm = runInNewContext(source + "\n;({ selectReference, show, getCurrent: () => current, getDirty: () => dirty, getBusy: () => busy })", {
    document, fetch, setTimeout, clearTimeout, AbortController, confirm: () => true,
  }, { importModuleDynamically: async () => { throw new Error("falha de teste ao carregar cliente de upload"); } }) as {
    selectReference: () => Promise<string | null>;
    show: (recipe: TestRecipe) => void;
    getCurrent: () => TestRecipe | null;
    getDirty: () => boolean;
    getBusy: () => boolean;
  };
  for (let i = 0; i < 20 && vm.getBusy(); i += 1) await Promise.resolve();
  return { document, fetch, urls, vm };
}

async function flush() { for (let i = 0; i < 12; i += 1) await Promise.resolve(); }

it("abre seletor de acervo e devolve mediaId escolhido", async () => {
  const { document, vm } = await openPage();
  const selected = vm.selectReference();
  await flush();
  const media = document.getElementById("referenceMedia")!;
  expect(media.children.map((option) => option.textContent)).toContain("Acervo R2.mp4");
  media.value = "a".repeat(64);
  media.onchange?.({ type: "change", target: media, currentTarget: media } as never);
  const use = document.getElementById("useReference")!;
  expect(use.disabled).toBe(false);
  use.click();
  await expect(selected).resolves.toBe("a".repeat(64));
  expect(document.body.querySelector("#referencePicker")).toBeNull();
});

it("cancelar o seletor resolve null sem iniciar criação nem alterar o rascunho atual", async () => {
  const { document, urls, vm } = await openPage();
  vm.show(recipe);
  const newName = document.getElementById("newName")!;
  newName.value = "Não criar";
  const selected = vm.selectReference();
  await flush();
  document.getElementById("cancelReference")!.click();
  await expect(selected).resolves.toBeNull();
  expect(vm.getCurrent()).toMatchObject({ id: recipe.id, revision: 4, name: recipe.name });
  expect(urls.some((url) => url === "/api/media")).toBe(true);
  expect(urls.filter((url) => url === "/templates/api")).toHaveLength(1); // apenas o GET inicial da biblioteca de receitas
});

it("impede religar enquanto há alterações não salvas", async () => {
  const { document, urls, vm } = await openPage();
  vm.show(recipe);
  document.getElementById("edit")!.oninput?.({ type: "input", target: null, currentTarget: null } as never);
  expect(vm.getDirty()).toBe(true);
  document.getElementById("relink")!.click();
  await flush();
  expect(vm.getCurrent()).toMatchObject({ id: recipe.id, revision: 4 });
  expect(urls.some((url) => url === "/api/media")).toBe(false);
  expect(urls.some((url) => url.includes("/relink"))).toBe(false);
  expect(document.getElementById("message")!.textContent).toMatch(/Salve suas alterações/);
});

it("falha ao carregar cliente de upload sem alterar receita e libera o seletor", async () => {
  const { document, urls, vm } = await openPage();
  const selected = vm.selectReference();
  await flush();
  const file = document.getElementById("referenceUpload")!;
  Object.assign(file, { files: [{ name: "local.mp4" }], value: "local.mp4" });
  await file.onchange?.({ type: "change", target: file, currentTarget: file } as never);
  expect(document.getElementById("referenceProgress")!.textContent).toMatch(/Falha no envio/);
  expect(file.disabled).toBe(false);
  expect(file.value).toBe("");
  expect(vm.getCurrent()).toBeNull();
  expect(vm.getDirty()).toBe(false);
  expect(urls.filter((url) => url === "/templates/api")).toHaveLength(1);
  document.getElementById("cancelReference")!.click();
  await expect(selected).resolves.toBeNull();
});
