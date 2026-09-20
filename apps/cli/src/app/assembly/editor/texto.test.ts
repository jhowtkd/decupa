import { expect, it } from "vitest";
import {
  acceptedFormatsLabel,
  docSignature,
  emptyGuideHtml,
  menuActionsFor,
  needsEmptyGuide,
  sceneHeaderActions,
} from "./texto.js";

type Sel = { removed?: boolean; protected?: boolean; takeId?: string };

const mantida = (over: Sel = {}): Sel => ({ removed: false, protected: false, takeId: "t1", ...over });

function actionsOf(sel: Sel[]): string[] {
  return menuActionsFor(sel).map((item: { action: string }) => item.action);
}

it("seleção mantida oferece a base ouvir/tirar/preservar/corrigir", () => {
  expect(actionsOf([mantida(), mantida()])).toEqual(["ouvir", "tirar", "preservar", "corrigir"]);
});

it("seleção toda removida troca tirar por restaurar", () => {
  expect(actionsOf([mantida({ removed: true }), mantida({ removed: true })]))
    .toEqual(["ouvir", "restaurar", "preservar", "corrigir"]);
});

it("seleção toda protegida troca preservar por liberar", () => {
  expect(actionsOf([mantida({ protected: true }), mantida({ protected: true })]))
    .toEqual(["ouvir", "tirar", "liberar", "corrigir"]);
});

it("seleção mista mantida+removida não oferece tirar (ambíguo: documentado)", () => {
  // Tirar cortaria só metade e restaurar devolveria a outra: o menu omite
  // tirar na mistura em vez de adivinhar a intenção.
  expect(actionsOf([mantida(), mantida({ removed: true })]))
    .toEqual(["ouvir", "preservar", "corrigir"]);
});

it("seleção em zona omitida (takeId vazio) vira ouvir/incluir", () => {
  expect(actionsOf([
    { removed: false, protected: false, takeId: "" },
    { removed: false, protected: false, takeId: "" },
  ])).toEqual(["ouvir", "incluir"]);
});

it("seleção vazia não abre menu", () => {
  expect(menuActionsFor([])).toEqual([]);
});

it("rótulos em pt-BR e tirar marcado como perigoso", () => {
  for (const item of menuActionsFor([mantida()])) {
    expect(item.label.trim().length).toBeGreaterThan(0);
  }
  const tirar = menuActionsFor([mantida()]).find((item: { action: string }) => item.action === "tirar");
  expect(tirar?.danger).toBe(true);
  const ouvir = menuActionsFor([mantida()]).find((item: { action: string }) => item.action === "ouvir");
  expect(ouvir?.danger ?? false).toBe(false);
});

it("sceneHeaderActions desabilita os extremos e sempre oferece excluir", () => {
  const first = sceneHeaderActions(0, 3);
  expect(first.find((a: { direction?: string }) => a.direction === "up")?.disabled).toBe(true);
  expect(first.find((a: { direction?: string }) => a.direction === "down")?.disabled).toBe(false);
  const last = sceneHeaderActions(2, 3);
  expect(last.find((a: { direction?: string }) => a.direction === "down")?.disabled).toBe(true);
  expect(last.find((a: { direction?: string }) => a.direction === "up")?.disabled).toBe(false);
  const mid = sceneHeaderActions(1, 3);
  expect(mid.every((a: { kind?: string; disabled?: boolean }) => a.kind !== "move" || a.disabled === false)).toBe(true);
  const single = sceneHeaderActions(0, 1);
  expect(single.filter((a: { kind?: string }) => a.kind === "move").every((a: { disabled?: boolean }) => a.disabled)).toBe(true);
  for (const header of [first, last, mid, single]) {
    const del = header.find((a: { kind?: string }) => a.kind === "delete");
    expect(del?.disabled).toBe(false);
  }
});

it("centro vazio pede o guia; com mídia, dá lugar ao conteúdo normal", () => {
  expect(needsEmptyGuide({ assembly: { sources: [] } })).toBe(true);
  expect(needsEmptyGuide({ assembly: { sources: [{ id: "s1" }] } })).toBe(false);
});

it("guia tem 3 passos, formatos do accept e CTA de importação", () => {
  const html = emptyGuideHtml("video/*,audio/*");
  expect(html).toContain("data-empty-guide");
  expect(html.match(/<li>/g)).toHaveLength(3);
  expect(html).toContain("Importe");
  expect(html).toContain("Selecione e arrume o texto");
  expect(html).toContain("Revise e entregue");
  expect(html).toContain("vídeo e áudio");
  expect(html).toContain("data-empty-import");
  expect(html).toContain("Importar mídia");
});

it("formatos derivam do accept: token desconhecido passa cru, vazio some", () => {
  expect(acceptedFormatsLabel("video/*")).toBe("vídeo");
  expect(acceptedFormatsLabel("video/*,audio/*,.srt")).toBe("vídeo, áudio e .srt");
  expect(acceptedFormatsLabel("")).toBe("");
});

function docProject(over: Record<string, unknown> = {}) {
  return {
    assembly: { sources: [{ id: "a" }] },
    analyses: [{ sourceId: "a", words: [
      { id: "w1", text: "ola", start: 0, end: 0.5 },
      { id: "w2", text: "mundo", start: 0.5, end: 1 },
    ] }],
    corrections: [],
    scenes: [{ id: "s1", takes: [{ id: "t1", sourceId: "a", start: 0, end: 1 }] }],
    preparation: null,
    ...over,
  };
}

it("docSignature estável a metadados, sensível a conteúdo", () => {
  expect(docSignature(docProject())).toBe(docSignature(docProject({ revision: 9, previewRevision: 9 })));
});

it("docSignature muda em corte/proteção/correção/texto", () => {
  const base = docSignature(docProject());
  const cut = docProject({ scenes: [{ id: "s1", takes: [{ id: "t1", sourceId: "a", start: 0, end: 1, removed: [{ start: 0, end: 0.5 }] }] }] });
  expect(docSignature(cut)).not.toBe(base);
  const prot = docProject({ scenes: [{ id: "s1", takes: [{ id: "t1", sourceId: "a", start: 0, end: 1, protected: [{ start: 0, end: 1 }] }] }] });
  expect(docSignature(prot)).not.toBe(base);
  const fixed = docProject({ analyses: [{ sourceId: "a", words: [
    { id: "a:sha:c:1:w000001", text: "olá", start: 0, end: 0.5 },
    { id: "w2", text: "mundo", start: 0.5, end: 1 },
  ] }] });
  expect(docSignature(fixed)).not.toBe(base);
});

it("docSignature vazio/transcrito", () => {
  expect(docSignature(null)).toBe("empty");
  expect(docSignature({ assembly: { sources: [] } })).toBe("empty");
  expect(docSignature(docProject({ scenes: [] })).startsWith("transcript|")).toBe(true);
});

it("docSignature no modo transcrito inclui status e nome da fonte", () => {
  const words = [
    { id: "w1", text: "ola", start: 0, end: 0.5 },
    { id: "w2", text: "mundo", start: 0.5, end: 1 },
  ];
  const base = docProject({ scenes: [], analyses: [{ sourceId: "a", status: "ready", words }] });
  const flipped = docProject({ scenes: [], analyses: [{ sourceId: "a", status: "error", words }] });
  expect(docSignature(flipped)).not.toBe(docSignature(base));
  const renamed = docProject({ scenes: [], assembly: { sources: [{ id: "a", name: "b.mp4" }] }, analyses: [{ sourceId: "a", status: "ready", words }] });
  expect(docSignature(renamed)).not.toBe(docSignature(base));
});
