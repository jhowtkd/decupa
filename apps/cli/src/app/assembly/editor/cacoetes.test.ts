import { afterEach, expect, it, vi } from "vitest";
import { createState } from "./state.js";
import { installDom, type El } from "./fake-dom.test-helper.ts";
import { fillerSummary, fillerTargets, mountFillerContext, mountFillerReview } from "./cacoetes.js";
import { fillerReport, withFillerCuts } from "../fillers.ts";
import { fillerProject, fixedFillerSnaps } from "../filler-test-helper.ts";

const undoDom = () => vi.unstubAllGlobals();
afterEach(undoDom);

it("seção agrupa cenas, corta/restaura em um pedido e Ouvir inclui vizinhos/folga depois", async () => {
  const p = fillerProject("é"); p.scenes.push({ ...p.scenes[0]!, id: "s2", takes: [{ ...p.scenes[0]!.takes[0]!, id: "t2" }] });
  const report = fillerReport(p);
  const dom = installDom('<div id="contexto"></div><div id="review"></div>');
  const state = createState({ project: p, fillerReport: report });
  const call = vi.fn(async (_path: string, _opts: { body: string }) => ({ res: { ok: true } })), playOriginal = vi.fn();
  const section = mountFillerContext({ state, api: { call }, player: { playOriginal } }, dom.getElementById("contexto")) as El;
  expect(section.children[0]!.textContent).toBe(fillerSummary(report));
  const buttons = section.querySelectorAll("button");
  const cutAll = buttons.find(b => b.textContent === "Cortar todos")!;
  cutAll.click();
  await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1));
  expect(JSON.parse(call.mock.calls[0]![1].body).targets).toHaveLength(2);
  expect(call.mock.calls[0]![0]).toBe("/project/fillers-cut");
  buttons.find(b => b.textContent === "Ouvir")!.click();
  expect(playOriginal).toHaveBeenCalledWith("a", 0, 2);
  const target = report.occurrences[0]!;
  const cut = withFillerCuts(p, [target], fixedFillerSnaps(p), "user");
  state.set("project", cut); state.set("fillerReport", fillerReport(cut));
  const restoreAll = section.querySelectorAll("button").find(b => b.textContent === "Restaurar todos")!;
  await vi.waitFor(() => expect(restoreAll.disabled).toBe(false));
  restoreAll.click();
  await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2));
  expect(call.mock.calls[1]![0]).toBe("/project/fillers-restore");
  expect(JSON.parse(call.mock.calls[1]![1].body).targets).toEqual([{ candidateId: "ambiguous:w2", sceneId: "s1", takeId: "t1" }]);
  const link = mountFillerReview({ state }, dom.getElementById("review"));
  expect(link.textContent).toBe("2 cacoetes para revisar"); link.click(); expect(section.open).toBe(true);
});

it("abstain lista motivo, nota é dica e nunca habilita corte", () => {
  const p = fillerProject("é"); p.analyses[0]!.words[1]!.confidence = null;
  const report = fillerReport(p);
  report.groups[0]!.items[0]!.note = { candidateId: "ambiguous:w2", key: "k", model: "test", questionVersion: "v", score: 0.82 };
  const dom = installDom('<div id="contexto"></div>'), state = createState({ project: p, fillerReport: report });
  const section = mountFillerContext({ state, api: { call: vi.fn() }, player: { playOriginal: vi.fn() } }, dom.getElementById("contexto")) as El;
  expect(section.querySelectorAll("button").map(b => b.textContent)).toEqual(["Ouvir"]);
  expect(section.querySelectorAll("p").map(p => p.textContent).join(" ")).toContain("tempo estimado sem alinhamento");
  expect(section.querySelectorAll("p").map(p => p.textContent).join(" ")).toContain("Jev: provável cacoete · 0,82");
  expect(fillerTargets(report.occurrences, "cut")).toEqual([]);
});


it("cartão conta signal/cut e flexiona singular; kept volta a oferecer Cortar", () => {
  const p = fillerProject(), report = fillerReport(p);
  const dom = installDom('<div id="contexto"></div><div id="review"></div>');
  const state = createState({ project: p, fillerReport: report });
  const link = mountFillerReview({ state }, dom.getElementById("review"));
  expect(link.textContent).toBe("1 cacoete para revisar");
  p.fillerExceptions = [{ wordId: "w2", text: "hã" }];
  state.set("fillerReport", fillerReport(p));
  expect(link.hidden).toBe(true);
  const section = mountFillerContext({ state, api: { call: vi.fn() }, player: { playOriginal: vi.fn() } }, dom.getElementById("contexto")) as El;
  expect(section.querySelectorAll("button").map(b => b.textContent)).toContain("Cortar");
  expect(section.querySelectorAll("button").map(b => b.textContent)).not.toContain("Cortar todos");
  expect(fillerTargets(fillerReport(p).occurrences, "cut")).toHaveLength(1);
  p.analyses[0]!.words[1]!.confidence = null; state.set("fillerReport", fillerReport(p));
  expect(link.hidden).toBe(true);
  expect(section.querySelectorAll("button").map(b => b.textContent)).toEqual(["Ouvir"]);
});

it("Cortar todos num grupo misto preserva kept; Cortar no item permite retirar a exceção", async () => {
  const p = fillerProject();
  p.assembly.sources[0]!.durationSeconds = 4;
  p.scenes[0]!.takes[0]!.end = 3.5;
  p.analyses[0]!.speech.push({ ...p.analyses[0]!.speech[0]!, id: "a:u2", start: 2, end: 3.5 });
  p.analyses[0]!.words.push(...p.analyses[0]!.words.map(w => ({ ...w, id: `next:${w.id}`, start: w.start + 2, end: w.end + 2 })));
  p.fillerExceptions = [{ wordId: "w2", text: "hã" }];
  const report = fillerReport(p);
  expect(report.groups).toHaveLength(1);
  expect(report.groups[0]!.items.map(i => i.state)).toEqual(["kept", "signal"]);
  const dom = installDom('<div id="contexto"></div>'), state = createState({ project: p, fillerReport: report });
  const call = vi.fn(async (_path: string, _opts: { body: string }) => ({ res: { ok: true } }));
  const section = mountFillerContext({ state, api: { call }, player: { playOriginal: vi.fn() } }, dom.getElementById("contexto")) as El;
  section.querySelectorAll("button").find(b => b.textContent === "Cortar todos")!.click();
  await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1));
  expect(JSON.parse(call.mock.calls[0]![1].body).targets).toEqual([{ candidateId: "hesitation:next:w2", sceneId: "s1", takeId: "t1" }]);
  await vi.waitFor(() => expect(section.querySelectorAll("button").find(b => b.textContent === "Cortar")!.disabled).toBe(false));
  section.querySelectorAll("button").find(b => b.textContent === "Cortar")!.click();
  await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2));
  expect(JSON.parse(call.mock.calls[1]![1].body).targets).toEqual([{ candidateId: "hesitation:w2", sceneId: "s1", takeId: "t1" }]);
});
