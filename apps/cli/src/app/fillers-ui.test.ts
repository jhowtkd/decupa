import { afterEach, expect, it, vi } from "vitest";
import { installDom, type El } from "./assembly/editor/fake-dom.test-helper.ts";
import { fillerAudition, renderFillerCard, renderFillerCuts } from "./fillers-ui.js";
import { reviewGeneration } from "./review-generation.js";
import { buildReview } from "./review.ts";

afterEach(() => vi.unstubAllGlobals());
const item = { id: "c", wordIds: ["w"], texts: ["hã"], token: "hã", status: "cut", category: "hesitation", unitId: "u002", start: 2.3, end: 2.5 };
const review = { units: [{ id: "u001", start: 0, end: 1.5, kept: true }, { id: "u002", start: 2, end: 4, text: "Bom hã dia", kept: true }, { id: "u003", start: 5, end: 7, kept: true }],
  fillers: { supported: true, warnings: [], groups: [{ token: "hã", items: [item] }], count: 2, totalSeconds: 0.4 },
  joins: [{ isFiller: true, removedSeconds: 0.2 }, { isFiller: false, removedSeconds: 3 }, { isFiller: true, removedSeconds: 0.2 }] };
function all(root: El): El[] { return [root, ...root.children.flatMap(all)]; }

it("cortes de conteúdo continuam individuais e cacoetes ficam num details expansível", () => {
  const dom = installDom('<ol id="cuts"></ol>'), target = dom.getElementById("cuts")!;
  renderFillerCuts(target, review, (text: string) => { const n = dom.createElement("li"); n.textContent = text; return n; }, vi.fn());
  expect(target.children).toHaveLength(2); expect(target.children[0]!.textContent).toBe("Corte 2 · −3,0 s");
  expect(all(target).find(n => n.tag === "summary")!.textContent).toBe("Cacoetes · 2 · −0,4 s");
  expect(all(target).filter(n => /^Corte [13]/.test(n.textContent))).toHaveLength(2);
});
it("linha agregada aparece no plano real legado com kind filler e sem filler_items", () => {
  const dom = installDom('<ol id="cuts"></ol>'), target = dom.getElementById("cuts")!;
  const legacy = buildReview({ clips: [{ unit_ids: ["u001"], out_reason: "filler" }], joins: [
    { outgoing_unit: "u001", incoming_unit: "u001", source_out: 1, source_in: 1.2, kind: "filler", removed_seconds: 0.2 },
    { outgoing_unit: "u001", incoming_unit: "u002", source_out: 4, source_in: 5, kind: "content", removed_seconds: 1 }] },
  { units: [{ id: "u001", index: 0, start: 0, end: 4, text: "Bom hã dia" }] });
  renderFillerCuts(target, legacy, (text: string) => { const n = dom.createElement("li"); n.textContent = text; return n; }, vi.fn());
  expect(all(target).find(n => n.tag === "summary")!.textContent).toBe("Cacoetes · 1 · −0,2 s");
  expect(target.children[0]!.textContent).toBe("Corte 2 · −1,0 s");
});
it("Manter publica identidade da palavra e Ouvir limita cada lado sem incluir lacunas", () => {
  const dom = installDom('<section id="f"></section>'), target = dom.getElementById("f")!, change = vi.fn(), hear = vi.fn();
  renderFillerCard(target, review, [{ candidateId: "c", score: 0.8 }], change, hear);
  all(target).find(n => n.textContent === "Manter esta palavra")!.click();
  expect(change).toHaveBeenCalledWith({ kept: [{ candidateId: "c", wordIds: ["w"] }] });
  all(target).find(n => n.textContent === "Ouvir")!.click();
  expect(hear.mock.calls[0]![0].map((range: number[]) => range.map(n => Number(n.toFixed(2))))).toEqual([[0.3, 1.5], [2, 2.3], [2.5, 4]]);
  expect(all(target).find(n => n.textContent.includes("Jev: 80%"))).toBeDefined();
});
it("motor legado desabilita decisão; abstain e skipped exibem motivo e apenas escuta original", () => {
  const dom = installDom('<section id="f"></section>'), target = dom.getElementById("f")!;
  const legacy = structuredClone(review); legacy.fillers.supported = false;
  renderFillerCard(target, legacy, [], vi.fn(), vi.fn());
  expect(all(target).find(n => n.textContent === "Manter esta palavra")!.disabled).toBe(true);
  expect(all(target).some(n => n.textContent.includes("o motor atual decide estes cortes"))).toBe(true);
  renderFillerCard(target, { ...legacy, fillers: { ...legacy.fillers, groups: [], warnings: ["aviso"] } }, [], vi.fn(), vi.fn());
  expect(target.hidden).toBe(true);
  const skipped = { ...item, status: "skipped", reason: "content_loss" };
  renderFillerCard(target, { ...review, fillers: { ...review.fillers, groups: [{ token: "hã", items: [skipped] }] } }, [], vi.fn(), vi.fn());
  expect(all(target).some(n => n.textContent === "corte perderia conteúdo")).toBe(true);
  expect(all(target).filter(n => n.tag === "button").map(n => n.textContent)).toEqual(["Ouvir"]);
  expect(fillerAudition(skipped, review.units)).toEqual([[2, 4]]);
});
it("Ouvir encontra vizinhos mantidos e usa fronteiras de palavra perto de 1,5 s", () => {
  const units = [{ id: "a", kept: true, start: 0, end: 20, words: [
    { start: 0, end: 18 }, { start: 18, end: 18.9 }, { start: 19, end: 20 }] },
  { id: "removed", kept: false, start: 21, end: 41 },
  { id: "b", kept: true, start: 42, end: 43, words: [{ start: 42, end: 42.2 }, { start: 42.5, end: 43 }] },
  { id: "removed2", kept: false, start: 44, end: 64 },
  { id: "c", kept: true, start: 65, end: 85, words: [{ start: 65, end: 65.8 }, { start: 65.9, end: 67 }, { start: 67, end: 85 }] }];
  const ranges = fillerAudition({ ...item, unitId: "b", start: 42.2, end: 42.5 }, units);
  expect(ranges).toEqual([[19, 20], [42, 42.2], [42.5, 43], [65, 65.8]]);
  expect(ranges.every(([start, end]: number[]) => ![21, 44].some(s => start < s + 20 && end > s))).toBe(true);
});
it("rejeita review antigo e poll durante ação pendente, aceita vencedor e retoma poll depois de falha", () => {
  const gate = reviewGeneration(); expect(gate.accept({ generation: 4 })).toBe(true);
  const a = gate.submit(), b = gate.submit();
  expect(gate.accept({ generation: 4 })).toBe(false);
  expect(gate.accept({ generation: 5 }, a)).toBe(false);
  expect(gate.accept({ generation: 6 }, b)).toBe(true);
  expect(gate.accept({ generation: 5 })).toBe(false);
  const failed = gate.submit(); gate.fail(failed); expect(gate.accept({ generation: 6 })).toBe(true);
});
it("debounce cancelado não deixa a página bloqueada na geração que nunca foi enviada", () => {
  const gate = reviewGeneration(); gate.accept({ generation: 1 });
  const cancelled = gate.submit(); gate.fail(cancelled); const sent = gate.submit();
  expect(gate.accept({ generation: 2 }, sent)).toBe(true); expect(gate.accept({ generation: 2 })).toBe(true);
});
