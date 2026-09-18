import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileCoordinator } from "@decupa/coordinator";
import type { AlignTextDeps } from "./transcribe.ts";
import { alignText, parseSidecarOutput, transcribe } from "./transcribe.ts";

describe("parseSidecarOutput", () => {
  it("lê language e words", () => {
    const out = parseSidecarOutput(
      JSON.stringify({ language: "pt", words: [{ text: "oi", startMs: 0, endMs: 100 }] }),
    );
    expect(out.language).toBe("pt");
    expect(out.words).toHaveLength(1);
  });

  it("aceita transcrição de áudio mudo: words vazio é válido", () => {
    expect(parseSidecarOutput(JSON.stringify({ language: "pt", words: [] })).words).toEqual([]);
  });

  it("stdout não-JSON estoura com o começo da saída, não com SyntaxError cru", () => {
    expect(() => parseSidecarOutput("Downloading model...\n")).toThrow(/não é JSON.*Downloading/);
  });

  it("saída sem a forma prometida nomeia o sidecar", () => {
    expect(() => parseSidecarOutput(JSON.stringify({ ok: true }))).toThrow(/transcribe\.py/);
  });

  it("lê o campo unaligned sem exigir tempo", () => {
    const out = parseSidecarOutput(JSON.stringify({
      language: "pt",
      words: [{ text: "Tom", startMs: 0, endMs: 100 }],
      unaligned: ["Nilton"],
    }));
    expect(out.unaligned).toEqual(["Nilton"]);
  });

  it("transcript antigo sem unaligned continua válido", () => {
    const out = parseSidecarOutput(JSON.stringify({ language: "pt", words: [] }));
    expect(out.unaligned).toEqual([]);
  });
});

describe("alignText", () => {
  function depsFor(stdout: string, seen: { extract?: object; args?: string[] }): AlignTextDeps {
    return {
      extract: async (opts) => { seen.extract = opts; },
      runSidecar: async (args) => { seen.args = args; return stdout; },
    };
  }

  const words = (list: { text: string; startMs: number; endMs: number }[]) =>
    JSON.stringify({ language: "pt", words: list, unaligned: [] });

  it("soma a origem uma única vez: offset 10s + 0.2s local = 10.2s", async () => {
    const seen: { extract?: object; args?: string[] } = {};
    const result = await alignText(
      { input: "fonte.mp4", text: "olá mundo", startSeconds: 10, endSeconds: 12 },
      depsFor(words([
        { text: "olá", startMs: 200, endMs: 400 },
        { text: "mundo", startMs: 450, endMs: 800 },
      ]), seen),
    );
    expect(seen.extract).toMatchObject({ input: "fonte.mp4", startSeconds: 10, durationSeconds: 2 });
    expect(seen.args).toContain("--text-file");
    expect(result.tokens.map((t) => [t.startMs, t.endMs])).toEqual([[10200, 10400], [10450, 10800]]);
  });

  it("palavra não alinhada não ganha tempo inventado: estoura nomeando", async () => {
    const seen: { extract?: object; args?: string[] } = {};
    await expect(alignText(
      { input: "fonte.mp4", text: "Nilton Pinto", startSeconds: 0, endSeconds: 2 },
      depsFor(JSON.stringify({
        language: "pt",
        words: [{ text: "Pinto", startMs: 400, endMs: 700 }],
        unaligned: ["Nilton"],
      }), seen),
    )).rejects.toThrow(/sem correspondência.*Nilton/);
  });

  it("resultado vazio e texto vazio estouram sem fingir trecho", async () => {
    const seen: { extract?: object; args?: string[] } = {};
    await expect(alignText(
      { input: "fonte.mp4", text: "olá", startSeconds: 0, endSeconds: 2 },
      depsFor(words([]), seen),
    )).rejects.toThrow(/sem correspondência/);
    await expect(alignText(
      { input: "fonte.mp4", text: "   ", startSeconds: 0, endSeconds: 2 },
      depsFor(words([]), seen),
    )).rejects.toThrow(/texto vazio/);
  });
});

describe("transcribe resident", () => {
  it("dois arquivos passam pelo worker residente e não pelo transcribe.py", async () => {
    const dir = await mkdtemp(join(tmpdir(), "asr-resident-"));
    const coordinator = createFileCoordinator(dir, { limit: 1, pollMs: 5 });
    const sidecarCalls: string[] = [];
    const workerCalls: string[] = [];
    let concurrent = 0;
    let max = 0;
    const deps = {
      extract: async () => {},
      coordinator,
      runSidecar: async (args: string[]) => {
        sidecarCalls.push(args.join(" "));
        return JSON.stringify({ language: "pt", words: [] });
      },
      worker: async (req: { taskId: string; wav: string; language: string }) => {
        concurrent += 1;
        max = Math.max(max, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 20));
        workerCalls.push(req.taskId);
        concurrent -= 1;
        return {
          language: req.language,
          words: [{ text: req.taskId, startMs: 0, endMs: 40, confidence: 1, sentenceIndex: 0 }],
          unaligned: [],
        };
      },
    };
    const [a, b] = await Promise.all([
      transcribe({ input: "cam-a.mp4" }, deps),
      transcribe({ input: "cam-b.mp4" }, deps),
    ]);
    expect(sidecarCalls).toEqual([]);
    expect(workerCalls.sort()).toEqual(["cam-a.mp4", "cam-b.mp4"].sort());
    expect(max).toBe(1);
    expect(new Set([a.tokens[0]?.text, b.tokens[0]?.text])).toEqual(new Set(["cam-a.mp4", "cam-b.mp4"]));
  });

  it("encaminha computeType do transcribe para o worker residente", async () => {
    const seen: Array<{ taskId: string; computeType?: string }> = [];
    await transcribe(
      { input: "cam-a.mp4", computeType: "float16" },
      {
        extract: async () => {},
        worker: async (req) => {
          seen.push({ taskId: req.taskId, computeType: req.computeType });
          return { language: req.language, words: [], unaligned: [] };
        },
      },
    );
    expect(seen).toEqual([{ taskId: "cam-a.mp4", computeType: "float16" }]);
  });

  it("encaminha computeType para o sidecar de processo único", async () => {
    const argsSeen: string[][] = [];
    await transcribe(
      { input: "cam-a.mp4", computeType: "float16", model: "medium" },
      {
        extract: async () => {},
        runSidecar: async (args) => {
          argsSeen.push(args);
          return JSON.stringify({ language: "pt", words: [] });
        },
      },
    );
    expect(argsSeen).toHaveLength(1);
    expect(argsSeen[0]).toContain("--compute-type");
    expect(argsSeen[0]?.[argsSeen[0]!.indexOf("--compute-type") + 1]).toBe("float16");
    expect(argsSeen[0]?.[argsSeen[0]!.indexOf("--model") + 1]).toBe("medium");
  });
});
