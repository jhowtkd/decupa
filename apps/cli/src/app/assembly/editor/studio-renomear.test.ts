// Renomear a montagem no studio: o aviso antes de confirmar (puro e no DOM do
// studio.html real), o POST único e o estado depois. Também prova que abrir
// Materiais e o diálogo de renomear não dispara nada pago nem de processamento.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createState } from "./state.js";
import { mountRail } from "./rail.js";
import { mountMateriais } from "./studio-materiais.js";
import { efeitosDeRenomear, mountRenomear, nomeDaMontagem, resultadoDeRenomear, validarNome } from "./studio-renomear.js";
import { domWindow, installDom } from "./fake-dom.test-helper.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const HTML = readFileSync(new URL("../studio.html", import.meta.url), "utf8");
const BODY = /<body[^>]*>([\s\S]*)<\/body>/.exec(HTML)![1]!.replace(/<script[\s\S]*?<\/script>/g, "");
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

type Proj = ReturnType<typeof projeto>;
function projeto(over: Record<string, unknown> = {}) {
  return {
    id: "p",
    revision: 3,
    preparedRevision: null as number | null,
    previewRevision: 3 as number | null,
    finalApprovedRevision: 3 as number | null,
    preparation: null,
    corrections: [] as unknown[],
    proposal: null,
    input: { kind: "brief", text: "um vídeo", targetSeconds: 60 },
    analyses: [{ sourceId: "a", words: [], visual: [], status: "ready" }],
    assembly: {
      name: "Montagem velha", fps: { num: 25, den: 1 }, width: 320, height: 240,
      sources: [{ id: "a", name: "fala.mp4", included: true, hasVideo: false, role: "speech", sha256: "a".repeat(64) }],
      tracks: [],
    },
    scenes: [{ id: "s1", objective: "Cena", takes: [{ id: "t1", sourceId: "a", start: 0, end: 1, removed: [], protected: [] }], support: [], gaps: [] }],
    ...over,
  };
}

describe("efeitosDeRenomear e validarNome (puros)", () => {
  it("cita v{n}→v{n+1}, prévia, aprovação e Desfazer", () => {
    const texto = efeitosDeRenomear(projeto() as never, 2).join("\n");
    expect(texto).toContain("da v3 para a v4");
    expect(texto).toContain("A prévia v3 deixa de valer");
    expect(texto).toContain("A aprovação da v3 é desfeita");
    expect(texto).toContain("Desfazer fica indisponível");
  });

  it("sem aprovação vigente avisa que a entrega segue travada; sem undo o Desfazer só não volta o nome", () => {
    const texto = efeitosDeRenomear(projeto({ finalApprovedRevision: 2, previewRevision: null }) as never, null).join("\n");
    expect(texto).toContain("Nenhuma aprovação vale para a v4");
    expect(texto).toContain("A prévia é gerada para a v4");
    expect(texto).toContain("O Desfazer não volta o nome.");
    expect(texto).not.toContain("indisponível");
  });

  it("validarNome recusa vazio, mais de 200 caracteres e o mesmo nome", () => {
    expect(validarNome("   ", "x")).toMatchObject({ valido: false });
    expect(validarNome("a".repeat(201), "x")).toMatchObject({ valido: false });
    expect(validarNome("a".repeat(200), "x")).toEqual({ valido: true, nome: "a".repeat(200) });
    expect(validarNome("Mesmo", "Mesmo")).toMatchObject({ valido: false, mensagem: "Este já é o nome da montagem." });
    expect(validarNome("  Novo  ", "Velho")).toEqual({ valido: true, nome: "Novo" });
  });

  it("nomeDaMontagem ignora o nome que é só o id", () => {
    expect(nomeDaMontagem({ id: "p", assembly: { name: "p" } })).toBe("");
    expect(nomeDaMontagem({ id: "p", assembly: { name: "Outro" } })).toBe("Outro");
  });

  it("resultadoDeRenomear diz prévia desatualizada, aprovação pendente e Desfazer indisponível", () => {
    const linhas = resultadoDeRenomear(projeto() as never, projeto({ revision: 4 }) as never);
    expect(linhas[0]).toBe("Agora é a v4 (era v3).");
    expect(linhas[1]).toMatch(/^Prévia desatualizada/);
    expect(linhas[2]).toMatch(/^Aprovação: pendente/);
    expect(linhas[3]).toMatch(/^Desfazer: indisponível/);
  });
});

function montar(project: Proj | null = projeto()) {
  const document = installDom(BODY);
  const janela = domWindow();
  const eventos: Array<{ type: string; detail: unknown }> = [];
  Object.assign(janela, {
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    dispatchEvent: vi.fn((evento: { type: string; detail: unknown }) => { eventos.push(evento); }),
  });
  const state = createState({});
  if (project) state.set("project", project);
  const chamadas: Array<{ rota: string; opcoes?: { method?: string; body?: string } }> = [];
  const api = {
    call: vi.fn(async (rota: string, opcoes?: { method?: string; body?: string }) => {
      chamadas.push({ rota, opcoes });
      return { res: { ok: true, status: 200 }, body: {} as Record<string, unknown> };
    }),
    notifyError: vi.fn(),
  };
  return { document, state, api, chamadas, eventos };
}

const dialogo = (document: ReturnType<typeof installDom>) => document.getElementById("renameDialog")!;

describe("diálogo de renomear no studio.html", () => {
  it("clicar em #renameProject abre o diálogo com os avisos e nenhuma chamada à API", () => {
    const { document, state, api } = montar();
    mountRenomear({ state, api });
    document.getElementById("renameProject")!.click();
    expect(dialogo(document).open).toBe(true);
    expect(dialogo(document).showCount).toBe(1);
    const efeitos = document.getElementById("renameEffects")!.children.map((li) => li.textContent).join("\n");
    expect(efeitos).toContain("v3 para a v4");
    expect(document.getElementById("renameInput")!.value).toBe("Montagem velha");
    expect(document.getElementById("renameResult")!.hidden).toBe(true);
    expect(api.call).not.toHaveBeenCalled();
  });

  it("sem projeto carregado o diálogo não abre", () => {
    const { document, state, api } = montar(null);
    mountRenomear({ state, api });
    document.getElementById("renameProject")!.click();
    expect(dialogo(document).open).toBe(false);
  });

  it("cancelar fecha sem chamar nada", () => {
    const { document, state, api } = montar();
    mountRenomear({ state, api });
    document.getElementById("renameProject")!.click();
    document.getElementById("renameCancel")!.click();
    expect(dialogo(document).open).toBe(false);
    expect(api.call).not.toHaveBeenCalled();
  });

  it("nome inválido mostra o erro e não chama a API", () => {
    const { document, state, api } = montar();
    mountRenomear({ state, api });
    document.getElementById("renameProject")!.click();
    document.getElementById("renameInput")!.value = "Montagem velha";
    document.getElementById("renameForm")!.dispatchEvent({ type: "submit" });
    expect(document.getElementById("renameError")!.hidden).toBe(false);
    expect(document.getElementById("renameError")!.textContent).toBe("Este já é o nome da montagem.");
    expect(api.call).not.toHaveBeenCalled();
  });

  it("confirmar chama project/rename uma vez só e depois mostra prévia desatualizada, aprovação pendente e Desfazer indisponível", async () => {
    const { document, state, api, chamadas } = montar();
    api.call.mockImplementation(async (rota: string, opcoes?: { method?: string; body?: string }) => {
      chamadas.push({ rota, opcoes });
      // O servidor sobe a revisão e zera prévia e aprovação; o api.js real publica o projeto no state.
      state.set("project", projeto({
        revision: 4, previewRevision: null, finalApprovedRevision: null,
        assembly: { ...projeto().assembly, name: "Montagem nova" },
      }));
      return { res: { ok: true, status: 200 }, body: {} };
    });
    mountRenomear({ state, api });
    document.getElementById("renameProject")!.click();
    document.getElementById("renameInput")!.value = "  Montagem nova ";
    const form = document.getElementById("renameForm")!;
    form.dispatchEvent({ type: "submit" });
    // Segundo envio enquanto o primeiro corre: ignorado.
    form.dispatchEvent({ type: "submit" });
    await flush();
    form.dispatchEvent({ type: "submit" });
    await flush();
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.rota).toBe("project/rename");
    expect(chamadas[0]!.opcoes!.method).toBe("POST");
    expect(JSON.parse(chamadas[0]!.opcoes!.body!)).toEqual({ nome: "Montagem nova", baseRevision: 3 });
    const resultado = document.getElementById("renameAfter")!.children.map((li) => li.textContent).join("\n");
    expect(document.getElementById("renameResult")!.hidden).toBe(false);
    expect(document.getElementById("renameDone")!.textContent).toContain("Montagem nova");
    expect(resultado).toContain("Prévia desatualizada");
    expect(resultado).toContain("Aprovação: pendente");
    expect(resultado).toContain("Desfazer: indisponível");
    expect(document.getElementById("renameConfirm")!.hidden).toBe(true);
    expect(document.getElementById("renameCancel")!.textContent).toBe("Fechar");
  });

  it("num 409 mostra o erro e repinta o aviso com a revisão nova", async () => {
    const { document, state, api } = montar();
    api.call.mockImplementation(async () => {
      // Outra aba subiu a revisão: o aviso já deve citar v7→v8 depois do erro.
      state.set("project", projeto({ revision: 7, previewRevision: 7, finalApprovedRevision: null }));
      return { res: { ok: false, status: 409 }, body: { error: "revisão" } };
    });
    mountRenomear({ state, api });
    document.getElementById("renameProject")!.click();
    document.getElementById("renameInput")!.value = "Outro";
    document.getElementById("renameForm")!.dispatchEvent({ type: "submit" });
    await flush();
    expect(document.getElementById("renameError")!.hidden).toBe(false);
    expect(document.getElementById("renameError")!.textContent).toMatch(/A montagem mudou/);
    const efeitos = document.getElementById("renameEffects")!.children.map((li) => li.textContent).join("\n");
    expect(efeitos).toContain("v7 para a v8");
    expect(document.getElementById("renameResult")!.hidden).toBe(true);
    expect(document.getElementById("renameConfirm")!.disabled).toBe(false);
  });
});

describe("abrir não processa", () => {
  const ROTAS_DE_PROCESSAMENTO = /prepare|preview|analyze|template-proposal|export|render|cancel/;

  it("montar Materiais e Renomear, trocar para Materiais e abrir o diálogo só faz leitura", () => {
    const { document, state, api, chamadas } = montar();
    const fetchImpl = vi.fn();
    const fetchGlobal = vi.fn();
    vi.stubGlobal("fetch", fetchGlobal);
    const mat = mountMateriais({
      state, api, setStage: ((etapa: string) => { state.set("stage", etapa); }) as never, teamMode: false, mediaEnabled: false,
      storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } as never, projeto: "alpha",
      fetchImpl: fetchImpl as never,
    });
    mountRenomear({ state, api });
    state.set("stage", "materiais");
    document.getElementById("renameProject")!.click();
    expect(dialogo(document).open).toBe(true);
    expect(mat.fila.instantanea().itens).toHaveLength(0);
    expect(chamadas.filter((c) => (c.opcoes?.method ?? "GET") !== "GET")).toEqual([]);
    expect(chamadas.filter((c) => ROTAS_DE_PROCESSAMENTO.test(c.rota))).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fetchGlobal).not.toHaveBeenCalled();
  });

  it("rail com ui:studio: Editar navega para materiais, não abre o diálogo e não chama a API", () => {
    const { document, state, api, eventos } = montar();
    mountRail({ state, api, player: { previewBusy: () => false, seek: vi.fn() } as never, ui: "studio" });
    state.set("project", projeto());
    const abrir = document.getElementById("openBriefing")!;
    abrir.click();
    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.type).toBe("decupa:set-stage");
    expect(eventos[0]!.detail).toBe("materiais");
    expect(document.getElementById("briefingDialog")!.open).toBe(false);
    expect(document.getElementById("briefingDialog")!.showCount).toBe(0);
    expect(api.call).not.toHaveBeenCalled();
  });

  it("o formulário do briefing fica em #materiaisBriefing com e sem material", () => {
    for (const fontes of [[], [{ id: "a", name: "fala.mp4", included: true, hasVideo: false, role: "speech", sha256: "a".repeat(64) }]]) {
      const { document, state, api } = montar();
      mountRail({ state, api, player: { previewBusy: () => false, seek: vi.fn() } as never, ui: "studio" });
      const base = projeto();
      state.set("project", projeto({ assembly: { ...base.assembly, sources: fontes } }));
      const form = document.getElementById("briefingForm")!;
      expect(form.parentElement).toBe(document.getElementById("materiaisBriefing"));
      expect(document.getElementById("monitorBriefing")!.hidden).toBe(true);
    }
  });

  it("com ui ausente ou legacy o Editar abre o diálogo e o briefing vazio fica inline, como antes", () => {
    for (const ui of [undefined, "legacy"]) {
      const { document, state, api, eventos } = montar();
      mountRail({ state, api, player: { previewBusy: () => false, seek: vi.fn() } as never, ...(ui ? { ui } : {}) });
      const base = projeto();
      state.set("project", projeto({ assembly: { ...base.assembly, sources: [] } }));
      expect(document.getElementById("briefingForm")!.parentElement).toBe(document.getElementById("monitorBriefing"));
      document.getElementById("openBriefing")!.click();
      expect(eventos).toHaveLength(0);
      expect(document.getElementById("briefingDialog")!.showCount).toBe(1);
    }
  });
});
