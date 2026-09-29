import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import type { ExecCall, Executor } from "../pipeline.ts";
import { SpawnExecutor } from "../pipeline.ts";
import { startApp } from "../server.ts";

let stop: (() => Promise<void>) | null = null;
afterEach(async () => { await stop?.(); stop = null; });

const INDEX = {
  units: [{
    id: "u001", index: 1, start: 0, end: 2, duration: 2,
    text: "olá tema", has_terminal_punct: true, is_question: false,
    word_count: 2, cps: 1, lead_gap: 0,
    disfluency: { hard: [], soft: [], stutter: [] },
  }],
};

function vivo(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

it.skipIf(process.platform === "win32")("begin não mata processo do executor que não é a operação corrente", async () => {
  // Entrega ao DaVinci e o proxy nascem no mesmo SpawnExecutor, sem signal
  // da operação. begin() antigo chamava killAll e derrubava os dois.
  const dir = await mkdtemp(join(tmpdir(), "begin-vivo-"));
  const pidPath = join(dir, "pid");
  const exec = new SpawnExecutor();
  const app = await startApp({ projectDir: dir, port: 0, executor: exec, env: {} });
  stop = async () => { exec.killAll(); await app.close(); await rm(dir, { recursive: true, force: true }); };
  const pending = exec.run({
    command: process.execPath,
    args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setTimeout(()=>{}, 30000)`],
  });
  void pending.catch(() => {});
  try {
    let pid = 0;
    await vi.waitFor(async () => {
      pid = Number(await readFile(pidPath, "utf8"));
      expect(pid).toBeGreaterThan(0);
    }, { timeout: 5_000 });
    const res = await fetch(`http://127.0.0.1:${app.port}/project/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceIds: ["nao-existe"] }),
    });
    expect(res.status).toBe(404);
    await new Promise((r) => setTimeout(r, 400));
    expect(vivo(pid), "o processo longo morreu no begin()").toBe(true);
  } finally {
    exec.killAll();
  }
});

it("Retomar durante preparação em curso responde 409 e não chama o modelo de novo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "begin-retomar-"));
  const speech = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), speech);
  let speechId = "desconhecida";
  let modelCalls = 0;
  // Sinal de cada chamada ao modelo: prova direta de que o Retomar não
  // aborta a preparação em curso (o código antigo abortava e recomeçava).
  const modelSignals: (AbortSignal | undefined)[] = [];
  const executor: Executor = {
    async run(call: ExecCall) {
      const work = call.env?.CLAUDE_PROJECT_DIR ?? call.cwd ?? "";
      if (work && call.args.includes("index")) {
        await mkdir(join(work, "out"), { recursive: true });
        await writeFile(join(work, "out", "speech_index.json"), `${JSON.stringify(INDEX)}\n`);
      }
      if (call.command === "ffmpeg") {
        const dest = call.args[call.args.length - 1]!;
        if (dest.includes("%03d")) {
          const seconds = Number(call.args[call.args.indexOf("-t") + 1]!);
          for (let i = 0; i < seconds; i += 1) {
            await writeFile(dest.replace("%03d", String(i).padStart(3, "0")), `frame-${i}`);
          }
        } else if (isAbsolute(dest)) {
          await writeFile(dest, "clip");
        }
      }
      if (call.command === "python3" && call.args.includes("--out")) {
        await copyFile(join(FIXTURES, "clip.mp4"), call.args[call.args.indexOf("--out") + 1]!);
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const app = await startApp({
    projectDir: dir,
    inputs: [speech],
    port: 0,
    executor,
    env: {},
    proposeSend: (_content, signal) => {
      modelCalls += 1;
      modelSignals.push(signal);
      return new Promise<string>((_resolve, reject) => {
        const fail = () => reject(new Error("abortado pelo teste"));
        if (signal?.aborted) fail();
        else signal?.addEventListener("abort", fail, { once: true });
      });
    },
    describeClient: {
      async send(content: unknown[]) {
        const match = /na fonte: \[([\d.]+), ([\d.]+)\)/.exec(JSON.stringify(content));
        const start = match ? Number(match[1]) : 0;
        const end = match ? Number(match[2]) : 3;
        const fetchStart = start === 0 ? 0 : start - 1;
        return JSON.stringify({
          spans: [{ start: 0, end: end - fetchStart, text: "pessoa falando", confidence: "observed", tags: [] }],
        });
      },
    },
  });
  const base = `http://127.0.0.1:${app.port}`;
  stop = async () => {
    await fetch(`${base}/project/cancel`, { method: "POST" }).catch(() => {});
    // O cancel responde antes de a preparação terminar de gravar: esperar o
    // estado terminal evita apagar o diretório enquanto ela ainda escreve.
    await vi.waitFor(async () => {
      const body = await (await fetch(`${base}/project`)).json() as {
        project: { preparation: { status: string } | null };
      };
      expect(body.project.preparation?.status ?? "idle").not.toBe("running");
    }, { timeout: 10_000, interval: 50 }).catch(() => {});
    await app.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };

  const opened = await (await fetch(`${base}/project`)).json() as {
    project: { revision: number; assembly: { sources: { id: string }[] } };
  };
  speechId = `${opened.project.assembly.sources[0]!.id}:u001`;
  expect(speechId).toContain(":u001");

  const first = await fetch(`${base}/project/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseRevision: opened.project.revision,
      request: "montar tudo",
      modelOptIn: true,
      visualOptIn: true,
    }),
  });
  expect(first.status).toBe(202);
  await vi.waitFor(() => { expect(modelCalls).toBe(1); }, { timeout: 15_000, interval: 100 });

  // Com o modelo pendente a preparação está parada num ponto conhecido: nada
  // avança a revisão até a resposta chegar. Revisão corrente é essencial —
  // uma base velha também dá 409 ("revisão desatualizada"), pelo motivo errado.
  const current = await (await fetch(`${base}/project`)).json() as {
    project: { revision: number; preparation: { status: string } | null };
  };
  const again = await fetch(`${base}/project/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseRevision: current.project.revision,
      request: "",
      modelOptIn: true,
      visualOptIn: true,
    }),
  });
  expect(again.status).toBe(409);
  expect(((await again.json()) as { error: string }).error).toMatch(/preparação em andamento/);
  await new Promise((r) => setTimeout(r, 300));
  expect(modelCalls).toBe(1);
  // A preparação em curso segue viva: o Retomar redundante não a abortou.
  expect(modelSignals[0]?.aborted).toBe(false);

  expect((await fetch(`${base}/project/cancel`, { method: "POST" })).status).toBe(200);
  await vi.waitFor(async () => {
    const body = await (await fetch(`${base}/project`)).json() as {
      project: { preparation: { status: string } | null };
    };
    expect(body.project.preparation?.status ?? "idle").not.toBe("running");
  }, { timeout: 10_000, interval: 100 });

  const after = await (await fetch(`${base}/project`)).json() as { project: { revision: number } };
  const resume = await fetch(`${base}/project/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseRevision: after.project.revision,
      request: "",
      modelOptIn: true,
      visualOptIn: true,
    }),
  });
  expect(resume.status).toBe(202);
  await vi.waitFor(() => { expect(modelCalls).toBe(2); }, { timeout: 15_000, interval: 100 });
});
