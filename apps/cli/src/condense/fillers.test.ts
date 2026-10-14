import { describe, expect, it } from "vitest";
import { ambiguousItems, cleanupFillers, fillerPatch, mergeFillerDecisions, selectedFillers, validateSavedFillers } from "./fillers.ts";
import type { CondenseTranscript } from "./prepare.ts";

function fixture(text = "Bom hã hã dia", words = ["Bom", "hã", "hã", "dia"], gaps = [0, 0.05, 0, 0.05]) {
  let cursor = 0;
  const timed = words.map((text, i) => { const start = cursor + gaps[i]!; cursor = start + 0.2; return { text, start, end: cursor }; });
  const index = { transcript_sha256: "sha", units: [{ id: "u001", index: 0, start: 0, end: cursor, duration: cursor, text, words: timed }] };
  const transcript: CondenseTranscript = { segments: [{ start: 0, end: cursor, text, words: timed.map((w, i) => ({ ...w, id: `w${i}`, confidence: 1 })) }] };
  return { index, transcript };
}

describe("cacoetes da Limpeza", () => {
  it("funde hesitações coladas antes de avaliar somente as folgas externas", () => {
    const { index, transcript } = fixture();
    const c = cleanupFillers(index, transcript, "sha").candidates;
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ category: "hesitation", verdict: "cut", wordIds: ["w1", "w2"] });
    expect(c[0]!.end - c[0]!.start).toBeCloseTo(0.4);
  });
  it("não permite que a fusão esconda desalinhamento ou fronteira externa apertada", () => {
    const f = fixture(); f.transcript.segments[0]!.words[2]!.confidence = null;
    expect(cleanupFillers(f.index, f.transcript, "sha").candidates[0]).toMatchObject({ verdict: "abstain", abstainReason: "tempo estimado sem alinhamento" });
    const tight = fixture(undefined, undefined, [0, 0.01, 0, 0.05]);
    expect(cleanupFillers(tight.index, tight.transcript, "sha").candidates[0]!.verdict).toBe("abstain");
  });
  it("mesma contagem com texto divergente abstém a unidade inteira", () => {
    const { index, transcript } = fixture(); transcript.segments[0]!.words[0]!.text = "Outro";
    expect(cleanupFillers(index, transcript, "sha").candidates).toEqual([expect.objectContaining({ verdict: "abstain", abstainReason: "transcrição e índice divergem" })]);
  });
  it("recusa contagem ou hash divergente sem aplicar candidatos restantes", () => {
    const f = fixture(); f.transcript.segments[0]!.words.pop();
    expect(cleanupFillers(f.index, f.transcript, "sha").candidates.every(c => c.verdict === "abstain")).toBe(true);
    const good = fixture(); expect(cleanupFillers(good.index, good.transcript, "outro-sha").candidates[0]!.verdict).toBe("abstain");
  });
  it("usa IDs de fallback vinculados à transcrição, unidade e posição", () => {
    const { index, transcript } = fixture(); transcript.segments[0]!.words.forEach(w => { delete w.id; });
    expect(cleanupFillers(index, transcript, "sha").candidates[0]!.wordIds).toEqual(["sha:u001:1", "sha:u001:2"]);
  });
  it("vírgula colada na palavra impede repetição, e o controle só com espaço corta", () => {
    const comma = fixture("Isso é muito, muito importante.", ["Isso", "é", "muito,", "muito", "importante."], [0, 0.05, 0.05, 0.05, 0.05]);
    expect(comma.transcript.segments[0]!.words.map(w => w.text)).toContain("muito,");
    expect(cleanupFillers(comma.index, comma.transcript, "sha").candidates.filter(c => c.category === "repetition")).toEqual([]);
    const space = fixture("Isso é muito muito importante.", ["Isso", "é", "muito", "muito", "importante."], [0, 0.05, 0.05, 0.05, 0.05]);
    expect(cleanupFillers(space.index, space.transcript, "sha").candidates.find(c => c.category === "repetition"))
      .toMatchObject({ token: "muito", verdict: "cut", wordIds: ["w2"] });
  });
  it("decisões validadas sobrevivem; hash e textos divergentes são descartados com aviso", () => {
    const f = fixture(), catalog = cleanupFillers(f.index, f.transcript, "sha"), c = catalog.candidates[0]!;
    const patch = fillerPatch({ kept: [{ candidateId: c.id, wordIds: c.wordIds }] }, catalog);
    const decisions = mergeFillerDecisions({ cut: [], kept: [] }, patch);
    expect(validateSavedFillers({ transcriptSha256: "sha", ...decisions }, catalog).decisions).toEqual(decisions);
    expect(selectedFillers(catalog, decisions, new Set(["u001"]))).toEqual([]);
    const stale = structuredClone(decisions); stale.kept[0]!.texts = ["humm"];
    expect(validateSavedFillers({ transcriptSha256: "sha", ...stale }, catalog).warnings).toHaveLength(1);
    expect(validateSavedFillers({ transcriptSha256: "outro", ...decisions }, catalog).decisions.kept).toEqual([]);
  });
  it("cut/kept usa a última decisão e rejeita wordIds forjados ou abstain", () => {
    const f = fixture(), catalog = cleanupFillers(f.index, f.transcript, "sha"), c = catalog.candidates[0]!;
    const d = { candidateId: c.id, wordIds: c.wordIds };
    const kept = mergeFillerDecisions({ cut: [], kept: [] }, fillerPatch({ kept: [d] }, catalog));
    const cut = mergeFillerDecisions(kept, fillerPatch({ cut: [d] }, catalog));
    expect(cut.kept).toEqual([]); expect(selectedFillers(catalog, cut, new Set(["u001"]))).toHaveLength(1);
    expect(() => fillerPatch({ cut: [{ ...d, wordIds: ["foreign"] }] }, catalog)).toThrow(/wordIds/);
  });
});

it("candidato cruzando fronteira fica fora da lista do motor", () => {
  const f = fixture(); f.index.units[0]!.start = 0.3;
  f.index.units[0]!.words[1]!.start = 0.25;
  const catalog = cleanupFillers(f.index, f.transcript, "sha");
  expect(catalog.candidates[0]).toMatchObject({ verdict: "abstain", abstainReason: "fora da unidade" });
  expect(selectedFillers(catalog, { cut: [], kept: [] }, new Set(["u001"]))).toEqual([]);
});
it("unidades sem palavras são ignoradas e geram apenas um aviso agregado", () => {
  const f = fixture();
  f.index.units.push({ id: "u002", index: 1, start: 2, end: 3, duration: 1, text: "sem tempos", words: [] },
    { id: "u003", index: 2, start: 4, end: 5, duration: 1, text: "mais uma", words: [] });
  const catalog = cleanupFillers(f.index, f.transcript, "sha");
  expect(catalog.candidates).toHaveLength(1); expect(catalog.warnings).toEqual(["unidades sem palavras foram ignoradas nos cacoetes"]);
  const empty = cleanupFillers({ units: f.index.units.slice(1) }, f.transcript, "sha");
  expect(empty.candidates).toEqual([]); expect(empty.warnings).toHaveLength(1);
});
it("ausência da chave confidence pede legado; null explícito conserva o modo por palavra", () => {
  const f = fixture(); delete f.transcript.segments[0]!.words[0]!.confidence;
  expect(cleanupFillers(f.index, f.transcript, "sha").legacyReason).toContain("transcrição antiga");
  f.transcript.segments[0]!.words[0]!.confidence = null;
  expect(cleanupFillers(f.index, f.transcript, "sha").legacyReason).toBeUndefined();
});
it("catálogo para poda inclui ambíguos abstidos; lista para pontuar os exclui", () => {
  const f = fixture("Bom é dia", ["Bom", "é", "dia"], [0, 0.05, 0.05]);
  f.transcript.segments[0]!.words[1]!.confidence = null;
  const catalog = cleanupFillers(f.index, f.transcript, "sha"), ids = new Set(["u001"]);
  expect(ambiguousItems(catalog, ids)).toEqual([]);
  expect(ambiguousItems(catalog, ids, true)).toEqual([expect.objectContaining({ candidate: expect.objectContaining({ category: "ambiguous", verdict: "abstain" }) })]);
});

it("hash divergente agrega 42 unidades em um aviso, conservando cada abstenção", () => {
  const f = fixture(), base = f.index.units[0]!, segment = f.transcript.segments[0]!;
  f.index.units = Array.from({ length: 42 }, (_, i) => ({ ...base, id: `u${String(i + 1).padStart(3, "0")}`, index: i,
    start: base.start + i * 2, end: base.end + i * 2, words: base.words.map(w => ({ ...w, start: w.start + i * 2, end: w.end + i * 2 })) }));
  f.transcript.segments = f.index.units.map((u, i) => ({ ...segment, start: u.start, end: u.end,
    words: segment.words.map(w => ({ ...w, id: `${i}:${w.id}`, start: w.start + i * 2, end: w.end + i * 2 })) }));
  const catalog = cleanupFillers(f.index, f.transcript, "novo-hash");
  expect(catalog.candidates).toHaveLength(42); expect(catalog.candidates.every(c => c.verdict === "abstain")).toBe(true);
  expect(catalog.warnings).toEqual(["42 unidades: transcrição e índice divergem"]);
});

it("decisões descartadas geram aviso único com contagem por hash ou texto", () => {
  const f = fixture(), catalog = cleanupFillers(f.index, f.transcript, "sha"), c = catalog.candidates[0]!;
  const decisions = Array.from({ length: 20 }, () => ({ candidateId: c.id, wordIds: c.wordIds, texts: ["texto divergente"] }));
  const stale = validateSavedFillers({ transcriptSha256: "outro", cut: [], kept: decisions }, catalog);
  expect(stale.warnings).toEqual(["20 decisões de cacoetes descartadas: a transcrição mudou"]);
  const changed = validateSavedFillers({ transcriptSha256: "sha", cut: [], kept: decisions }, catalog);
  expect(changed.decisions.kept).toEqual([]);
  expect(changed.warnings).toEqual(["20 decisões de cacoetes descartadas: palavras ou texto divergentes"]);
});
