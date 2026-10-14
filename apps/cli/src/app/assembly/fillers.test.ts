import { energyEnvelope } from "@decupa/acoustics";
import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { classifyFillers, FILLER_AUTO_CATEGORIES, FILLER_MECHANIC_VERSION, FILLER_MIN_GAP_SECONDS } from "@decupa/triage";
import { fillerCutResult, fillerReport, fillerSnapKey, fillerTokens, withFillerCuts, withoutFillerCuts } from "./fillers.ts";
import { planFillerSnaps } from "./filler-snaps.ts";
import { fillerPcmExec, fillerProject, fixedFillerSnaps } from "./filler-test-helper.ts";
import { applyTextEdit } from "./words.ts";

vi.mock("@decupa/acoustics", async importOriginal => {
  const actual = await importOriginal<typeof import("@decupa/acoustics")>();
  return { ...actual, energyEnvelope: vi.fn(actual.energyEnvelope) };
});

it("adapta unidade, separador e correções; preserva duas ocorrências da mesma fala", () => {
  const p = fillerProject();
  p.scenes.push({ ...p.scenes[0]!, id: "s2", takes: [{ ...p.scenes[0]!.takes[0]!, id: "t2" }] });
  const tokens = fillerTokens(p, p.scenes[0]!.takes[0]!);
  expect(tokens[1]).toMatchObject({ text: "hã", unitId: "a:u1", separatorBefore: " ", unitWordCount: 3, aligned: true, prevEnd: 0.5, nextStart: 0.9 });
  const report = fillerReport(p);
  expect(report.groups[0]!.items.map(i => [i.candidateId, i.sceneId, i.takeId])).toEqual([["hesitation:w2", "s1", "t1"], ["hesitation:w2", "s2", "t2"]]);
  p.corrections = [{ id: "c", sourceId: "a", start: 0.6, end: 0.8, status: "aligned", text: "é", words: [{ ...p.analyses[0]!.words[1]!, text: "é" }] }];
  expect(fillerReport(p).occurrences.every(o => o.candidate.category === "ambiguous")).toBe(true);
});

it("vírgula de ênfase não se torna repetição; pergunta seguida de resposta abstém", () => {
  const p = fillerProject("eu,");
  p.analyses[0]!.speech[0]!.text = "eu, eu, acho";
  expect(classifyFillers(fillerTokens(p, p.scenes[0]!.takes[0]!), FILLER_AUTO_CATEGORIES.montagem, 0.05)).toEqual([]);
  p.analyses[0]!.words[1]!.text = "né?";
  p.analyses[0]!.words[2]!.text = "Sim.";
  p.analyses[0]!.speech = [{ id: "u1", sourceId: "a", start: 0, end: 0.85, text: "eu né?" }, { id: "u2", sourceId: "a", start: 0.9, end: 1.5, text: "Sim." }];
  expect(fillerReport(p).occurrences[0]).toMatchObject({ state: "abstain", reason: "pergunta seguida de resposta" });
});

it("PCM mono 16k é extraído uma vez por take; snap guarda 50–80 ms de cada lado", async () => {
  const p = fillerProject();
  p.analyses[0]!.words[0]!.text = "hã";
  p.analyses[0]!.speech[0]!.text = "hã hã acho";
  const targets = fillerReport(p).occurrences;
  let calls = 0;
  vi.mocked(energyEnvelope).mockClear();
  const snaps = await planFillerSnaps(p, targets, { exec: fillerPcmExec(() => calls++) });
  expect(calls).toBe(1);
  expect(energyEnvelope).toHaveBeenCalledTimes(1);
  const second = snaps[fillerSnapKey(targets[1]!)]!;
  expect("range" in second).toBe(true);
  if (!("range" in second)) return;
  expect(second.range.start - 0.5).toBeGreaterThanOrEqual(0.05 - 1e-9);
  expect(second.range.start - 0.5).toBeLessThanOrEqual(0.08);
  expect(0.9 - second.range.end).toBeGreaterThanOrEqual(0.05 - 1e-9);
  expect(0.9 - second.range.end).toBeLessThanOrEqual(0.08);
  expect(FILLER_MECHANIC_VERSION.montagem).toBe("montagem:2");
});

it("abstém sem corredor, alinhamento, ou PCM, e nunca perde palavra mantida", async () => {
  const p = fillerProject(), target = fillerReport(p).occurrences[0]!;
  p.analyses[0]!.words[0]!.end = 0.58;
  let calls = 0;
  const snaps = await planFillerSnaps(p, [target], { exec: fillerPcmExec(() => calls++) });
  expect(calls).toBe(0);
  expect(Object.values(snaps)[0]).toMatchObject({ abstain: true, reason: "fronteira sem corredor livre" });
  const aligned = fillerProject();
  expect(fillerCutResult(aligned, aligned.scenes[0]!.takes[0]!, target.candidate, { start: 0.25, end: 0.85 })).toBe("corte levaria palavra mantida");
  aligned.analyses[0]!.words[1]!.confidence = null;
  expect(fillerReport(aligned).occurrences[0]).toMatchObject({ state: "abstain", reason: "tempo estimado sem alinhamento" });
  const failed = await planFillerSnaps(fillerProject(), [target], { exec: { run: async () => ({ code: 1, stdout: "", stderr: "" }) } });
  expect(Object.values(failed)[0]).toMatchObject({ abstain: true });
});

it("delta inclui o vão fundido e restaura sem as sobras de 50 ms", () => {
  const p = fillerProject();
  const target = fillerReport(p).occurrences[0]!;
  const cut = withFillerCuts(p, [target], fixedFillerSnaps(p), "user");
  expect(cut.scenes[0]!.takes[0]!.fillers!.cuts[0]!.effective).toEqual([{ start: 0.55, end: 0.85 }]);
  const restored = withoutFillerCuts(cut, [target]);
  expect(restored.scenes[0]!.takes[0]!.removed).toEqual([]);
  expect(restored.fillerExceptions).toEqual([{ wordId: "w2", text: "hã" }]);
  p.analyses[0]!.words[0]!.end = 0.3;
  p.scenes[0]!.takes[0]!.removed = [{ start: 0.4, end: 0.5 }];
  const merged = withFillerCuts(p, [target], fixedFillerSnaps(p), "auto");
  expect(merged.scenes[0]!.takes[0]!.fillers!.cuts[0]!.effective).toEqual([{ start: 0.5, end: 0.85 }]);
  expect(withoutFillerCuts(merged, [target]).scenes[0]!.takes[0]!.removed).toEqual([{ start: 0.4, end: 0.5 }]);
});

it("restaurar pelo texto usa o delta; remoção manual que o cobre absorve a camada", () => {
  const p = fillerProject(), target = fillerReport(p).occurrences[0]!;
  const cut = withFillerCuts(p, [target], fixedFillerSnaps(p), "auto");
  const restored = applyTextEdit(cut, { type: "restore", sceneId: "s1", takeId: "t1", wordIds: ["w2"] });
  expect(restored.scenes[0]!.takes[0]!.removed).toEqual([]);
  expect(restored.fillerExceptions).toEqual([{ wordId: "w2", text: "hã" }]);
  expect(p.analyses[0]!.words.every(w => w.cutStart === undefined && w.cutEnd === undefined)).toBe(true);
  const manual = applyTextEdit(cut, { type: "remove", sceneId: "s1", takeId: "t1", wordIds: ["w2", "w3"] });
  expect(manual.scenes[0]!.takes[0]!.removed).toEqual([{ start: 0.55, end: 1.3 }]);
  expect(manual.scenes[0]!.takes[0]!.fillers!.cuts).toEqual([]);
  expect(withoutFillerCuts(manual, [target])).toBe(manual);
  expect(fillerReport(manual).groups).toEqual([]);
});

it("snap antigo, proteção e exceção não cortam; texto divergente ignora exceção", () => {
  const p = fillerProject(), target = fillerReport(p).occurrences[0]!, snaps = fixedFillerSnaps(p);
  const changed = structuredClone(p); changed.analyses[0]!.words[1]!.start = 0.61;
  expect(withFillerCuts(changed, [target], snaps, "auto")).toBe(changed);
  expect(fillerReport(changed, { snaps }).occurrences[0]).toMatchObject({ state: "abstain", reason: "palavras mudaram; reabra os cacoetes" });
  const protectedP = structuredClone(p); protectedP.scenes[0]!.takes[0]!.protected = [{ start: 0.6, end: 0.8 }];
  expect(withFillerCuts(protectedP, [target], snaps, "auto")).toBe(protectedP);
  p.fillerExceptions = [{ wordId: "w2", text: "hã" }]; p.scenes[0]!.takes[0]!.id = "new";
  const newTarget = fillerReport(p).occurrences[0]!;
  expect(newTarget.state).toBe("kept");
  expect(withFillerCuts(p, [newTarget], fixedFillerSnaps(p), "auto")).toBe(p);
  p.fillerExceptions[0]!.text = "texto velho";
  expect(withFillerCuts(p, [newTarget], fixedFillerSnaps(p), "auto").scenes[0]!.takes[0]!.removed).not.toEqual([]);
});

it("fragmento menor que um quadro abstém sem apagar o que foi mantido", () => {
  const p = fillerProject(), target = fillerReport(p).occurrences[0]!;
  const result = fillerCutResult(p, p.scenes[0]!.takes[0]!, target.candidate, { start: 0.01, end: 0.85 });
  expect(result).toBe("corte levaria palavra mantida");
  p.scenes[0]!.takes[0]!.removed = [{ start: 0.02, end: 0.5 }];
  expect(fillerCutResult(p, p.scenes[0]!.takes[0]!, target.candidate, { start: 0.5, end: 0.85 })).toBe("fragmento menor que um quadro");
});

it("canário ritmo mostra tags/Entende e sete tá verbais sem corte automático", async () => {
  const raw = JSON.parse(await readFile(new URL("../../../../../packages/triage/fixtures/ritmo.speech_index.json", import.meta.url), "utf8"));
  const p = fillerProject();
  // O fixture não contém scores. Alinhamento simulado verifica regras textuais, sem escuta ou qualidade temporal.
  p.assembly.sources[0]!.durationSeconds = 1000;
  p.scenes[0]!.takes[0] = { ...p.scenes[0]!.takes[0]!, start: 0, end: 1000 };
  p.analyses[0]!.speech = raw.units.map((u: { id: string; start: number; end: number; text: string }) => ({ ...u, sourceId: "a" }));
  p.analyses[0]!.words = raw.units.flatMap((u: { id: string; words: { text: string; start: number; end: number }[] }) => u.words.map((w, i) => ({ ...w, id: `${u.id}:w${i}`, sourceId: "a", confidence: 0.9 })));
  const items = fillerReport(p).occurrences;
  expect(items.filter(o => o.state === "signal" && o.candidate.category === "tag_final").map(o => o.candidate.wordIds[0]!.split(":")[0])).toEqual(["u037", "u040"]);
  expect(items.find(o => o.candidate.wordIds[0]!.startsWith("u003:"))!.candidate.category).toBe("unit_only_filler");
  expect(items.filter(o => o.candidate.token === "tá" && o.candidate.category === "ambiguous")).toHaveLength(7);
  expect(items.some(o => o.state === "cut")).toBe(false);
  expect(FILLER_MIN_GAP_SECONDS.montagem).toBe(0.05);
});

it("retranscrição mantém corte anterior visível/restaurável sem decidir sobre a palavra nova", () => {
  const p = fillerProject(), target = fillerReport(p).occurrences[0]!;
  const cut = withFillerCuts(p, [target], fixedFillerSnaps(p), "user");
  const retranscribed = structuredClone(cut);
  retranscribed.analyses[0]!.words[1]!.text = "tá";
  retranscribed.analyses[0]!.speech[0]!.text = "eu tá acho";
  const report = fillerReport(retranscribed);
  expect(report.groups[0]!.items[0]).toMatchObject({ state: "cut", previousGeneration: true, wordTexts: ["hã"], reason: "corte de cacoete de uma transcrição anterior" });
  expect(report.occurrences.find(o => o.candidate.category === "ambiguous")!.state).toBe("absorbed");
  expect(retranscribed.scenes[0]!.takes[0]!.removed).toEqual([{ start: 0.55, end: 0.85 }]);
  const restored = withoutFillerCuts(retranscribed, [target]);
  expect(restored.scenes[0]!.takes[0]!.removed).toEqual([]);
  expect(restored.fillerExceptions).toEqual([]);
  const legacy = structuredClone(retranscribed); delete legacy.scenes[0]!.takes[0]!.fillers!.cuts[0]!.generation;
  expect(fillerReport(legacy).groups[0]!.items[0]!.previousGeneration).toBe(true);
  expect(withoutFillerCuts(legacy, [target]).scenes[0]!.takes[0]!.removed).toEqual([]);
});

it("cache acústico reutiliza somente snapKey e assinatura atuais", async () => {
  const p = fillerProject(), target = fillerReport(p).occurrences[0]!;
  let calls = 0; const exec = fillerPcmExec(() => calls++);
  const cache = await planFillerSnaps(p, [target], { exec });
  await planFillerSnaps(p, [target], { exec, cache }); expect(calls).toBe(1);
  p.analyses[0]!.words[1]!.start = 0.61;
  await planFillerSnaps(p, [target], { exec, cache }); expect(calls).toBe(2);
});


it("camada legada continua visível quando a segmentação muda a categoria", () => {
  const p = fillerProject(), target = fillerReport(p).occurrences[0]!;
  const cut = withFillerCuts(p, [target], fixedFillerSnaps(p), "auto");
  delete cut.scenes[0]!.takes[0]!.fillers!.cuts[0]!.generation;
  cut.analyses[0]!.speech = [{ id: "first", sourceId: "a", start: 0, end: 0.5, text: "eu" },
    { id: "filler", sourceId: "a", start: 0.55, end: 0.85, text: "hã" },
    { id: "last", sourceId: "a", start: 0.9, end: 1.5, text: "acho" }];
  expect(fillerReport(cut).groups[0]!.items[0]).toMatchObject({ state: "cut", candidateId: "hesitation:w2" });
  expect(withoutFillerCuts(cut, [target]).scenes[0]!.takes[0]!.removed).toEqual([]);
});


it("correção distante mantém geração do corte; clique restaura delta inteiro e exceção", () => {
  const p = fillerProject();
  p.analyses[0]!.words.push({ id: "w4", sourceId: "a", start: 1.6, end: 1.9, text: "longe", confidence: 0.9 });
  p.analyses[0]!.speech.push({ id: "u2", sourceId: "a", start: 1.5, end: 2, text: "longe" });
  const target = fillerReport(p).occurrences[0]!;
  const cut = withFillerCuts(p, [target], fixedFillerSnaps(p), "user");
  cut.corrections = [{ id: "corr", sourceId: "a", start: 1.6, end: 1.9, text: "distante", status: "aligned",
    words: [{ ...p.analyses[0]!.words[3]!, text: "distante" }] }];
  expect(fillerReport(cut).occurrences[0]).toMatchObject({ state: "cut" });
  expect(fillerReport(cut).occurrences[0]!.previousGeneration).not.toBe(true);
  const restored = applyTextEdit(cut, { type: "restore", sceneId: "s1", takeId: "t1", wordIds: ["w2"] });
  expect(restored.scenes[0]!.takes[0]!.removed).toEqual([]);
  expect(restored.fillerExceptions).toEqual([{ wordId: "w2", text: "hã" }]);
  const neighbor = structuredClone(cut); neighbor.analyses[0]!.words[2]!.text = "acha";
  expect(fillerReport(neighbor).groups[0]!.items[0]!.previousGeneration).toBe(true);
});

it("Cortar mantido remove a exceção só após snap seguro; automático continua isento", async () => {
  const p = fillerProject(), item = fillerReport(p).occurrences[0]!;
  const restored = withoutFillerCuts(withFillerCuts(p, [item], fixedFillerSnaps(p), "user"), [item]);
  expect(fillerReport(restored).occurrences[0]!.state).toBe("kept");
  const snaps = await planFillerSnaps(restored, [item], { exec: fillerPcmExec() });
  expect(withFillerCuts(restored, [item], snaps, "auto")).toBe(restored);
  const cut = withFillerCuts(restored, [item], snaps, "user");
  expect(cut.fillerExceptions).toEqual([]);
  expect(cut.scenes[0]!.takes[0]!.fillers!.cuts).toHaveLength(1);
  expect(withFillerCuts(restored, [item], {}, "user")).toBe(restored);
  restored.analyses[0]!.words[0]!.end = 0.59;
  expect(fillerReport(restored).occurrences[0]!.state).toBe("abstain");
});


it("extração acústica tem timeout e expõe motivo legível sem fechar o candidato", async () => {
  const p = fillerProject(), target = fillerReport(p).occurrences[0]!, timeout = new AbortController();
  const timer = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
  try {
    const snaps = await planFillerSnaps(p, [target], { exec: { run: async call => {
      expect(call.signal).toBe(timeout.signal);
      timeout.abort(new DOMException("demora simulada", "TimeoutError"));
      throw timeout.signal.reason;
    } } });
    expect(timer).toHaveBeenCalledWith(30_000);
    expect(Object.values(snaps)[0]).toMatchObject({ transient: true, abstain: true, reason: "leitura acústica excedeu 30 segundos; tente novamente" });
  } finally { timer.mockRestore(); }
});
