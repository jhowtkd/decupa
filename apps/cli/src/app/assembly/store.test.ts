import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fixtureAssembly } from "./fixture.ts";
import type { LegacyProject } from "./types.ts";
import { createProject, loadProject, missingMedia, readHistorySnapshot, saveProject, validateProject, validateWord, writeHistorySnapshot } from "./store.ts";

function projectAt(revision: number): LegacyProject {
  const assembly = fixtureAssembly();
  assembly.revision = revision;
  return {
    version: 1,
    id: "p1",
    revision,
    input: { kind: "brief", text: "contar o tema", targetSeconds: 60 },
    assembly,
    scenes: [],
    analyses: [],
    proposal: null,
    structureApprovedRevision: null,
    previewRevision: null,
    finalApprovedRevision: null,
  };
}

it("recusa segunda escrita com a mesma base e mantém a revisão 2", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-store-"));
  await createProject(dir, projectAt(1));
  const next = projectAt(2);
  await saveProject(dir, 1, next);
  await expect(saveProject(dir, 1, next)).rejects.toThrow(/revisão/);
  expect((await loadProject(dir)).revision).toBe(2);
});

it("createProject não sobrescreve um projeto existente", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-store-"));
  await createProject(dir, projectAt(1));
  await expect(createProject(dir, projectAt(1))).rejects.toThrow(/existe/);
  expect((await loadProject(dir)).revision).toBe(1);
});

it("reabre o projeto depois de mudar só o briefing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-store-"));
  await createProject(dir, projectAt(1));
  const next = projectAt(2);
  next.input = { kind: "script", text: "cena 1", targetSeconds: 30 };
  await saveProject(dir, 1, next);
  const loaded = await loadProject(dir);
  expect(loaded.input.text).toBe("cena 1");
  expect(loaded.revision).toBe(2);
});

it("carrega o projeto mesmo com mídia ausente e nomeia as fontes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-store-"));
  await createProject(dir, projectAt(1));
  const loaded = await loadProject(dir);
  const missing = await missingMedia(loaded);
  expect(missing.map((s) => s.id).sort()).toEqual(["a", "b"]);
  expect(missing[0]!.path).toContain("decupa-fixture");
});

it("recusa lock vivo de outro pid", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-store-"));
  await createProject(dir, projectAt(1));
  await writeFile(join(dir, "project.lock"), `${process.pid}\n`, "utf8");
  await expect(saveProject(dir, 1, projectAt(2))).rejects.toThrow(/processo|lock|escreve/i);
});

it("libera lock abandonado depois de conferir o pid", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-store-"));
  await createProject(dir, projectAt(1));
  await writeFile(join(dir, "project.lock"), "99999999\n", "utf8");
  await saveProject(dir, 1, projectAt(2));
  expect((await loadProject(dir)).revision).toBe(2);
});

it("não deixa snapshot antigo na mesma revisão apagar aprovação", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-store-"));
  const initial = projectAt(3);
  initial.analyses = [{
    sourceId: "a",
    key: "k",
    speech: [{ id: "a:u001", sourceId: "a", start: 0, end: 1, text: "olá" }],
    visual: [],
    status: "ready",
  }];
  await createProject(dir, initial);
  const snap = await loadProject(dir);
  await saveProject(dir, 3, { ...snap, previewRevision: 3 });
  await saveProject(dir, 3, { ...snap, analyses: [] });
  const loaded = await loadProject(dir);
  expect(loaded.revision).toBe(3);
  expect(loaded.previewRevision).toBe(3);
  expect(loaded.analyses).toHaveLength(1);
  expect(loaded.analyses[0]!.sourceId).toBe("a");
});

const EMPTY_COVERAGE = { requested: [], returned: [], missing: [] };

function wordFor(sourceId: string, id: string, start = 0.1, end = 0.4) {
  return { id, sourceId, text: "olá", confidence: null as number | null, start, end };
}

it("abre projeto v1 e migra para v2 sem modificar o arquivo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-store-"));
  const v1 = projectAt(1);
  v1.analyses = [{
    sourceId: "a",
    key: "k",
    speech: [{ id: "a:u001", sourceId: "a", start: 0, end: 1, text: "olá" }],
    visual: [],
    status: "ready",
  }];
  await writeFile(join(dir, "project.json"), `${JSON.stringify(v1)}\n`, "utf8");
  const loaded = await loadProject(dir);
  expect(loaded.version).toBe(2);
  expect(loaded.assembly.sources.every((s) => s.included)).toBe(true);
  expect(loaded.corrections).toEqual([]);
  expect(loaded.permissions).toEqual({ model: false, visual: false });
  expect(loaded.preparation).toBeNull();
  expect(loaded.previewArtifact).toBeNull();
  expect(loaded.analyses).toHaveLength(1);
  expect(loaded.analyses[0]!.words).toEqual([]);
  expect(loaded.analyses[0]!.wordsStatus).toBe("missing");
  expect(loaded.analyses[0]!.speech).toHaveLength(1);
  const raw = JSON.parse(await readFile(join(dir, "project.json"), "utf8"));
  expect(raw.version).toBe(1);
  await expect(access(join(dir, "project.v1.backup.json"))).rejects.toThrow();
});

it("primeira gravação v2 preserva backup exclusivo do v1", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-store-"));
  await writeFile(join(dir, "project.json"), `${JSON.stringify(projectAt(1))}\n`, "utf8");
  const loaded = await loadProject(dir);
  await saveProject(dir, loaded.revision, { ...loaded, revision: loaded.revision + 1 });
  const backupPath = join(dir, "project.v1.backup.json");
  const backup = JSON.parse(await readFile(backupPath, "utf8"));
  expect(backup.version).toBe(1);
  const after = await loadProject(dir);
  expect(after.version).toBe(2);
  expect(after.revision).toBe(2);
  const backupBytes = await readFile(backupPath);
  await saveProject(dir, after.revision, { ...after, revision: after.revision + 1 });
  expect(await readFile(backupPath)).toEqual(backupBytes);
  expect((await loadProject(dir)).revision).toBe(3);
});

it("erro de escrita não corrompe o estado", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-store-"));
  await createProject(dir, projectAt(1));
  const before = await readFile(join(dir, "project.json"));
  await expect(saveProject(dir, 1, (current) => ({ ...current, revision: -1 }))).rejects.toThrow(/revision/);
  expect(await readFile(join(dir, "project.json"))).toEqual(before);
  expect((await loadProject(dir)).revision).toBe(1);
});

it("escritor único serializa gravações funcionais concorrentes sem corromper o JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-store-"));
  await createProject(dir, projectAt(1));
  const results = await Promise.allSettled([
    saveProject(dir, 1, (current) => ({
      ...current,
      revision: current.revision + 1,
      input: { ...current.input, text: `${current.input.text}|a` },
    })),
    saveProject(dir, 1, (current) => ({
      ...current,
      revision: current.revision + 1,
      input: { ...current.input, text: `${current.input.text}|b` },
    })),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
  const loaded = await loadProject(dir);
  expect(loaded.revision).toBe(3);
  expect(loaded.input.text).toMatch(/\|a\|b$|\|b\|a$/);
  JSON.parse(await readFile(join(dir, "project.json"), "utf8"));
});

it("rejeita palavras com ID duplicado, tempo inválido ou fonte ausente", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-store-"));
  await createProject(dir, projectAt(1));
  const base = await loadProject(dir);
  const withWords = (words: ReturnType<typeof wordFor>[]) => ({
    ...structuredClone(base),
    analyses: [{
      sourceId: "a", key: "k", speech: [], visual: [], status: "ready" as const,
      words, wordsStatus: "ready" as const, visualCoverage: EMPTY_COVERAGE,
    }],
  });
  const good = wordFor("a", "a:hash:w000000");
  expect(() => validateProject(withWords([good]))).not.toThrow();
  expect(() => validateProject(withWords([good, { ...good }]))).toThrow(/duplicad/);
  expect(() => validateProject(withWords([{ ...good, start: 1, end: 0 }]))).toThrow(/intervalo/);
  expect(() => validateProject(withWords([{ ...good, start: -0.1 }]))).toThrow(/intervalo/);
  expect(() => validateProject(withWords([{ ...good, start: 2.9, end: 3.5 }]))).toThrow(/intervalo/);
  expect(() => validateProject(withWords([{ ...good, start: NaN }]))).toThrow(/finito/);
  expect(() => validateProject(withWords([{ ...good, sourceId: "zz" }]))).toThrow(/fonte/);
});

it("migração converte speechIds em takes usando o catálogo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-store-"));
  const v1 = projectAt(1);
  v1.analyses = [{
    sourceId: "a",
    key: "k",
    speech: [{ id: "a:u001", sourceId: "a", start: 0, end: 1, text: "olá" }],
    visual: [],
    status: "ready",
  }];
  v1.scenes = [{
    id: "s1", objective: "abrir", rationale: "tema",
    speechIds: ["a:u001"], support: [], gaps: [],
  }];
  await writeFile(join(dir, "project.json"), `${JSON.stringify(v1)}\n`, "utf8");
  const loaded = await loadProject(dir);
  expect(loaded.scenes[0]!.speechIds).toEqual(["a:u001"]);
  expect(loaded.scenes[0]!.takes).toEqual([{
    id: "s1:a:u001", sourceId: "a", speechId: "a:u001",
    start: 0, end: 1, removed: [], protected: [],
  }]);
});

it("migração sem catálogo preserva speechIds com takes vazios", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-store-"));
  const v1 = projectAt(1);
  v1.scenes = [{
    id: "s1", objective: "abrir", rationale: "tema",
    speechIds: ["fantasma"], support: [], gaps: [],
  }];
  await writeFile(join(dir, "project.json"), `${JSON.stringify(v1)}\n`, "utf8");
  const loaded = await loadProject(dir);
  expect(loaded.scenes[0]!.takes).toEqual([]);
  expect(loaded.scenes[0]!.speechIds).toEqual(["fantasma"]);
  expect(loaded.analyses).toEqual([]);
});

it("histórico guarda e lê snapshot editorial; ausente estoura", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-store-"));
  await createProject(dir, projectAt(1));
  const loaded = await loadProject(dir);
  await writeHistorySnapshot(dir, loaded);
  const snap = await readHistorySnapshot(dir, 1);
  expect(snap.revision).toBe(1);
  expect(snap.scenes).toEqual(loaded.scenes);
  expect(snap).not.toHaveProperty("permissions");
  await expect(readHistorySnapshot(dir, 99)).rejects.toThrow(/sem histórico/);
});

it("rejeita correção e preparação inválidas", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-store-"));
  await createProject(dir, projectAt(1));
  const base = await loadProject(dir);
  const correction = {
    id: "c1", sourceId: "a", start: 0.1, end: 0.4, text: "Olá",
    status: "pending" as const, words: [],
  };
  expect(() => validateProject({ ...structuredClone(base), corrections: [correction] })).not.toThrow();
  expect(() => validateProject({
    ...structuredClone(base),
    corrections: [{ ...correction, status: "pronta" }],
  })).toThrow(/correção/);
  expect(() => validateProject({
    ...structuredClone(base),
    corrections: [{ ...correction, sourceId: "zz" }],
  })).toThrow(/fonte/);
  const preparation = {
    id: "prep-1", revision: 2, mode: "prepare" as const, request: "",
    status: "running" as const, stage: "audio" as const,
    sources: { a: { media: "ready" as const, audio: "running" as const, visual: "pending" as const } },
  };
  expect(() => validateProject({ ...structuredClone(base), preparation })).not.toThrow();
  expect(() => validateProject({
    ...structuredClone(base),
    preparation: { ...preparation, stage: "forno" },
  })).toThrow(/prepara/);
});

it("validateWord aceita cutStart na pausa anterior e recusa fora da fonte", () => {
  const sources = new Map(fixtureAssembly().sources.map((s) => [s.id, s]));
  const word = validateWord({
    id: "w1", sourceId: "a", text: "Nilton", confidence: null,
    start: 1.0, end: 1.5, cutStart: 0.9, cutEnd: 1.5,
  }, sources);
  expect(word.cutStart).toBe(0.9);
  expect(word.cutEnd).toBe(1.5);
  expect(() => validateWord({
    id: "w1", sourceId: "a", text: "x", confidence: null,
    start: 1.0, end: 1.5, cutStart: -0.1, cutEnd: 1.5,
  }, sources)).toThrow(/fonte/);
  expect(() => validateWord({
    id: "w1", sourceId: "a", text: "x", confidence: null,
    start: 1.0, end: 1.5, cutStart: 1.6, cutEnd: 1.7,
  }, sources)).toThrow(/cutStart/);
});
