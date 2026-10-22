// A UI da Reserva / Modo Leitura sobre o markup real das duas páginas.
import { readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { mountEditReservationUI } from "./edit-reservation-ui.js";
import { installDom } from "./assembly/editor/fake-dom.test-helper.ts";

afterEach(() => { vi.unstubAllGlobals(); });

const ASSEMBLY = new URL("./assembly/", import.meta.url);
const PAGINAS = ["page.html", "studio.html"] as const;

async function body(pagina: string): Promise<string> {
  const html = await readFile(new URL(pagina, ASSEMBLY), "utf8");
  const m = /<body[^>]*>([\s\S]*)<\/body>/.exec(html);
  expect(m, pagina).not.toBeNull();
  return m![1]!.replace(/<script[\s\S]*?<\/script>/g, "");
}

it("o studio carrega o mesmo page.js, que monta a UI da Reserva", async () => {
  const [legacy, studio, js] = await Promise.all([
    readFile(new URL("page.html", ASSEMBLY), "utf8"),
    readFile(new URL("studio.html", ASSEMBLY), "utf8"),
    readFile(new URL("page.js", ASSEMBLY), "utf8"),
  ]);
  for (const html of [legacy, studio]) {
    for (const id of ["editReservation", "editReservationText", "reservationTake"]) expect(html).toContain(`id="${id}"`);
    expect(html).toMatch(/<script[^>]*src="__DECUPA_PROJECT_JS__"/);
  }
  expect(js).toContain('from "./edit-reservation-ui.js"');
  expect(js).toContain("mountEditReservationUI(");
});

it.each(PAGINAS)("%s: outra aba dona → Modo Leitura, controles desabilitados, faixa visível", async (pagina) => {
  const document = installDom(await body(pagina));
  vi.stubGlobal("MutationObserver", class { observe() {} });
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: false,
    status: 409,
    json: async () => ({ error: "em edição", dono: { nome: "Maria", ultimoSinal: Date.now() } }),
  })));
  const donos: unknown[] = [];
  const reserva = mountEditReservationUI({
    onReadOnly: (owner: unknown) => donos.push(owner),
    tabIdentity: { ready: () => new Promise(() => {}), onChange: () => {} },
  });

  reserva.handleConflict({ dono: { nome: "Maria", ultimoSinal: Date.now() } });

  expect(reserva.isReadOnly()).toBe(true);
  expect(document.body.classList.contains("modo-leitura")).toBe(true);
  const faixa = document.getElementById("editReservation")!;
  expect(faixa.hidden).toBe(false);
  expect(document.getElementById("editReservationText")!.textContent).toContain("Maria");
  // Controles de edição ficam desabilitados; o "Assumir Edição", as etapas e
  // o que só mostra região (Monitor na legacy, painéis no studio), não.
  const travados = document.querySelectorAll("button, input, textarea, select")
    .filter((el) => el.disabled).map((el) => el.id);
  expect(travados).toContain("newProject");
  expect(document.getElementById("reservationTake")!.disabled).toBe(false);
  const navegacao = pagina === "studio.html" ? ["railToggle", "inspectorToggle"] : ["monitorToggle", "closeMonitor"];
  for (const id of navegacao) expect(document.getElementById(id)!.disabled, id).toBe(false);
  for (const etapa of document.querySelectorAll("[data-stage]")) expect(etapa.disabled).toBe(false);

  // Sem dono, volta ao normal.
  reserva.setReadOnly(null, { confirmed: true });
  expect(document.body.classList.contains("modo-leitura")).toBe(false);
  expect(document.getElementById("editReservation")!.hidden).toBe(true);
  expect(document.getElementById("newProject")!.disabled).toBe(false);
});
