import { mkdtemp, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileCoordinator } from "@decupa/coordinator";
import { createTracer } from "@decupa/trace";
import { transcribe } from "@decupa/transcript";
import { FakeExecutor, NO_SPEECH_MESSAGE, runIngest } from "./pipeline.ts";

describe("chave da transcrição", () => {
  it("conteúdo trocado no mesmo caminho chama o worker de novo com outra chave", async () => {
    const root = await mkdtemp(join(tmpdir(), "decupa-taskid-"));
    const input = join(root, "aula.mp4");
    await writeFile(input, "A");
    const work1 = await mkdtemp(join(root, "w-"));
    const work2 = await mkdtemp(join(root, "w-"));
    const coordinator = createFileCoordinator(join(root, "coord"), { limit: 1 });
    const calls: string[] = [];
    const speech = {
      worker: async (req: { taskId: string; language: string }) => {
        calls.push(req.taskId);
        return {
          language: req.language,
          words: [{ text: "oi", startMs: 0, endMs: 80, confidence: 1, sentenceIndex: 0 }],
          unaligned: [],
        };
      },
      extract: async () => {},
      detectSilence: async () => [],
      coordinator,
    };
    await runIngest(
      { id: "j1", videoPath: input, workDir: work1 },
      new FakeExecutor(),
      () => {},
      undefined,
      createTracer(),
      speech,
      undefined,
      { visual: false },
    );
    await writeFile(input, "BB");
    await runIngest(
      { id: "j2", videoPath: input, workDir: work2 },
      new FakeExecutor(),
      () => {},
      undefined,
      createTracer(),
      speech,
      undefined,
      { visual: false },
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]).not.toBe(input);
    expect(calls[1]).not.toBe(input);
    expect(calls[0]).not.toBe(calls[1]);
  });

  it("mtime diferente com o mesmo tamanho chama o worker de novo com outra chave", async () => {
    const root = await mkdtemp(join(tmpdir(), "decupa-taskid-mtime-"));
    const input = join(root, "aula.mp4");
    await writeFile(input, "AAAA");
    const before = await stat(input);
    const work1 = await mkdtemp(join(root, "w-"));
    const work2 = await mkdtemp(join(root, "w-"));
    const coordinator = createFileCoordinator(join(root, "coord"), { limit: 1 });
    const calls: string[] = [];
    const speech = {
      worker: async (req: { taskId: string; language: string }) => {
        calls.push(req.taskId);
        return {
          language: req.language,
          words: [{ text: "oi", startMs: 0, endMs: 80, confidence: 1, sentenceIndex: 0 }],
          unaligned: [],
        };
      },
      extract: async () => {},
      detectSilence: async () => [],
      coordinator,
    };
    await runIngest(
      { id: "j1", videoPath: input, workDir: work1 },
      new FakeExecutor(),
      () => {},
      undefined,
      createTracer(),
      speech,
      undefined,
      { visual: false },
    );
    const shifted = new Date("2019-01-01T00:00:00.000Z");
    await utimes(input, shifted, shifted);
    const after = await stat(input);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).not.toBe(before.mtimeMs);
    await runIngest(
      { id: "j2", videoPath: input, workDir: work2 },
      new FakeExecutor(),
      () => {},
      undefined,
      createTracer(),
      speech,
      undefined,
      { visual: false },
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]).not.toBe(calls[1]);
    expect(calls[0]).toContain(`#${before.size}-${before.mtimeMs}#`);
    expect(calls[1]).toContain(`#${after.size}-${after.mtimeMs}#`);
  });

  it("taskId explícito chega ao worker", async () => {
    const seen: string[] = [];
    await transcribe(
      { input: "/vid/aula.mp4", taskId: "chave" },
      {
        extract: async () => {},
        worker: async (req) => {
          seen.push(req.taskId);
          return { language: req.language, words: [], unaligned: [] };
        },
      },
    );
    expect(seen).toEqual(["chave"]);
  });

  it("sem taskId o worker recebe o caminho", async () => {
    // Guarda: o padrão já era o caminho da fonte.
    const seen: string[] = [];
    await transcribe(
      { input: "/vid/aula.mp4" },
      {
        extract: async () => {},
        worker: async (req) => {
          seen.push(req.taskId);
          return { language: req.language, words: [], unaligned: [] };
        },
      },
    );
    expect(seen).toEqual(["/vid/aula.mp4"]);
  });
});

describe("vazio já registrado e requireSpeech", () => {
  /** Uma pasta com a fonte, o coordenador compartilhado e um worker que conta. */
  async function cenario(respostas: ("vazio" | "fala")[]) {
    const root = await mkdtemp(join(tmpdir(), "decupa-taskid-fala-"));
    const input = join(root, "aula.mp4");
    await writeFile(input, "AAAA");
    const coordinator = createFileCoordinator(join(root, "coord"), { limit: 1 });
    const taskIds: string[] = [];
    const speech = {
      worker: async (req: { taskId: string; language: string }) => {
        const resposta = respostas[taskIds.length] ?? "vazio";
        taskIds.push(req.taskId);
        return {
          language: req.language,
          words: resposta === "fala"
            ? [{ text: "oi", startMs: 0, endMs: 80, confidence: 1, sentenceIndex: 0 }]
            : [],
          unaligned: [],
        };
      },
      extract: async () => {},
      detectSilence: async () => [],
      coordinator,
    };
    const ingerir = async (id: string, requireSpeech?: boolean) => runIngest(
      { id, videoPath: input, workDir: await mkdtemp(join(root, "w-")) },
      new FakeExecutor(),
      () => {},
      undefined,
      createTracer(),
      speech,
      undefined,
      { visual: false, requireSpeech },
    );
    return { taskIds, ingerir };
  }

  it("vazio gravado como completed pela montagem não vence a limpeza: o worker roda de novo e estoura", async () => {
    // Hoje o coordenador devolve o completed vazio, o worker nem é chamado e a
    // mensagem "não foi guardado" sai por outro caminho (e é falsa).
    const { taskIds, ingerir } = await cenario(["vazio", "vazio"]);
    await ingerir("montagem");
    expect(taskIds).toHaveLength(1);
    await expect(ingerir("limpeza", true)).rejects.toThrow(NO_SPEECH_MESSAGE);
    expect(taskIds).toHaveLength(2);
  });

  it("com fala na segunda transcrição, a limpeza conclui", async () => {
    const { taskIds, ingerir } = await cenario(["vazio", "fala"]);
    await ingerir("montagem");
    await expect(ingerir("limpeza", true)).resolves.toBeDefined();
    expect(taskIds).toHaveLength(2);
  });

  it("a chave com requireSpeech termina em #fala e a da montagem não muda", async () => {
    const { taskIds, ingerir } = await cenario(["fala", "fala"]);
    await ingerir("montagem");
    await ingerir("limpeza", true);
    expect(taskIds[0]).not.toMatch(/#fala$/);
    expect(taskIds[1]).toMatch(/#fala$/);
  });
});
