import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      { id: "u001", index: 0, start: 0, end: 2, duration: 2, text: "Eu esqueci o começo." },
      { id: "u002", index: 1, start: 3, end: 5, duration: 2, text: "Agora vai." },
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
      { unit_ids: ["u001", "u002"], reason: "preroll", restated_by: null, note: "pré-rolo" },
    ]);
    const out = await runTriage({ indexPath, videoPath, outDir: dir, model });
    expect(out.keepList).toBe("u003-u005");
  });

  it("não aplica alegação que não confere, e mantém as unidades", async () => {
    const { dir, indexPath, videoPath } = await fixture();
    const model = new FakeTriageModel([
      // u003 está num topic_run: não pode ser aparte
      { unit_ids: ["u003"], reason: "aside", restated_by: null, note: "chute" },
    ]);
    const out = await runTriage({ indexPath, videoPath, outDir: dir, model });
    expect(out.keepList).toBe("u001-u005");
    expect(out.verdicts[0]!.accepted).toBe(false);
  });

  it("grava o relatório com a alegação rejeitada", async () => {
    const { dir, indexPath, videoPath } = await fixture();
    const model = new FakeTriageModel([
      { unit_ids: ["u003"], reason: "aside", restated_by: null, note: "chute" },
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
});
