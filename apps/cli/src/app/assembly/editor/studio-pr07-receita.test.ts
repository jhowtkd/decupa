// Rail (PR 7): no studio o painel de template diz "Receita"; a legacy segue com "template".
import { afterEach, expect, it, vi } from "vitest";
import { createState } from "./state.js";
import { mountRail } from "./rail.js";
import { mountTemplates } from "./templates.js";
import { El, installDom, type FakeDocument } from "./fake-dom.test-helper.ts";

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };

/** O DOM falso não cria nós de texto a partir do innerHTML: guarda o que cada elemento recebeu. */
function capturaInnerHtml(document: FakeDocument): string[] {
  const recebidos: string[] = [];
  const setter = Object.getOwnPropertyDescriptor(El.prototype, "innerHTML")!.set!;
  const criar = document.createElement;
  document.createElement = (tag: string) => {
    const el = criar(tag);
    Object.defineProperty(el, "innerHTML", { configurable: true, set(valor: string) { recebidos.push(valor); setter.call(el, valor); } });
    return el;
  };
  return recebidos;
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function montarTemplates(ui?: string) {
  const document = installDom('<aside id="rail"></aside>');
  const html = capturaInnerHtml(document);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ recipes: [] }) })));
  const state = createState({});
  const api = { call: vi.fn(async () => ({ res: { ok: true }, body: {} })), notifyError: vi.fn() };
  mountTemplates({ state, api, ...(ui ? { ui } : {}) } as never);
  const painel = document.querySelector(".template-panel")!;
  return { document, state, api, painel, html };
}

const projetoSemTemplate = () => ({ revision: 1, assembly: { sources: [{ id: "a", included: true }] }, template: null });

it("mountTemplates com ui studio: painel, estado vazio e primeira opção dizem Receita", () => {
  const { document, painel, state, html } = montarTemplates("studio");
  expect(painel.getAttribute("aria-label")).toBe("Receita do projeto");
  const inicial = html.find((h) => h.includes('id="activeTemplate"'))!;
  expect(inicial).toContain('id="activeTemplate">Sem receita<');
  expect(inicial).toContain('<option value="">Sem receita</option>');
  expect(inicial).not.toMatch(/Sem template/);
  state.set("project", projetoSemTemplate());
  expect(document.getElementById("activeTemplate")!.textContent).toBe("Sem receita");
});

it("mountTemplates com ui studio: atualizar a biblioteca mantém 'Sem receita' como primeira opção", async () => {
  const { painel } = montarTemplates("studio");
  await flush();
  expect(painel.querySelector("#templateChoice")!.children[0]!.textContent).toBe("Sem receita");
});

it.each([undefined, "legacy"])("mountTemplates com ui %s segue com Template do projeto / Sem template", async (ui) => {
  const { document, painel, state, html } = montarTemplates(ui);
  expect(painel.getAttribute("aria-label")).toBe("Template do projeto");
  const inicial = html.find((h) => h.includes('id="activeTemplate"'))!;
  expect(inicial).toContain('id="activeTemplate">Sem template<');
  expect(inicial).toContain('<option value="">Sem template</option>');
  expect(inicial).not.toMatch(/Sem receita/);
  state.set("project", projetoSemTemplate());
  expect(document.getElementById("activeTemplate")!.textContent).toBe("Sem template");
  await flush();
  expect(painel.querySelector("#templateChoice")!.children[0]!.textContent).toBe("Sem template");
});

it.each([["studio", "Receita…"], [undefined, "Template editorial…"]] as const)("a chamada de gerar proposta (ui %s) rotula como %s", async (ui, rotulo) => {
  const { document, state, api } = montarTemplates(ui);
  state.set("project", projetoSemTemplate());
  document.getElementById("templateConsent")!.checked = true;
  document.getElementById("generateTemplate")!.click();
  await Promise.resolve();
  expect(api.call).toHaveBeenCalledTimes(1);
  expect((api.call.mock.calls[0] as unknown as [string, { label: string }])[1].label).toBe(rotulo);
});

function summaryDoSlot(ui?: string) {
  const document = installDom(
    '<button id="newProject" type="button"></button><span id="primaryAction"></span>'
    + '<aside id="rail"></aside><div id="activity"></div><div id="monitorBriefing"></div>',
  );
  const state = createState({});
  const api = { call: vi.fn(async () => ({ res: { ok: true }, body: {} })), notifyError: vi.fn() };
  const html = capturaInnerHtml(document);
  mountRail({ state, api, player: { previewBusy: () => false, seek: vi.fn() } as never, ...(ui ? { ui } : {}) } as never);
  return html.find((h) => h.includes("<summary>Receita</summary>") || h.includes("<summary>Template editorial</summary>"));
}

it("mountRail: o <summary> do #templateSlot diz Receita no studio e Template editorial na legacy", () => {
  expect(summaryDoSlot("studio")).toBe("<summary>Receita</summary>");
  expect(summaryDoSlot()).toBe("<summary>Template editorial</summary>");
  expect(summaryDoSlot("legacy")).toBe("<summary>Template editorial</summary>");
});
