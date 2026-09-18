import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashFile } from "@decupa/media";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import { FakeExecutor, type ExecCall, type Executor } from "../pipeline.ts";
import { startApp } from "../server.ts";
import { analyzeSource } from "./analysis.ts";
import { bootProjectDecision } from "./decision-boot.ts";
import { fixtureAssembly } from "./fixture.ts";
import { describeSource } from "./model.ts";
import { visualWindows } from "./visual.ts";

const INDEX = {
  units: [{
    id: "u001", index: 1, start: 0, end: 1.2, duration: 1.2,
    text: "olá", has_terminal_punct: true, is_question: false,
    word_count: 1, cps: 1, lead_gap: 0,
    disfluency: { hard: [], soft: [], stutter: [] },
  }],
};

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

describe("bootProjectDecision", () => {
  let stop: (() => Promise<void>) | null = null;
  afterEach(async () => { await stop?.(); stop = null; });

  it("projeto sem config abre desligado e observe não chama a API", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decision-boot-"));
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const missing = await bootProjectDecision({
      projectDir: dir,
      env: { TYPESAFE_API_KEY: "sk-secret", DECUPA_TYPESAFE: "1" },
      fetchImpl,
    });
    expect(missing).toMatchObject({ mode: "off", enabled: false, apiCalls: 0 });
    expect(calls).toBe(0);

    await mkdir(join(dir, ".decupa"), { recursive: true });
    await writeFile(join(dir, ".decupa", "decision.json"), JSON.stringify({ mode: "observe" }), "utf8");
    const observe = await bootProjectDecision({
      projectDir: dir,
      env: { TYPESAFE_API_KEY: "sk-secret", DECUPA_TYPESAFE: "1" },
      fetchImpl,
    });
    expect(observe).toMatchObject({ mode: "observe", enabled: false, apiCalls: 0 });
    expect(calls).toBe(0);
  });

  it("abrir o app em observe não consome API e registra log sem conteúdo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decision-app-"));
    await mkdir(join(dir, ".decupa"), { recursive: true });
    await writeFile(join(dir, ".decupa", "decision.json"), JSON.stringify({ mode: "observe" }), "utf8");
    let calls = 0;
    const logs: string[] = [];
    const app = await startApp({
      projectDir: dir,
      port: 0,
      env: { TYPESAFE_API_KEY: "sk-typesafe-secret-do-not-log", DECUPA_TYPESAFE: "1" },
      fetchImpl: (async () => {
        calls += 1;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
      decisionLog: (line: string) => logs.push(line),
    });
    stop = app.close;
    const opened = await fetch(`http://127.0.0.1:${app.port}/project`);
    expect(opened.status).toBe(200);
    expect(calls).toBe(0);
    expect(logs.join("\n")).toMatch(/provider=typesafe/);
    expect(logs.join("\n")).toMatch(/model=/);
    expect(logs.join("\n")).toMatch(/elapsedMs=/);
    expect(logs.join("\n")).toMatch(/fallback=/);
    expect(logs.join("\n")).not.toContain("sk-typesafe-secret-do-not-log");
    expect(logs.join("\n")).not.toContain("u001");
  });

  it("desligar o Jev não desfaz seek visual nem cache atômico", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decision-media-"));
    await mkdir(join(dir, ".decupa"), { recursive: true });
    await writeFile(join(dir, ".decupa", "decision.json"), JSON.stringify({ mode: "off" }), "utf8");
    const boot = await bootProjectDecision({
      projectDir: dir,
      env: { TYPESAFE_API_KEY: "sk-secret", DECUPA_TYPESAFE: "1" },
    });
    expect(boot.enabled).toBe(false);
    expect(boot.mode).toBe("off");

    const path = join(dir, "fala.mp4");
    await copyFile(join(FIXTURES, "clip.mp4"), path);
    const source = {
      ...fixtureAssembly().sources[0]!,
      path,
      sha256: await hashFile(path),
      durationSeconds: 3,
    };
    const ffmpegArgs: string[][] = [];
    const visualExec: Executor = {
      async run(call) {
        ffmpegArgs.push(call.args);
        const out = call.args[call.args.length - 1]!;
        const input = call.args[call.args.indexOf("-i") + 1]!;
        await copyFile(input, out);
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    await describeSource(source, dir, new AbortController().signal, {
      client: {
        async send() {
          return JSON.stringify({
            spans: [{ id: "local-0", start: 0, end: 3, text: "mesa", confidence: "observed", tags: [] }],
          });
        },
      },
      exec: visualExec,
    });
    const clipArgs = ffmpegArgs.find((args) => args.includes("-ss") && args.includes("-i"));
    expect(clipArgs).toBeDefined();
    expect(clipArgs!.indexOf("-ss")).toBeLessThan(clipArgs!.indexOf("-i"));
    expect(clipArgs!.join(" ")).not.toMatch(/\bcopy\b/);
    expect(visualWindows(source.durationSeconds)[0]?.fetchStart).toBe(0);

    await analyzeSource(source, dir, indexingExec());
    const spy = new FakeExecutor({ code: 1, stderr: "não deveria reprocessar" });
    const again = await analyzeSource(source, dir, spy);
    expect(spy.calls).toHaveLength(0);
    expect(again.status).toBe("ready");
  });
});
