import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeTriageModel } from "@decupa/triage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureLightVideo, parseRouteMode, resolveInspectVideoPath, runTriage } from "./triage.ts";

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

// O runTriage resolve o provedor pela chave quando ninguém escolhe — sem o
// stub, a suíte dependeria de ZAI_API_KEY existir no shell que roda os testes.
beforeEach(() => {
  vi.stubEnv("ZAI_API_KEY", "test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runTriage", () => {
  it("aplica alegação que confere e devolve o keep-list", async () => {
    const { dir, indexPath, videoPath } = await fixture();
    const model = new FakeTriageModel([
      { unit_ids: ["u001", "u002"], reason: "preroll", restated_by: null, note: "pré-rolo", source: "model" },
    ]);
    const out = await runTriage({ indexPath, videoPath, outDir: dir, model });
    expect(out.keepList).toBe("u003-u005");
  });

  it("grava o catálogo fechado no out, sem texto privado e sem marcar fonte limpa", async () => {
    const { dir, indexPath, videoPath } = await fixture();
    await runTriage({ indexPath, videoPath, outDir: dir, model: new FakeTriageModel([]) });
    const raw = await readFile(join(dir, "catalog.json"), "utf8");
    expect(raw).not.toMatch(/argumento principal|não escala|Nossa, que calor/);
    const catalog = JSON.parse(raw) as {
      sourceClean: boolean;
      candidates: { id: string; kind: string; unitIds: string[]; replacement: string | null }[];
    };
    expect(catalog.sourceClean).toBe(false);
    const ids = catalog.candidates.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const known = new Set(["u001", "u002", "u003", "u004", "u005"]);
    for (const candidate of catalog.candidates) {
      expect(candidate.unitIds.every((id) => known.has(id))).toBe(true);
      if (candidate.replacement) expect(known.has(candidate.replacement)).toBe(true);
    }
    expect(catalog.candidates.some((c) => c.kind === "negation" && c.unitIds.includes("u003"))).toBe(true);
  });

  it("grava no catalog.json a matriz de casos do catálogo fechado", async () => {
    const dir = await mkdtemp(join(tmpdir(), "triage-catalog-matrix-"));
    const indexPath = join(dir, "speech_index.json");
    await writeFile(indexPath, JSON.stringify({
      source_duration: 40,
      budget: { lossless_floor_seconds: 8 },
      topic_runs: [{ keyword: "tema", unit_ids: ["u002", "u003", "u004", "u005", "u006", "u007", "u008", "u009"] }],
      units: [
        { id: "u001", index: 0, start: 0, end: 2, duration: 2, text: "Tá gravando?", speaker: "a", word_count: 2, lead_gap: 0.2 },
        { id: "u002", index: 1, start: 2, end: 4, duration: 2, text: "O gancho do vídeo começa aqui.", speaker: "a", word_count: 6, lead_gap: 0.2 },
        { id: "u003", index: 2, start: 4, end: 6, duration: 2, text: "Agora vai.", speaker: "a", word_count: 2, lead_gap: 0.2 },
        {
          id: "u004", index: 3, start: 6, end: 8, duration: 2, text: "Agora vai.", speaker: "a", word_count: 2,
          lead_gap: 0.2, near_duplicate_of: "u003", similarity: 0.99,
        },
        { id: "u005", index: 4, start: 8, end: 10, duration: 2, text: "Isso não vale para quem já pagou.", speaker: "a", word_count: 7, lead_gap: 0.2 },
        { id: "u006", index: 5, start: 10, end: 12, duration: 2, text: "Foram 15 minutos de espera.", speaker: "a", word_count: 5, lead_gap: 0.2 },
        { id: "u007", index: 6, start: 12, end: 14, duration: 2, text: "Funciona, mas só depois do login.", speaker: "a", word_count: 6, lead_gap: 0.2 },
        {
          id: "u008", index: 7, start: 14, end: 16, duration: 2, text: "Por que isso importa?", speaker: "a",
          word_count: 4, lead_gap: 0.2, is_question: true, has_terminal_punct: true,
        },
        { id: "u009", index: 8, start: 16, end: 18, duration: 2, text: "Eu respondo depois.", speaker: "b", word_count: 3, lead_gap: 4.5 },
        { id: "u010", index: 9, start: 18, end: 20, duration: 2, text: "Ficou bom?", speaker: "b", word_count: 2, lead_gap: 0.2 },
      ],
    }), "utf8");
    const videoPath = join(dir, "v.mp4");
    await writeFile(videoPath, "fixture", "utf8");
    await runTriage({ indexPath, videoPath, outDir: dir, model: new FakeTriageModel([]) });
    const catalog = JSON.parse(await readFile(join(dir, "catalog.json"), "utf8")) as {
      sourceClean: boolean;
      candidates: { id: string; kind: string; unitIds: string[]; replacement: string | null; protected?: boolean }[];
    };
    expect(catalog.sourceClean).toBe(false);
    const kinds = new Set(catalog.candidates.map((c) => c.kind));
    expect([...kinds].sort()).toEqual(expect.arrayContaining([
      "prefix", "suffix", "retake", "negation", "number", "caveat", "protection", "speaker_change", "gap",
    ]));
    expect(catalog.candidates.some((c) => c.kind === "prefix" && c.unitIds.includes("u001"))).toBe(true);
    expect(catalog.candidates.some((c) => c.kind === "suffix" && c.unitIds.includes("u010"))).toBe(true);
    expect(catalog.candidates.some((c) => c.kind === "retake" && c.unitIds.includes("u003") && c.replacement === "u004")).toBe(true);
    expect(catalog.candidates.some((c) => c.kind === "negation" && c.unitIds.includes("u005") && c.protected)).toBe(true);
    expect(catalog.candidates.some((c) => c.kind === "number" && c.unitIds.includes("u006") && c.protected)).toBe(true);
    expect(catalog.candidates.some((c) => c.kind === "caveat" && c.unitIds.includes("u007") && c.protected)).toBe(true);
    expect(catalog.candidates.some((c) => c.kind === "protection" && c.unitIds.includes("u008"))).toBe(true);
    expect(catalog.candidates.some((c) => c.kind === "speaker_change" && c.unitIds.join("+") === "u008+u009")).toBe(true);
    expect(catalog.candidates.some((c) => c.kind === "gap" && c.unitIds.includes("u009"))).toBe(true);
    const known = new Set(["u001", "u002", "u003", "u004", "u005", "u006", "u007", "u008", "u009", "u010"]);
    for (const candidate of catalog.candidates) {
      expect(candidate.unitIds.every((id) => known.has(id))).toBe(true);
      if (candidate.replacement) expect(known.has(candidate.replacement)).toBe(true);
    }
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

  it("hybrid resolvido substitui o passe structure e não chama o modelo", async () => {
    const { dir, indexPath, videoPath } = await fixture();
    const model = new FakeTriageModel([
      { unit_ids: ["u001"], reason: "preroll", restated_by: null, note: "não deveria", source: "model" },
    ]);
    const out = await runTriage({
      indexPath,
      videoPath,
      outDir: dir,
      model,
      routeMode: "hybrid",
      decide: () => ({ applyIds: [] }),
    });
    expect(model.calls.filter((c) => c.kind === "structure")).toHaveLength(0);
    expect(model.calls.filter((c) => c.kind === "inspect")).toHaveLength(0);
    expect(out.keepList).toBe("u001-u005");
  });

  it("hybrid do projeto liga o TypeSafe sem --route e sem texto privado", async () => {
    const dir = await mkdtemp(join(tmpdir(), "triage-decision-"));
    await mkdir(join(dir, ".decupa"), { recursive: true });
    await writeFile(join(dir, ".decupa", "decision.json"), JSON.stringify({ mode: "hybrid" }), "utf8");
    const indexPath = join(dir, "speech_index.json");
    await writeFile(indexPath, JSON.stringify({
      source_duration: 9,
      budget: { lossless_floor_seconds: 4 },
      topic_runs: [{ keyword: "tema", unit_ids: ["u002"] }],
      units: [
        { id: "u001", index: 0, start: 0, end: 2, duration: 2, text: "Tá gravando?", has_terminal_punct: true, word_count: 2 },
        { id: "u002", index: 1, start: 3, end: 5, duration: 2, text: "O gancho do vídeo começa aqui.", has_terminal_punct: true, word_count: 6 },
        { id: "u003", index: 2, start: 6, end: 8, duration: 2, text: "Ficou bom?", has_terminal_punct: true, word_count: 2, is_question: true },
      ],
    }), "utf8");
    const videoPath = join(dir, "v.mp4");
    await writeFile(videoPath, "fake", "utf8");

    let payload: Record<string, unknown> = {};
    let calls = 0;
    const fetchImpl = (async (_input: string | URL, init?: RequestInit) => {
      calls += 1;
      payload = JSON.parse(String(init?.body));
      const questions = (payload.questions ?? {}) as Record<string, unknown>;
      const answers: Record<string, { type: "noul"; noul: number }> = {};
      for (const id of Object.keys(questions)) {
        answers[id] = { type: "noul", noul: id === "prefix:u001" ? 0.92 : 0.1 };
      }
      return new Response(JSON.stringify({ model: "jev-latest", answers }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const model = new FakeTriageModel([
      { unit_ids: ["u001"], reason: "preroll", restated_by: null, note: "não deveria", source: "model" },
    ]);
    const out = await runTriage({
      indexPath,
      videoPath,
      outDir: dir,
      model,
      projectDir: dir,
      env: { TYPESAFE_API_KEY: "sk-typesafe-secret-do-not-log", DECUPA_TYPESAFE: "1", ZAI_API_KEY: "test" },
      fetchImpl,
    });
    expect(calls).toBeGreaterThan(0);
    expect(JSON.stringify(payload)).not.toMatch(/Tá gravando|gancho|Ficou bom/);
    expect(JSON.stringify(payload)).not.toContain("sk-typesafe-secret-do-not-log");
    expect(model.calls.filter((c) => c.kind === "structure")).toHaveLength(0);
    expect(out.keepList).toBe("u002");
  });

  it("desligar o Jev no mesmo projeto volta ao legado e não chama TypeSafe", async () => {
    const dir = await mkdtemp(join(tmpdir(), "triage-jev-off-"));
    await mkdir(join(dir, ".decupa"), { recursive: true });
    await writeFile(join(dir, ".decupa", "decision.json"), JSON.stringify({ mode: "hybrid" }), "utf8");
    const indexPath = join(dir, "speech_index.json");
    await writeFile(indexPath, JSON.stringify({
      source_duration: 9,
      budget: { lossless_floor_seconds: 4 },
      topic_runs: [{ keyword: "tema", unit_ids: ["u002"] }],
      units: [
        { id: "u001", index: 0, start: 0, end: 2, duration: 2, text: "Tá gravando?", has_terminal_punct: true, word_count: 2 },
        { id: "u002", index: 1, start: 3, end: 5, duration: 2, text: "O gancho do vídeo começa aqui.", has_terminal_punct: true, word_count: 6 },
        { id: "u003", index: 2, start: 6, end: 8, duration: 2, text: "Ficou bom?", has_terminal_punct: true, word_count: 2, is_question: true },
      ],
    }), "utf8");
    const videoPath = join(dir, "v.mp4");
    await writeFile(videoPath, "fake", "utf8");
    let calls = 0;
    const fetchImpl = (async (_input: string | URL, init?: RequestInit) => {
      calls += 1;
      const payload = JSON.parse(String(init?.body)) as { questions?: Record<string, unknown> };
      const answers: Record<string, { type: "noul"; noul: number }> = {};
      for (const id of Object.keys(payload.questions ?? {})) {
        answers[id] = { type: "noul", noul: id === "prefix:u001" ? 0.92 : 0.1 };
      }
      return new Response(JSON.stringify({ model: "jev-latest", answers }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const env = { TYPESAFE_API_KEY: "sk-typesafe-secret-do-not-log", DECUPA_TYPESAFE: "1", ZAI_API_KEY: "test" };
    const hybridModel = new FakeTriageModel([
      { unit_ids: ["u001"], reason: "preroll", restated_by: null, note: "não deveria", source: "model" },
    ]);
    const hybrid = await runTriage({
      indexPath, videoPath, outDir: join(dir, "hybrid"), model: hybridModel, projectDir: dir, env, fetchImpl,
    });
    expect(calls).toBeGreaterThan(0);
    expect(hybridModel.calls.filter((c) => c.kind === "structure")).toHaveLength(0);
    expect(hybrid.keepList).toBe("u002");

    await writeFile(join(dir, ".decupa", "decision.json"), JSON.stringify({ mode: "off" }), "utf8");
    const after = calls;
    const offModel = new FakeTriageModel([
      { unit_ids: ["u001"], reason: "preroll", restated_by: null, note: "legado", source: "model" },
    ]);
    const off = await runTriage({
      indexPath, videoPath, outDir: join(dir, "off"), model: offModel, projectDir: dir, env, fetchImpl,
    });
    expect(calls).toBe(after);
    expect(offModel.calls.filter((c) => c.kind === "structure")).toHaveLength(1);
    expect(off.keepList).toBe("u002");
  });

  it("hybrid com TypeSafe decide pelo catálogo e não manda texto privado", async () => {
    const dir = await mkdtemp(join(tmpdir(), "triage-typesafe-"));
    const indexPath = join(dir, "speech_index.json");
    await writeFile(indexPath, JSON.stringify({
      source_duration: 9,
      budget: { lossless_floor_seconds: 4 },
      topic_runs: [{ keyword: "tema", unit_ids: ["u002"] }],
      units: [
        { id: "u001", index: 0, start: 0, end: 2, duration: 2, text: "Tá gravando?", has_terminal_punct: true, word_count: 2 },
        { id: "u002", index: 1, start: 3, end: 5, duration: 2, text: "O gancho do vídeo começa aqui.", has_terminal_punct: true, word_count: 6 },
        { id: "u003", index: 2, start: 6, end: 8, duration: 2, text: "Ficou bom?", has_terminal_punct: true, word_count: 2, is_question: true },
      ],
    }), "utf8");
    const videoPath = join(dir, "v.mp4");
    await writeFile(videoPath, "fake", "utf8");

    let payload: Record<string, unknown> = {};
    const model = new FakeTriageModel([
      { unit_ids: ["u001"], reason: "preroll", restated_by: null, note: "não deveria", source: "model" },
    ]);
    const out = await runTriage({
      indexPath,
      videoPath,
      outDir: dir,
      model,
      routeMode: "hybrid",
      typeSafeClient: {
        decide: async (req) => {
          payload = req as unknown as Record<string, unknown>;
          return {
            model: "jev-latest",
            answers: {
              "prefix:u001": { type: "noul", noul: 0.92 },
              "suffix:u003": { type: "noul", noul: 0.51 },
            },
          };
        },
      },
    });
    expect(JSON.stringify(payload.state)).not.toMatch(/Tá gravando|gancho|Ficou bom/);
    expect(payload.state).toMatchObject({ candidateIds: expect.arrayContaining(["prefix:u001"]) });
    expect(model.calls.filter((c) => c.kind === "structure")).toHaveLength(0);
    expect(out.keepList).toBe("u002");
  });

  it("hybrid na CLI constrói TypeSafe pelo env sem injetar o cliente", async () => {
    const dir = await mkdtemp(join(tmpdir(), "triage-typesafe-env-"));
    const indexPath = join(dir, "speech_index.json");
    await writeFile(indexPath, JSON.stringify({
      source_duration: 9,
      budget: { lossless_floor_seconds: 4 },
      topic_runs: [{ keyword: "tema", unit_ids: ["u002"] }],
      units: [
        { id: "u001", index: 0, start: 0, end: 2, duration: 2, text: "Tá gravando?", has_terminal_punct: true, word_count: 2 },
        { id: "u002", index: 1, start: 3, end: 5, duration: 2, text: "O gancho do vídeo começa aqui.", has_terminal_punct: true, word_count: 6 },
        { id: "u003", index: 2, start: 6, end: 8, duration: 2, text: "Ficou bom?", has_terminal_punct: true, word_count: 2, is_question: true },
      ],
    }), "utf8");
    const videoPath = join(dir, "v.mp4");
    await writeFile(videoPath, "fake", "utf8");
    let calls = 0;
    let payload: Record<string, unknown> = {};
    const fetchImpl = (async (_input: string | URL, init?: RequestInit) => {
      calls += 1;
      payload = JSON.parse(String(init?.body));
      const questions = (payload.questions ?? {}) as Record<string, unknown>;
      const answers: Record<string, { type: "noul"; noul: number }> = {};
      for (const id of Object.keys(questions)) {
        answers[id] = { type: "noul", noul: id === "prefix:u001" ? 0.92 : 0.1 };
      }
      return new Response(JSON.stringify({ model: "jev-latest", answers }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const model = new FakeTriageModel([
      { unit_ids: ["u001"], reason: "preroll", restated_by: null, note: "não deveria", source: "model" },
    ]);
    const out = await runTriage({
      indexPath,
      videoPath,
      outDir: dir,
      model,
      routeMode: "hybrid",
      env: { TYPESAFE_API_KEY: "sk-typesafe-secret-do-not-log", DECUPA_TYPESAFE: "1", ZAI_API_KEY: "test" },
      fetchImpl,
    });
    expect(calls).toBeGreaterThan(0);
    expect(JSON.stringify(payload)).not.toMatch(/Tá gravando|gancho|Ficou bom/);
    expect(JSON.stringify(payload)).not.toContain("sk-typesafe-secret-do-not-log");
    expect(model.calls.filter((c) => c.kind === "structure")).toHaveLength(0);
    expect(out.keepList).toBe("u002");
  });

  it("observe na CLI consulta TypeSafe pelo env mas aplica o legado", async () => {
    const dir = await mkdtemp(join(tmpdir(), "triage-observe-env-"));
    const indexPath = join(dir, "speech_index.json");
    await writeFile(indexPath, JSON.stringify({
      source_duration: 9,
      budget: { lossless_floor_seconds: 4 },
      topic_runs: [{ keyword: "tema", unit_ids: ["u002"] }],
      units: [
        { id: "u001", index: 0, start: 0, end: 2, duration: 2, text: "Tá gravando?", has_terminal_punct: true, word_count: 2 },
        { id: "u002", index: 1, start: 3, end: 5, duration: 2, text: "O gancho do vídeo começa aqui.", has_terminal_punct: true, word_count: 6 },
        { id: "u003", index: 2, start: 6, end: 8, duration: 2, text: "Ficou bom?", has_terminal_punct: true, word_count: 2, is_question: true },
      ],
    }), "utf8");
    const videoPath = join(dir, "v.mp4");
    await writeFile(videoPath, "fake", "utf8");
    let calls = 0;
    let payload: Record<string, unknown> = {};
    const fetchImpl = (async (_input: string | URL, init?: RequestInit) => {
      calls += 1;
      payload = JSON.parse(String(init?.body));
      const questions = (payload.questions ?? {}) as Record<string, unknown>;
      const answers: Record<string, { type: "noul"; noul: number }> = {};
      for (const id of Object.keys(questions)) {
        answers[id] = { type: "noul", noul: id === "prefix:u001" ? 0.92 : 0.1 };
      }
      return new Response(JSON.stringify({ model: "jev-latest", answers }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const env = { TYPESAFE_API_KEY: "sk-typesafe-secret-do-not-log", DECUPA_TYPESAFE: "1", ZAI_API_KEY: "test" };
    const observeModel = new FakeTriageModel([
      { unit_ids: ["u001"], reason: "preroll", restated_by: null, note: "legado", source: "model" },
    ]);
    const observe = await runTriage({
      indexPath,
      videoPath,
      outDir: join(dir, "observe"),
      model: observeModel,
      routeMode: "observe",
      env,
      fetchImpl,
    });
    expect(calls).toBeGreaterThan(0);
    expect(JSON.stringify(payload)).not.toMatch(/Tá gravando|gancho|Ficou bom/);
    expect(JSON.stringify(payload)).not.toContain("sk-typesafe-secret-do-not-log");
    expect(observeModel.calls.filter((c) => c.kind === "structure")).toHaveLength(1);

    const offModel = new FakeTriageModel([
      { unit_ids: ["u001"], reason: "preroll", restated_by: null, note: "legado", source: "model" },
    ]);
    const off = await runTriage({
      indexPath,
      videoPath,
      outDir: join(dir, "off"),
      model: offModel,
      routeMode: "off",
      env,
      fetchImpl,
    });
    expect(observe.keepList).toBe(off.keepList);
  });

  it("off na CLI ainda chama structure uma vez, como o legado", async () => {
    const { dir, indexPath, videoPath } = await fixture();
    const model = new FakeTriageModel([]);
    await runTriage({ indexPath, videoPath, outDir: dir, model, routeMode: "off" });
    expect(model.calls.filter((c) => c.kind === "structure")).toHaveLength(1);
  });

  it("parseRouteMode rejeita valor desconhecido e default é off", () => {
    expect(parseRouteMode()).toBe("off");
    expect(parseRouteMode("hybrid")).toBe("hybrid");
    expect(parseRouteMode("observe")).toBe("observe");
    expect(() => parseRouteMode("full")).toThrow(/inválida/);
  });

  it("não deixa o modelo dropar o take que o mecânico deixou", async () => {
    const dir = await mkdtemp(join(tmpdir(), "triage-occupy-"));
    const indexPath = join(dir, "speech_index.json");
    await writeFile(indexPath, JSON.stringify({
      source_duration: 20,
      budget: { lossless_floor_seconds: 10 },
      topic_runs: [{ keyword: "instituição", unit_ids: ["u001", "u003"] }],
      trim_candidates: [{
        id: "u002",
        seconds: 4.4,
        text: "Quem estuda na instituição quer sentir pertecente",
        reasons: ["almost no content for its length", "very slow (1.1 chars/s) — dead air inside the sentence"],
      }],
      units: [
        { id: "u001", index: 0, start: 0, end: 4, duration: 4, text: "Quem estuda na instituição quer sentir pertecente.", has_terminal_punct: true, word_count: 7 },
        { id: "u002", index: 1, start: 5, end: 9.4, duration: 4.4, text: "Quem estuda na instituição quer sentir pertecente", has_terminal_punct: false, word_count: 7, cps: 1.12, near_duplicate_of: "u001", similarity: 0.95 },
        { id: "u003", index: 2, start: 10, end: 13, duration: 3, text: "Aí você tendo isso em mente fala com a instituição.", has_terminal_punct: true, word_count: 10 },
      ],
    }), "utf8");
    const videoPath = join(dir, "v.mp4");
    await writeFile(videoPath, "fake", "utf8");

    const model = new FakeTriageModel([
      { unit_ids: ["u001"], reason: "retake", restated_by: "u002", note: "chute", source: "model" },
    ]);
    const out = await runTriage({ indexPath, videoPath, outDir: dir, model });
    expect(out.keepList).toContain("u001");
    expect(out.verdicts.some((v) =>
      v.accepted && v.claim.source === "model" && v.claim.unit_ids.includes("u001"),
    )).toBe(false);
  });
});

describe("resolveInspectVideoPath", () => {
  it("prefere visual-proxy.mp4 quando existe ao lado do vídeo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "inspect-proxy-"));
    const videoPath = join(dir, "triage-proxy.mp4");
    const visual = join(dir, "visual-proxy.mp4");
    await writeFile(videoPath, "triage", "utf8");
    await writeFile(visual, "visual", "utf8");
    expect(await resolveInspectVideoPath(videoPath, join(dir, "out"))).toBe(visual);
  });

  it("cai no vídeo da triagem quando visual-proxy não existe", async () => {
    const dir = await mkdtemp(join(tmpdir(), "inspect-proxy-"));
    const videoPath = join(dir, "triage-proxy.mp4");
    await writeFile(videoPath, "triage", "utf8");
    expect(await resolveInspectVideoPath(videoPath, join(dir, "out"))).toBe(videoPath);
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

  it("hybrid ainda inspeciona faixa ambígua no provedor atual", async () => {
    const { dir, indexPath, videoPath, visual, frames } = await withVisual();
    const model = new FakeTriageModel([], [], [
      { unitId: "u004", decision: "drop", note: "olhando para o operador" },
    ]);
    const out = await runTriage({
      indexPath, videoPath, outDir: dir, model, visual, extractFrames: frames,
      routeMode: "hybrid",
      decide: () => ({ applyIds: [] }),
    });
    expect(model.calls.filter((c) => c.kind === "structure")).toHaveLength(0);
    expect(model.calls.filter((c) => c.kind === "inspect")).toHaveLength(1);
    expect(out.reviewFlags.some((f) => f.unitId === "u004" && f.code === "looks_away")).toBe(true);
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

describe("ensureLightVideo", () => {
  const mk = (mb: number, name = "original.mp4") => {
    const dir = mkdtempSync(join(tmpdir(), "decupa-triage-"));
    const path = join(dir, name);
    writeFileSync(path, Buffer.alloc(Math.round(mb * 1024 * 1024)));
    return path;
  };
  const sha256File = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
  const sidecarPath = (outDir: string) => join(outDir, "triage-proxy.source.sha256");

  it("devolve o arquivo quando já é leve", async () => {
    const small = mk(2);
    const transcode = vi.fn();
    expect(await ensureLightVideo(small, join(dirname(small), "out"), { transcode })).toBe(small);
    expect(transcode).not.toHaveBeenCalled();
  });

  it("transcodifica o pesado com os parâmetros do proxy do app", async () => {
    const big = mk(20);
    const outDir = join(dirname(big), "out");
    const seen: Array<{ src: string; dst: string }> = [];
    const proxyPath = await ensureLightVideo(big, outDir, {
      transcode: async (src, dst) => { seen.push({ src, dst }); writeFileSync(dst, "x"); },
    });
    expect(proxyPath.endsWith("triage-proxy.mp4")).toBe(true);
    expect(seen[0]!.src).toBe(big);
  });

  it("não regera proxy que já existe no outDir", async () => {
    const big = mk(20);
    const outDir = join(dirname(big), "out");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "triage-proxy.mp4"), "x");
    // Sidecar provando que este proxy veio deste vídeo.
    writeFileSync(sidecarPath(outDir), `${sha256File(big)}\n`);
    const transcode = vi.fn();
    expect(await ensureLightVideo(big, outDir, { transcode })).toContain("triage-proxy.mp4");
    expect(transcode).not.toHaveBeenCalled();
  });

  it("re-transcodifica quando o proxy existe mas veio de outro vídeo", async () => {
    const big = mk(20);
    // Buffer de zeros seria byte-idêntico ao mk acima; conteúdo distinto dá sha distinto.
    const other = join(dirname(big), "outro.mp4");
    writeFileSync(other, Buffer.alloc(Math.round(20 * 1024 * 1024), 1));
    const outDir = join(dirname(big), "out");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "triage-proxy.mp4"), "proxy do outro vídeo");
    writeFileSync(sidecarPath(outDir), `${sha256File(other)}\n`);
    let calls = 0;
    const proxyPath = await ensureLightVideo(big, outDir, {
      transcode: async (_src, dst) => { calls += 1; writeFileSync(dst, "proxy novo"); },
    });
    expect(calls).toBe(1);
    expect(readFileSync(proxyPath, "utf8")).toBe("proxy novo");
    expect(readFileSync(sidecarPath(outDir), "utf8")).toContain(sha256File(big));
  });

  it("re-transcodifica quando o proxy existe sem sidecar", async () => {
    const big = mk(20);
    const outDir = join(dirname(big), "out");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "triage-proxy.mp4"), "x");
    let calls = 0;
    await ensureLightVideo(big, outDir, {
      transcode: async (_src, dst) => { calls += 1; writeFileSync(dst, "novo"); },
    });
    expect(calls).toBe(1);
    expect(readFileSync(sidecarPath(outDir), "utf8")).toContain(sha256File(big));
  });

  it("proxy do app passa direto, mesmo pesado", async () => {
    const proxy = mk(20, "triage-proxy.mp4");
    const transcode = vi.fn();
    expect(await ensureLightVideo(proxy, join(dirname(proxy), "out"), { transcode })).toBe(proxy);
    expect(transcode).not.toHaveBeenCalled();
  });
});

