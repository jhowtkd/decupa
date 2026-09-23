import { expect, it } from "vitest";
import { createState } from "./state.js";
import { transcriptHtml } from "./texto.js";

type Word = { id: string; text: string; start: number; end: number };
type Analysis = { sourceId: string; status?: string; words: Word[] };

function proj(over: Record<string, unknown> = {}) {
  return {
    revision: 1,
    assembly: { sources: [{ id: "a", name: "A.mp4" }] },
    analyses: [{ sourceId: "a", status: "running", words: [] }] as Analysis[],
    corrections: [] as unknown[],
    scenes: [] as unknown[],
    preparation: { status: "running" },
    ...over,
  };
}

it("set notifica só a chave inscrita", () => {
  const s = createState({ project: null });
  const seen: unknown[] = [];
  s.subscribe("project", (p: unknown) => seen.push(p));
  s.subscribe("operation", () => seen.push("nunca"));
  s.set("project", { revision: 1 });
  expect(seen).toEqual([{ revision: 1 }]);
  expect(s.get("project")).toEqual({ revision: 1 });
});

it("revisão nova reseta watched; mesma revisão preserva", () => {
  const s = createState({ project: { revision: 1 }, watched: { revision: 1, ended: true } });
  const seen: unknown[] = [];
  s.subscribe("watched", (w: unknown) => seen.push(w));
  s.set("project", { revision: 1, previewRevision: 1 });
  expect(s.get("watched")).toEqual({ revision: 1, ended: true });
  expect(seen).toEqual([]);
  s.set("project", { revision: 2, previewRevision: 1 });
  expect(s.get("watched")).toEqual({ revision: null, ended: false });
  expect(seen).toEqual([{ revision: null, ended: false }]);
});

it("ignora snapshots idênticos mas publica progresso na mesma revisão", () => {
  const s = createState();
  const seen: unknown[] = [];
  s.subscribe("project", (p: unknown) => seen.push(p));
  s.set("project", { revision: 2, preparation: { stage: "audio" } });
  s.set("project", { revision: 2, preparation: { stage: "audio" } });
  s.set("project", { revision: 2, preparation: { stage: "visual" } });
  expect(seen).toHaveLength(2);
});

it("primeira transcrição parcial durante a preparação abre a etapa de texto sozinha", () => {
  const s = createState({ stage: "materiais" });
  const seenStage: unknown[] = [];
  s.subscribe("stage", (v: unknown) => seenStage.push(v));

  s.set("project", proj({ analyses: [{ sourceId: "a", status: "running", words: [] }] }));
  expect(s.get("stage")).toBe("materiais");
  expect(seenStage).toEqual([]);

  s.set("project", proj({ analyses: [{ sourceId: "a", status: "running", words: [
    { id: "w1", text: "ola", start: 0, end: 0.5 },
  ] }] }));

  expect(s.get("stage")).toBe("edicao");
  expect(seenStage).toEqual(["edicao"]);
  const html = transcriptHtml(s.get("project") as never);
  expect(html).toContain("ola");
  expect(html).toContain('<span class="parcial">· parcial</span>');
});

it("fora da preparação, o mesmo ganho de palavras não troca a etapa", () => {
  const s = createState({ stage: "materiais" });
  s.set("project", proj({
    preparation: { status: "done" },
    analyses: [{ sourceId: "a", status: "done", words: [] }],
  }));
  s.set("project", proj({
    preparation: { status: "done" },
    analyses: [{ sourceId: "a", status: "done", words: [
      { id: "w1", text: "ola", start: 0, end: 0.5 },
    ] }],
  }));
  expect(s.get("stage")).toBe("materiais");
});

it("etapa de edição ativa não perde foco ao chegar transcrição parcial", () => {
  const selection = new Set(["k1"]);
  const s = createState({ stage: "edicao", selection });
  const seenStage: unknown[] = [];
  s.subscribe("stage", (v: unknown) => seenStage.push(v));

  s.set("project", proj({ analyses: [{ sourceId: "a", status: "running", words: [] }] }));
  s.set("project", proj({ analyses: [{ sourceId: "a", status: "running", words: [
    { id: "w1", text: "ola", start: 0, end: 0.5 },
  ] }] }));

  expect(s.get("stage")).toBe("edicao");
  expect(seenStage).toEqual([]);
  expect(s.get("selection")).toBe(selection);
  const notice = s.get("transcriptNotice") as string;
  expect(notice).toContain("Transcrição disponível");
  expect(notice).toContain("A.mp4");
});

it("com duas fontes, a transcrição de cada uma aparece quando aquela fonte é salva", () => {
  const s = createState({ stage: "edicao" });
  const base = {
    revision: 1,
    assembly: { sources: [{ id: "a", name: "A.mp4" }, { id: "b", name: "B.mp4" }] },
    corrections: [] as unknown[],
    scenes: [] as unknown[],
    preparation: { status: "running" },
  };

  s.set("project", { ...base, analyses: [
    { sourceId: "a", status: "running", words: [] },
    { sourceId: "b", status: "running", words: [] },
  ] });

  s.set("project", { ...base, analyses: [
    { sourceId: "a", status: "running", words: [{ id: "w1", text: "ola", start: 0, end: 0.5 }] },
    { sourceId: "b", status: "running", words: [] },
  ] });

  let html = transcriptHtml(s.get("project") as never);
  expect(html).toMatch(/data-source="a"[\s\S]*ola/);
  expect(html).toMatch(/data-source="b"[\s\S]*transcrição ainda não disponível/);
  let notice = s.get("transcriptNotice") as string;
  expect(notice).toContain("A.mp4");
  expect(notice).not.toContain("B.mp4");
  expect(s.get("stage")).toBe("edicao");

  s.set("project", { ...base, analyses: [
    { sourceId: "a", status: "running", words: [{ id: "w1", text: "ola", start: 0, end: 0.5 }] },
    { sourceId: "b", status: "running", words: [{ id: "w2", text: "mundo", start: 0, end: 0.5 }] },
  ] });

  html = transcriptHtml(s.get("project") as never);
  expect(html).toContain("mundo");
  expect(html).toContain('<span class="parcial">· parcial</span>');
  notice = s.get("transcriptNotice") as string;
  expect(notice).toContain("A.mp4");
  expect(notice).toContain("B.mp4");
  expect(s.get("stage")).toBe("edicao");
});
