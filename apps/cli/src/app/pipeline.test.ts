import { describe, expect, it } from "vitest";
import { FakeExecutor, makeTriageProxy, probeFps, runIngest, runPlan } from "./pipeline.ts";

const job = { id: "j1", videoPath: "/vid/aula.mp4", workDir: "/work/j1" };

describe("runIngest", () => {
  it("transcreve, indexa e reporta cada estágio na ordem", async () => {
    const exec = new FakeExecutor();
    const stages: string[] = [];
    await runIngest(job, exec, (s) => stages.push(s));
    expect(stages).toEqual(["transcribing", "indexing"]);
  });

  it("passa CLAUDE_PROJECT_DIR para o motor em toda chamada", async () => {
    // Sem diretório por job, dois vídeos no mesmo cwd se sobrescrevem.
    const exec = new FakeExecutor();
    await runIngest(job, exec, () => {});
    for (const call of exec.calls) {
      expect(call.env?.CLAUDE_PROJECT_DIR).toBe("/work/j1");
    }
  });

  it("estoura com a saída do motor quando uma etapa falha", async () => {
    const exec = new FakeExecutor({ code: 2, stdout: "[ERROR] transcript inválido" });
    await expect(runIngest(job, exec, () => {})).rejects.toThrow(/transcript inválido/);
  });
});

describe("runPlan", () => {
  it("sempre manda --drop-fillers hard, que é o default da skill", async () => {
    const exec = new FakeExecutor();
    await runPlan(job, "u001-u003 u005", exec);
    const call = exec.calls.at(-1)!;
    expect(call.args).toContain("--drop-fillers");
    expect(call.args).toContain("hard");
  });

  it("passa o keep-list como itens separados, não como uma string só", async () => {
    // `--keep u001-u003 u005` são dois argumentos para o argparse do motor.
    const exec = new FakeExecutor();
    await runPlan(job, "u001-u003 u005", exec);
    const { args } = exec.calls.at(-1)!;
    expect(args.slice(args.indexOf("--keep") + 1, args.indexOf("--keep") + 3))
      .toEqual(["u001-u003", "u005"]);
  });

  it("recusa keep-list vazio antes de chamar o motor", async () => {
    const exec = new FakeExecutor();
    await expect(runPlan(job, "   ", exec)).rejects.toThrow(/keep/);
    expect(exec.calls).toHaveLength(0);
  });
});

describe("makeTriageProxy", () => {
  it("gera o proxy a 1 fps e resolução reduzida", async () => {
    // Mandar o original quebra: 11,2 MB viram 14,9 MB em base64 e voltam como
    // erro genérico do provedor.
    const exec = new FakeExecutor();
    const out = await makeTriageProxy(job, exec);
    const { command, args } = exec.calls.at(-1)!;
    expect(command).toBe("ffmpeg");
    expect(args.join(" ")).toContain("fps=1,scale=270:480");
    expect(out).toContain("triage-proxy.mp4");
  });

  it("não regera o proxy se ele já existe", async () => {
    const exec = new FakeExecutor();
    await makeTriageProxy(job, exec, { exists: async () => true });
    expect(exec.calls).toHaveLength(0);
  });
});

describe("probeFps", () => {
  it("lê o frame rate como fração", async () => {
    expect(await probeFps(job, new FakeExecutor({ stdout: "30/1\n" }))).toBe(30);
  });

  it("recusa fracionário com instrução do que fazer", async () => {
    // 29,97 vira deriva crescente no timecode; ninguém percebe até o fim.
    const exec = new FakeExecutor({ stdout: "30000/1001\n" });
    await expect(probeFps(job, exec)).rejects.toThrow(/29\.97/);
  });

  it("estoura quando o ffprobe falha, em vez de assumir 30", async () => {
    await expect(probeFps(job, new FakeExecutor({ code: 1 }))).rejects.toThrow(/ffprobe/);
  });
});
