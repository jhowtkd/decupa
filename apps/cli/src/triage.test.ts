import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeTriageModel } from "@decupa/triage";
import { describe, expect, it } from "vitest";
import { runTriage } from "./triage.ts";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "triage-cli-"));
  const indexPath = join(dir, "speech_index.json");
  await writeFile(indexPath, JSON.stringify({
    source_duration: 40,
    budget: { lossless_floor_seconds: 20 },
    topic_runs: [{ keyword: "escala", unit_ids: ["u003", "u005"] }],
    units: [
      { id: "u001", index: 0, start: 0, end: 2, duration: 2, text: "Vamos começar pelo argumento principal." },
      { id: "u002", index: 1, start: 3, end: 5, duration: 2, text: "O ponto é este." },
      { id: "u003", index: 2, start: 6, end: 9, duration: 3, text: "Isso não escala de jeito nenhum." },
      { id: "u004", index: 3, start: 10, end: 12, duration: 2, text: "Nossa, que calor." },
      { id: "u005", index: 4, start: 13, end: 16, duration: 3, text: "Dessa forma não escala a comunicação." },
    ],
  }), "utf8");
  const videoPath = join(dir, "v.mp4");
  await writeFile(videoPath, "não é vídeo de verdade; o modelo é falso neste teste", "utf8");
  return { dir, indexPath, videoPath };
}

describe("runTriage", () => {
  it("aplica alegação que confere e devolve o keep-list", async () => {
    const { dir, indexPath, videoPath } = await fixture();
    const model = new FakeTriageModel([
      { unit_ids: ["u001", "u002"], reason: "preroll", restated_by: null, note: "pré-rolo", source: "model" },
    ]);
    const out = await runTriage({ indexPath, videoPath, outDir: dir, model });
    expect(out.keepList).toBe("u003-u005");
  });

  it("não aplica alegação que não confere, e mantém as unidades", async () => {
    const { dir, indexPath, videoPath } = await fixture();
    const model = new FakeTriageModel([
      // u003 está num topic_run: não pode ser aparte
      { unit_ids: ["u003"], reason: "aside", restated_by: null, note: "chute", source: "model" },
    ]);
    const out = await runTriage({ indexPath, videoPath, outDir: dir, model });
    expect(out.keepList).toBe("u001-u005");
    expect(out.verdicts[0]!.accepted).toBe(false);
  });

  it("grava o relatório com a alegação rejeitada", async () => {
    const { dir, indexPath, videoPath } = await fixture();
    const model = new FakeTriageModel([
      { unit_ids: ["u003"], reason: "aside", restated_by: null, note: "chute", source: "model" },
    ]);
    const out = await runTriage({ indexPath, videoPath, outDir: dir, model });
    const report = await readFile(out.reportPath, "utf8");
    expect(report).toContain("Rejeitado");
    expect(report).toContain("topic_run");
  });

  it("mantém tudo quando o modelo não reivindica nada", async () => {
    const { dir, indexPath, videoPath } = await fixture();
    const out = await runTriage({ indexPath, videoPath, outDir: dir, model: new FakeTriageModel([]) });
    expect(out.keepList).toBe("u001-u005");
  });

  it("não chama o passe de densidade sem alvo", async () => {
    const { dir, indexPath, videoPath } = await fixture();
    const model = new FakeTriageModel([]);
    await runTriage({ indexPath, videoPath, outDir: dir, model });
    expect(model.calls.filter((c) => c.kind === "density")).toHaveLength(0);
  });

  it("chama o passe de densidade quando há alvo", async () => {
    const { dir, indexPath, videoPath } = await fixture();
    const model = new FakeTriageModel([], [{ unit_ids: ["u004"], note: "aparte", rank: 1 }]);
    const out = await runTriage({ indexPath, videoPath, outDir: dir, model, targetSeconds: 15 });
    expect(model.calls.filter((c) => c.kind === "density")).toHaveLength(1);
    expect(out.keepList).toBe("u001-u003 u005");
  });

  it("re-executa densidade quando targetSeconds muda e reusa cache quando é igual", async () => {
    const { dir, indexPath, videoPath } = await fixture();
    const model1 = new FakeTriageModel([], [{ unit_ids: ["u004"], note: "aparte", rank: 1 }]);
    await runTriage({ indexPath, videoPath, outDir: dir, model: model1, targetSeconds: 18 });
    expect(model1.calls.filter((c) => c.kind === "density")).toHaveLength(1);

    // Alvo diferente: deve invalidar a densidade e consultar o modelo novamente
    const model2 = new FakeTriageModel([], [{ unit_ids: ["u004"], note: "aparte", rank: 1 }]);
    await runTriage({ indexPath, videoPath, outDir: dir, model: model2, targetSeconds: 15 });
    expect(model2.calls.filter((c) => c.kind === "density")).toHaveLength(1);

    // Mesmo alvo: deve bater no cache sem chamar o modelo
    const model3 = new FakeTriageModel([], [{ unit_ids: ["u004"], note: "aparte", rank: 1 }]);
    await runTriage({ indexPath, videoPath, outDir: dir, model: model3, targetSeconds: 15 });
    expect(model3.calls.filter((c) => c.kind === "density")).toHaveLength(0);
  });

  it("aplica drops mecânicos mesmo quando o modelo devolve lista vazia", async () => {
    const dir = await mkdtemp(join(tmpdir(), "triage-cli-"));
    const indexPath = join(dir, "speech_index.json");
    await writeFile(indexPath, JSON.stringify({
      source_duration: 40,
      budget: { lossless_floor_seconds: 20 },
      topic_runs: [{ keyword: "escala", unit_ids: ["u003", "u005"] }],
      units: [
        { id: "u001", index: 0, start: 0, end: 2, duration: 2, text: "Eu esqueci o começo, perdão." },
        { id: "u002", index: 1, start: 3, end: 5, duration: 2, text: "Agora vai, calma aí." },
        { id: "u003", index: 2, start: 6, end: 9, duration: 3, text: "Isso não escala de jeito nenhum." },
        { id: "u004", index: 3, start: 10, end: 12, duration: 2, text: "Nossa, que calor." },
        { id: "u005", index: 4, start: 13, end: 16, duration: 3, text: "Dessa forma não escala a comunicação." },
      ],
    }), "utf8");
    const videoPath = join(dir, "v.mp4");
    await writeFile(videoPath, "não é vídeo de verdade; o modelo é falso neste teste", "utf8");

    const out = await runTriage({ indexPath, videoPath, outDir: dir, model: new FakeTriageModel([]) });
    expect(out.keepList).toBe("u003-u005");
    expect(out.verdicts.some((v) => v.accepted && v.claim.source === "mechanical")).toBe(true);
  });
});

describe("runTriage — inspect", () => {
  async function withVisual() {
    const { dir, indexPath, videoPath } = await fixture();
    const visual = [{
      id: "u004",
      looksAway: false,
      handOnFace: false,
      noFace: false,
      ambiguous: true,
      samples: [],
    }];
    const frames = async (unit: { id: string }) => {
      const path = join(dir, `${unit.id}.jpg`);
      await writeFile(path, "jpeg-fake", "utf8");
      return [path];
    };
    return { dir, indexPath, videoPath, visual, frames };
  }

  it("inspect drop sem substituto não muda o keep-list — só flag", async () => {
    const { dir, indexPath, videoPath, visual, frames } = await withVisual();
    const model = new FakeTriageModel([], [], [
      { unitId: "u004", decision: "drop", note: "olhando para o operador" },
    ]);
    const out = await runTriage({
      indexPath, videoPath, outDir: dir, model, visual, extractFrames: frames,
    });
    expect(out.keepList).toBe("u001-u005");
    expect(out.reviewFlags.some((f) => f.unitId === "u004" && f.code === "looks_away")).toBe(true);
    expect(model.calls.filter((c) => c.kind === "inspect")).toHaveLength(1);
  });

  it("inspect que estoura vira flag e não aborta a triagem", async () => {
    const { dir, indexPath, videoPath, visual, frames } = await withVisual();
    const model = new FakeTriageModel();
    model.inspect = async () => {
      throw new Error("a resposta do modelo não é JSON: {{{");
    };
    const out = await runTriage({
      indexPath, videoPath, outDir: dir, model, visual, extractFrames: frames,
    });
    expect(out.keepList).toBe("u001-u005");
    expect(out.reviewFlags.some((f) => f.unitId === "u004" && /inválida/.test(f.message))).toBe(true);
  });

  it("não chama inspect em unidade que não está ambígua", async () => {
    const { dir, indexPath, videoPath, frames } = await withVisual();
    const model = new FakeTriageModel();
    await runTriage({
      indexPath, videoPath, outDir: dir, model,
      visual: [{
        id: "u004", looksAway: true, handOnFace: false, noFace: false,
        ambiguous: false, samples: [],
      }],
      extractFrames: frames,
    });
    expect(model.calls.filter((c) => c.kind === "inspect")).toHaveLength(0);
  });

  it("reusa cache do inspect na segunda corrida", async () => {
    const { dir, indexPath, videoPath, visual, frames } = await withVisual();
    const model1 = new FakeTriageModel([], [], [
      { unitId: "u004", decision: "unsure", note: "não dá" },
    ]);
    await runTriage({ indexPath, videoPath, outDir: dir, model: model1, visual, extractFrames: frames });
    expect(model1.calls.filter((c) => c.kind === "inspect")).toHaveLength(1);

    const model2 = new FakeTriageModel([], [], [
      { unitId: "u004", decision: "drop", note: "não deveria ser chamado" },
    ]);
    const out = await runTriage({
      indexPath, videoPath, outDir: dir, model: model2, visual, extractFrames: frames,
    });
    expect(model2.calls.filter((c) => c.kind === "inspect")).toHaveLength(0);
    expect(out.reviewFlags.some((f) => f.message.includes("não dá"))).toBe(true);
  });

  it("fake inspect no ouro ritmo não muda o keep-list gold", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const fixtures = join(here, "../../../packages/triage/fixtures");
    const gold = (await readFile(join(fixtures, "ritmo.keep.txt"), "utf8")).trim();
    const dir = await mkdtemp(join(tmpdir(), "triage-gold-"));
    const videoPath = join(dir, "v.mp4");
    await writeFile(videoPath, "fake", "utf8");
    const visual = JSON.parse(await readFile(join(fixtures, "ritmo.visual_index.json"), "utf8"));
    const { parseVisualIndex } = await import("@decupa/triage");
    const parsed = parseVisualIndex(visual);
    const frames = async (unit: { id: string }) => {
      const path = join(dir, `${unit.id}.jpg`);
      await writeFile(path, "jpeg-fake", "utf8");
      return [path];
    };
    const model = new FakeTriageModel([], [], [
      { unitId: "u020", decision: "drop", note: "olhando para o operador" },
    ]);
    const out = await runTriage({
      indexPath: join(fixtures, "ritmo.speech_index.json"),
      videoPath,
      outDir: dir,
      model,
      visual: parsed,
      extractFrames: frames,
    });
    expect(out.keepList).toBe(gold);
    expect(out.reviewFlags.some((f) => f.unitId === "u020")).toBe(true);
  });
});

