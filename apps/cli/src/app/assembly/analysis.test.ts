import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { hashFile } from "@decupa/media";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import { FakeExecutor, type ExecCall, type Executor } from "../pipeline.ts";
import { analyzeSource, analysisKey, loadAnalysis, wordsFromTranscript } from "./analysis.ts";
import { fixtureAssembly } from "./fixture.ts";
import type { Source } from "./types.ts";

const INDEX = {
  units: [{
    id: "u001",
    index: 1,
    start: 0,
    end: 1.2,
    duration: 1.2,
    text: "olá",
    has_terminal_punct: true,
    is_question: false,
    word_count: 1,
    cps: 1,
    lead_gap: 0,
    disfluency: { hard: [], soft: [], stutter: [] },
  }],
};

async function sourceFrom(path: string, id: string, role: Source["role"]): Promise<Source> {
  const base = fixtureAssembly().sources[0]!;
  return {
    ...base,
    id,
    path,
    sha256: await hashFile(path),
    role,
    hasVideo: path.endsWith(".mp4"),
    hasAudio: true,
  };
}

function indexingExec(): Executor {
  return {
    async run(call: ExecCall) {
      const work = call.env?.CLAUDE_PROJECT_DIR;
      if (work && call.args.includes("index")) {
        await mkdir(join(work, "out"), { recursive: true });
        await writeFile(join(work, "out", "speech_index.json"), `${JSON.stringify(INDEX)}\n`);
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

it("dois arquivos com o mesmo basename compartilham análise pelo hash", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-analysis-"));
  const aPath = join(dir, "cam-a", "take.mp4");
  const bPath = join(dir, "cam-b", "take.mp4");
  await mkdir(join(dir, "cam-a"), { recursive: true });
  await mkdir(join(dir, "cam-b"), { recursive: true });
  await copyFile(join(FIXTURES, "clip.mp4"), aPath);
  await copyFile(join(FIXTURES, "clip.mp4"), bPath);
  const a = await sourceFrom(aPath, "cam-a", "speech");
  const b = await sourceFrom(bPath, "cam-b", "speech");
  expect(a.sha256).toBe(b.sha256);
  const exec = indexingExec();
  const first = await analyzeSource(a, dir, exec);
  expect(first.speech[0]?.id).toBe("cam-a:u001");
  const spy = new FakeExecutor();
  const second = await analyzeSource({ ...b, id: "cam-b" }, dir, spy);
  expect(spy.calls).toHaveLength(0);
  expect(second.speech[0]?.id).toBe("cam-b:u001");
});

it("troca de briefing não dispara o Executor de novo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-analysis-"));
  const path = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), path);
  const source = await sourceFrom(path, "a", "speech");
  await analyzeSource(source, dir, indexingExec());
  const spy = new FakeExecutor({ code: 1, stderr: "não deveria rodar" });
  const again = await analyzeSource(source, dir, spy);
  expect(spy.calls).toHaveLength(0);
  expect(again.status).toBe("ready");
  expect(analysisKey(source.sha256)).toBe(again.key);
});

it("falha de um arquivo não descarta o cache do outro", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-analysis-"));
  const goodPath = join(dir, "good.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), goodPath);
  const good = await sourceFrom(goodPath, "good", "speech");
  await analyzeSource(good, dir, indexingExec());

  const badPath = join(dir, "bad.wav");
  await copyFile(join(FIXTURES, "edited.wav"), badPath);
  const bad = await sourceFrom(badPath, "bad", "speech");
  const failed = await analyzeSource(bad, dir, new FakeExecutor({ code: 1, stderr: "index falhou" }));
  expect(failed.status).toBe("error");
  expect((await loadAnalysis(dir, good))?.status).toBe("ready");
});

it("mídia removida não chama o modelo e nomeia a fonte", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-analysis-"));
  const source = fixtureAssembly().sources[0]!;
  const spy = new FakeExecutor();
  await expect(analyzeSource(source, dir, spy)).rejects.toThrow(/mídia ausente.*\ba\b/);
  expect(spy.calls).toHaveLength(0);
});

it("vídeo sem áudio não transcreve", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-analysis-"));
  const path = join(dir, "apoio.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), path);
  const source = await sourceFrom(path, "b", "support");
  source.hasAudio = false;
  const spy = new FakeExecutor({ code: 1, stderr: "não transcreva" });
  const result = await analyzeSource(source, dir, spy);
  expect(spy.calls).toHaveLength(0);
  expect(result.speech).toEqual([]);
  expect(result.status).toBe("ready");
});

it("preserva palavras e confiança do transcript sem inventar tempos", () => {
  const source = fixtureAssembly().sources[0]!;
  const raw = { segments: [{ words: [
    { text: "Nilton", start: 0.10, end: 0.40, confidence: 0.9 },
    { text: "Pinto", start: 0.42, end: 0.70 },
  ] }] };
  const words = wordsFromTranscript(source, raw);
  expect(words.map(w => w.text)).toEqual(["Nilton", "Pinto"]);
  expect(words[1]!.start).toBe(0.42);
  expect(new Set(words.map(w => w.id)).size).toBe(2);
  expect(words[0]!.confidence).toBe(0.9);
  expect(words[1]!.confidence).toBeNull();
  expect(words.every(w => w.sourceId === "a")).toBe(true);
  expect(() => wordsFromTranscript(source, {
    segments: [{ words: [{ text: "erro", start: 1, end: 0 }] }],
  })).toThrow(/intervalo/);
});

it("rejeita palavra sem tempo válido em vez de estimar", () => {
  const source = fixtureAssembly().sources[0]!;
  expect(() => wordsFromTranscript(source, {
    segments: [{ words: [{ text: "antes", start: -0.1, end: 0.2 }] }],
  })).toThrow(/intervalo/);
  expect(() => wordsFromTranscript(source, {
    segments: [{ words: [{ text: "depois", start: 2.9, end: 3.5 }] }],
  })).toThrow(/intervalo/);
  expect(() => wordsFromTranscript(source, {
    segments: [{ words: [{ text: "nan", start: NaN, end: 0.2 }] }],
  })).toThrow(/intervalo/);
});

it("transcript válido alimenta palavras sem nova ASR no cache", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-analysis-"));
  const path = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), path);
  const source = await sourceFrom(path, "a", "speech");
  const exec: Executor = {
    async run(call: ExecCall) {
      const work = call.env?.CLAUDE_PROJECT_DIR;
      if (work && call.args.includes("index")) {
        await mkdir(join(work, "out"), { recursive: true });
        await writeFile(join(work, "out", "speech_index.json"), `${JSON.stringify(INDEX)}\n`);
        await writeFile(join(work, "transcript.json"), JSON.stringify({ segments: [{ words: [
          { text: "olá", start: 0.1, end: 0.5, confidence: 0.8 },
        ] }] }));
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const first = await analyzeSource(source, dir, exec);
  expect(first.wordsStatus).toBe("ready");
  expect(first.words.map(w => w.text)).toEqual(["olá"]);
  expect(first.words[0]!.id).toContain(`${source.id}:${source.sha256}:w`);
  expect(first.words[0]!.confidence).toBe(0.8);
  const spy = new FakeExecutor({ code: 1, stderr: "não deveria rodar" });
  const second = await analyzeSource(source, dir, spy);
  expect(spy.calls).toHaveLength(0);
  expect(second.words.map(w => w.text)).toEqual(["olá"]);
});

it("cache antigo sem palavras deriva do transcript válido sem retranscrever", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-analysis-"));
  const path = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), path);
  const source = await sourceFrom(path, "a", "speech");
  const { analysisCacheDir, analysisKey: keyOf } = await import("./analysis.ts");
  const cache = analysisCacheDir(dir, source.sha256);
  await mkdir(join(cache, "work"), { recursive: true });
  await writeFile(join(cache, "analysis.json"), JSON.stringify({
    sourceId: source.id, key: keyOf(source.sha256), speech: [], visual: [], status: "ready",
  }));
  await writeFile(join(cache, "work", "transcript.json"), JSON.stringify({ segments: [{ words: [
    { text: "olá", start: 0.1, end: 0.5 },
  ] }] }));
  const spy = new FakeExecutor({ code: 1, stderr: "não deveria rodar" });
  const second = await analyzeSource(source, dir, spy);
  expect(spy.calls).toHaveLength(0);
  expect(second.words.map(w => w.text)).toEqual(["olá"]);
  expect(second.wordsStatus).toBe("ready");
});

it("fonte sem áudio recebe palavras vazias prontas", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-analysis-"));
  const path = join(dir, "apoio.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), path);
  const source = await sourceFrom(path, "b", "support");
  source.hasAudio = false;
  const result = await analyzeSource(source, dir, new FakeExecutor({ code: 1 }));
  expect(result.words).toEqual([]);
  expect(result.wordsStatus).toBe("ready");
});
