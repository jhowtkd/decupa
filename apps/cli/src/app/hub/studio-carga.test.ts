// O hub do studio roda o MESMO hub/page.js sobre hub/studio.html: carregar a
// página só lê a lista de Projetos e abrir a gaveta só lê o acervo. Nada de
// criar, enviar ou processar até a pessoa escolher um arquivo.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { domWindow, installDom } from "../assembly/editor/fake-dom.test-helper.ts";
import { criarGaveta } from "./gaveta.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const HTML = readFileSync(new URL("./studio.html", import.meta.url), "utf8");
const BODY = /<body[^>]*>([\s\S]*)<\/body>/.exec(HTML)![1]!.replace(/<script[\s\S]*?<\/script>/g, "");
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** page.js serve ./media-upload.js pelo servidor; aqui o import aponta para o arquivo do editor. */
async function carregarPagina() {
  const dir = mkdtempSync(join(tmpdir(), "hub-studio-carga-"));
  const aqui = (arquivo: string) => pathToFileURL(new URL(arquivo, import.meta.url).pathname).href;
  const fonte = readFileSync(new URL("./page.js", import.meta.url), "utf8")
    .replace('"./media-upload.js"', JSON.stringify(aqui("../assembly/editor/media-upload.js")))
    .replace('"./batch.js"', JSON.stringify(aqui("./batch.js")))
    .replace('"./gaveta.js"', JSON.stringify(aqui("./gaveta.js")));
  const arquivo = join(dir, "page.mjs");
  writeFileSync(arquivo, fonte);
  try {
    await import(/* @vite-ignore */ pathToFileURL(arquivo).href + "?t=" + Date.now());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function montar() {
  const document = installDom('<meta name="decupa-media-enabled" content="true">' + BODY);
  Object.assign(domWindow(), {
    location: { origin: "http://127.0.0.1:1", assign: vi.fn(), hash: "", pathname: "/", search: "" },
    setInterval: vi.fn(() => 1), clearInterval: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(),
  });
  (document as unknown as { hidden: boolean }).hidden = false;
  const chamadas: Array<{ url: string; metodo: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string }) => {
    chamadas.push({ url: String(url), metodo: init?.method ?? "GET" });
    return { ok: true, status: 200, json: async () => [] };
  }));
  return { document, chamadas };
}

it("carregar o hub do studio só faz GET /api/projects; abrir a gaveta só faz GET /api/media", async () => {
  const { document, chamadas } = montar();
  await carregarPagina();
  await flush();
  expect(chamadas).toEqual([{ url: "/api/projects", metodo: "GET" }]);

  document.getElementById("newProject")!.click();
  await flush();
  expect(document.getElementById("newProjectDialog")!.open).toBe(true);
  expect(chamadas.slice(1)).toEqual([{ url: "/api/media", metodo: "GET" }]);
  expect(chamadas.every((chamada) => chamada.metodo === "GET")).toBe(true);
  expect(chamadas.some((chamada) => /project\/new|uploads/.test(chamada.url))).toBe(false);
});

it("modelo: a gaveta não chama transporte nem criação até haver arquivo", () => {
  const criarEnvio = vi.fn();
  const criarImportacaoDrive = vi.fn();
  const enviarCriacao = vi.fn();
  const gaveta = criarGaveta({
    criarEnvio, criarImportacaoDrive, enviarCriacao, chaveDoArquivo: (a: { name: string }) => a.name,
    onCriado: vi.fn(), onChange: vi.fn(),
  });
  gaveta.definirNome("Meu projeto");
  gaveta.definirFluxo("montagem");
  expect(criarEnvio).not.toHaveBeenCalled();
  expect(criarImportacaoDrive).not.toHaveBeenCalled();
  expect(enviarCriacao).not.toHaveBeenCalled();
  expect(gaveta.instantanea().itens ?? []).toHaveLength(0);
});
