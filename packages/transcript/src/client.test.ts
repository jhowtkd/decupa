import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createResidentSpeechClient } from "./client.ts";

function fakeServe(): string {
  return `
    const readline = require("node:readline");
    const pending = new Map();
    const rl = readline.createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const req = JSON.parse(line);
      const cmd = req.cmd || "transcribe";
      const args = req.args || {};
      if (cmd === "cancel") {
        const reply = pending.get(args.task_id);
        if (reply) {
          pending.delete(args.task_id);
          reply({ error: "tarefa cancelada: " + args.task_id, taskId: args.task_id });
        }
        return;
      }
      const payload = {
        language: args.language || "pt",
        words: [{ text: args.task_id, startMs: 0, endMs: 40, confidence: 1, sentenceIndex: 0 }],
        unaligned: [],
        taskId: args.task_id,
      };
      if (args.task_id === "slow") {
        pending.set(args.task_id, (out) => {
          process.stdout.write(JSON.stringify(out) + "\\n");
        });
        return;
      }
      process.stdout.write(JSON.stringify(payload) + "\\n");
    });
  `;
}

describe("createResidentSpeechClient", () => {
  it("dois arquivos compartilham um processo worker.py --serve e não chamam transcribe.py", async () => {
    const spawned: { command: string; args: string[] }[] = [];
    const client = createResidentSpeechClient({
      spawn: (command, args, options) => {
        spawned.push({ command, args });
        return spawn(process.execPath, ["-e", fakeServe()], {
          cwd: options?.cwd,
          env: options?.env as NodeJS.ProcessEnv | undefined,
          stdio: ["pipe", "pipe", "pipe"],
        });
      },
    });
    try {
      const [a, b] = await Promise.all([
        client.transcribe({ taskId: "cam-a.mp4", wav: "a.wav", language: "pt" }),
        client.transcribe({ taskId: "cam-b.mp4", wav: "b.wav", language: "pt" }),
      ]);
      expect(spawned).toHaveLength(1);
      expect(spawned[0]!.command).toBe("uv");
      expect(spawned[0]!.args).toEqual(["run", "--no-sync", "python", "worker.py", "--serve"]);
      expect(spawned.some((call) => call.args.includes("transcribe.py"))).toBe(false);
      expect(new Set([a.words[0]?.text, b.words[0]?.text])).toEqual(new Set(["cam-a.mp4", "cam-b.mp4"]));
    } finally {
      await client.close();
    }
  });

  it("encaminha o stderr do WhisperX sem misturar no protocolo stdout", async () => {
    const stderr: string[] = [];
    const client = createResidentSpeechClient({
      onStderr: (chunk) => stderr.push(chunk),
      spawn: (_command, _args, options) => {
        return spawn(process.execPath, ["-e", `
          const readline = require("node:readline");
          const rl = readline.createInterface({ input: process.stdin });
          rl.on("line", (line) => {
            const req = JSON.parse(line);
            if ((req.cmd || "transcribe") === "cancel") return;
            process.stderr.write("Loading WhisperX model\\n");
            process.stdout.write(JSON.stringify({
              language: "pt",
              words: [{ text: req.args.task_id, startMs: 0, endMs: 40, confidence: 1, sentenceIndex: 0 }],
              unaligned: [],
              taskId: req.args.task_id,
            }) + "\\n");
          });
        `], {
          cwd: options?.cwd,
          env: options?.env as NodeJS.ProcessEnv | undefined,
          stdio: ["pipe", "pipe", "pipe"],
        });
      },
    });
    try {
      const result = await client.transcribe({ taskId: "cam-a.mp4", wav: "a.wav", language: "pt" });
      expect(result.words[0]?.text).toBe("cam-a.mp4");
      await expect.poll(() => stderr.join("")).toMatch(/Loading WhisperX model/);
    } finally {
      await client.close();
    }
  });

  it("linhas de stdout sem taskId correspondente não roubam a resposta de outra tarefa", async () => {
    const client = createResidentSpeechClient({
      spawn: (_command, _args, options) => {
        return spawn(process.execPath, ["-e", `
          const readline = require("node:readline");
          const rl = readline.createInterface({ input: process.stdin });
          rl.on("line", (line) => {
            const req = JSON.parse(line);
            if ((req.cmd || "transcribe") === "cancel") return;
            process.stdout.write("Loading WhisperX model\\n");
            process.stdout.write(JSON.stringify({ language: "pt", words: [] }) + "\\n");
            process.stdout.write(JSON.stringify({
              language: "pt",
              words: [{ text: req.args.task_id, startMs: 0, endMs: 40, confidence: 1, sentenceIndex: 0 }],
              unaligned: [],
              taskId: req.args.task_id,
            }) + "\\n");
          });
        `], {
          cwd: options?.cwd,
          env: options?.env as NodeJS.ProcessEnv | undefined,
          stdio: ["pipe", "pipe", "pipe"],
        });
      },
    });
    try {
      const result = await client.transcribe({ taskId: "cam-a.mp4", wav: "a.wav", language: "pt" });
      expect(result.words[0]?.text).toBe("cam-a.mp4");
    } finally {
      await client.close();
    }
  });

  it("erro no processo filho rejeita a transcrição pendente", async () => {
    const { EventEmitter } = await import("node:events");
    const client = createResidentSpeechClient({
      spawn: () => {
        const child = new EventEmitter();
        const stdin = Object.assign(new EventEmitter(), {
          write: () => true,
          end: () => undefined,
        });
        Object.assign(child, {
          stdin,
          stdout: new EventEmitter(),
          stderr: new EventEmitter(),
          kill: () => true,
        });
        queueMicrotask(() => child.emit("error", new Error("uv: command not found")));
        return child as unknown as ReturnType<typeof spawn>;
      },
    });
    try {
      await expect(client.transcribe({ taskId: "a", wav: "a.wav", language: "pt" }))
        .rejects.toThrow(/uv: command not found/);
    } finally {
      await client.close();
    }
  }, 4000);

  it("cancelamento da tarefa lenta não devolve a resposta da outra", async () => {
    const written: string[] = [];
    let spawns = 0;
    const client = createResidentSpeechClient({
      spawn: (_command, _args, options) => {
        spawns += 1;
        const child = spawn(process.execPath, ["-e", fakeServe()], {
          cwd: options?.cwd,
          env: options?.env as NodeJS.ProcessEnv | undefined,
          stdio: ["pipe", "pipe", "pipe"],
        });
        const stdin = child.stdin;
        if (stdin) {
          const orig = stdin.write.bind(stdin);
          stdin.write = ((chunk: string | Buffer, encoding?: BufferEncoding, cb?: (err?: Error | null) => void) => {
            written.push(String(chunk));
            return orig(chunk, encoding as BufferEncoding, cb);
          }) as typeof stdin.write;
        }
        return child;
      },
    });
    const ac = new AbortController();
    try {
      const slow = client.transcribe({
        taskId: "slow", wav: "slow.wav", language: "pt", signal: ac.signal,
      });
      await expect.poll(() => written.some((line) => line.includes('"slow"'))).toBe(true);
      ac.abort();
      await expect(slow).rejects.toThrow(/tarefa cancelada: slow/);
      const fast = await client.transcribe({ taskId: "fast", wav: "fast.wav", language: "pt" });
      expect(fast.words[0]?.text).toBe("fast");
      // Cancelar fecha o worker: a próxima tarefa roda num processo novo.
      expect(spawns).toBe(2);
    } finally {
      await client.close();
    }
  }, 8000);

  it("encaminha compute_type diferente como outra chave de load", async () => {
    const written: string[] = [];
    const client = createResidentSpeechClient({
      spawn: (_command, _args, options) => {
        const child = spawn(process.execPath, ["-e", fakeServe()], {
          cwd: options?.cwd,
          env: options?.env as NodeJS.ProcessEnv | undefined,
          stdio: ["pipe", "pipe", "pipe"],
        });
        const stdin = child.stdin;
        if (stdin) {
          const orig = stdin.write.bind(stdin);
          stdin.write = ((chunk: string | Buffer, encoding?: BufferEncoding, cb?: (err?: Error | null) => void) => {
            written.push(String(chunk));
            return orig(chunk, encoding as BufferEncoding, cb);
          }) as typeof stdin.write;
        }
        return child;
      },
    });
    try {
      await client.transcribe({
        taskId: "fp16", wav: "a.wav", language: "pt", model: "small", computeType: "float16",
      });
      expect(written.some((line) => line.includes('"compute_type":"float16"'))).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("reinício rejeita pendentes e ignora stdout do processo morto", async () => {
    const children: { child: EventEmitter; stdout: EventEmitter }[] = [];
    const client = createResidentSpeechClient({
      spawn: () => {
        const child = new EventEmitter();
        const stdout = new EventEmitter();
        const stdin = Object.assign(new EventEmitter(), {
          write: () => true,
          end: () => undefined,
        });
        Object.assign(child, {
          stdin,
          stdout,
          stderr: new EventEmitter(),
          kill: () => true,
        });
        children.push({ child, stdout });
        return child as unknown as ReturnType<typeof spawn>;
      },
    });
    try {
      const first = client.transcribe({ taskId: "b", wav: "b.wav", language: "pt" });
      await expect.poll(() => children.length).toBe(1);
      children[0]!.child.emit("exit", 1);
      await expect(first).rejects.toThrow(/encerrou/);
      const again = client.transcribe({ taskId: "b", wav: "b.wav", language: "pt" });
      await expect.poll(() => children.length).toBe(2);
      const stale = JSON.stringify({
        language: "pt",
        words: [{ text: "stale-b", startMs: 0, endMs: 40, confidence: 1, sentenceIndex: 0 }],
        unaligned: [],
        taskId: "b",
      }) + "\n";
      children[0]!.stdout.emit("data", stale);
      await new Promise((resolve) => setTimeout(resolve, 20));
      children[1]!.stdout.emit("data", JSON.stringify({
        language: "pt",
        words: [{ text: "fresh-b", startMs: 0, endMs: 40, confidence: 1, sentenceIndex: 0 }],
        unaligned: [],
        taskId: "b",
      }) + "\n");
      const out = await again;
      expect(out.words[0]?.text).toBe("fresh-b");
    } finally {
      await client.close();
    }
  });

  it("linha DECUPA_PROGRESS vira progresso e não cai no stderr", async () => {
    const stderr: string[] = [];
    const progresso: string[] = [];
    const client = createResidentSpeechClient({
      onStderr: (chunk) => stderr.push(chunk),
      spawn: (_command, _args, options) => spawn(process.execPath, ["-e", `
        const readline = require("node:readline");
        const rl = readline.createInterface({ input: process.stdin });
        rl.on("line", (line) => {
          const req = JSON.parse(line);
          if ((req.cmd || "transcribe") === "cancel") return;
          process.stderr.write('DECUPA_PROGRESS {"taskId":"a","stage":"transcrevendo","percent":42}\\n');
          process.stderr.write("Loading WhisperX model\\n");
          process.stdout.write(JSON.stringify({
            language: "pt",
            words: [{ text: "oi", startMs: 0, endMs: 40, confidence: 1, sentenceIndex: 0 }],
            unaligned: [],
            taskId: req.args.task_id,
          }) + "\\n");
        });
      `], {
        cwd: options?.cwd,
        env: options?.env as NodeJS.ProcessEnv | undefined,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    });
    try {
      await client.transcribe({
        taskId: "a", wav: "a.wav", language: "pt", onProgress: (linha) => progresso.push(linha),
      });
      expect(progresso).toEqual(["transcrevendo 42%"]);
      expect(stderr.join("")).not.toMatch(/DECUPA_PROGRESS/);
      expect(stderr.join("")).toMatch(/Loading WhisperX model/);
    } finally {
      await client.close();
    }
  });

  it("linha de progresso depois de uma barra \\r sem quebra ainda vira progresso", async () => {
    // Controle do worker que agora quebra a linha antes do prefixo: o cliente
    // descarta o pedaço vazio e reconhece a linha de progresso.
    const progresso: string[] = [];
    const client = createResidentSpeechClient({
      spawn: (_command, _args, options) => spawn(process.execPath, ["-e", `
        const readline = require("node:readline");
        const rl = readline.createInterface({ input: process.stdin });
        rl.on("line", (line) => {
          const req = JSON.parse(line);
          if ((req.cmd || "transcribe") === "cancel") return;
          process.stderr.write("\\r  10%|#####     |");
          process.stderr.write('\\nDECUPA_PROGRESS {"taskId":"a","stage":"transcrevendo","percent":42}\\n');
          process.stdout.write(JSON.stringify({
            language: "pt",
            words: [{ text: "oi", startMs: 0, endMs: 40, confidence: 1, sentenceIndex: 0 }],
            unaligned: [],
            taskId: req.args.task_id,
          }) + "\\n");
        });
      `], {
        cwd: options?.cwd,
        env: options?.env as NodeJS.ProcessEnv | undefined,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    });
    try {
      await client.transcribe({
        taskId: "a", wav: "a.wav", language: "pt", onProgress: (linha) => progresso.push(linha),
      });
      expect(progresso).toEqual(["transcrevendo 42%"]);
    } finally {
      await client.close();
    }
  });

  it("worker sem progresso é morto pelo watchdog", async () => {
    const client = createResidentSpeechClient({
      watchdogMs: 200,
      spawn: (_command, _args, options) => spawn(process.execPath, ["-e", `
        const readline = require("node:readline");
        const rl = readline.createInterface({ input: process.stdin });
        rl.on("line", () => {});
      `], {
        cwd: options?.cwd,
        env: options?.env as NodeJS.ProcessEnv | undefined,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    });
    const pendente = client.transcribe({ taskId: "a", wav: "a.wav", language: "pt" });
    const desfecho = pendente.then(() => "ok", (error: Error) => error.message);
    try {
      const resultado = await Promise.race([
        desfecho,
        new Promise<string>((resolve) => setTimeout(() => resolve("pendurou"), 3000)),
      ]);
      expect(resultado).toMatch(/sem dar sinal de progresso/);
    } finally {
      await client.close();
    }
  }, 5_000);

  it("progresso periódico impede o watchdog de matar o worker", async () => {
    // Folga para o processo filho subir numa suíte carregada: o watchdog arma
    // na escrita do pedido, antes da primeira linha de progresso.
    const client = createResidentSpeechClient({
      watchdogMs: 600,
      spawn: (_command, _args, options) => spawn(process.execPath, ["-e", `
        const readline = require("node:readline");
        const rl = readline.createInterface({ input: process.stdin });
        rl.on("line", (line) => {
          const req = JSON.parse(line);
          if ((req.cmd || "transcribe") === "cancel") return;
          const send = () => process.stderr.write(
            'DECUPA_PROGRESS {"taskId":"' + req.args.task_id + '","stage":"transcrevendo","percent":10}\\n',
          );
          send();
          const timer = setInterval(send, 100);
          setTimeout(() => {
            clearInterval(timer);
            process.stdout.write(JSON.stringify({
              language: "pt",
              words: [{ text: "ok", startMs: 0, endMs: 40, confidence: 1, sentenceIndex: 0 }],
              unaligned: [],
              taskId: req.args.task_id,
            }) + "\\n");
          }, 1500);
        });
      `], {
        cwd: options?.cwd,
        env: options?.env as NodeJS.ProcessEnv | undefined,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    });
    try {
      const out = await client.transcribe({ taskId: "a", wav: "a.wav", language: "pt" });
      expect(out.words[0]?.text).toBe("ok");
    } finally {
      await client.close();
    }
  }, 5_000);

  it("worker que ignora o cancel ainda rejeita a tarefa e a próxima sobe outro processo", async () => {
    let spawns = 0;
    const client = createResidentSpeechClient({
      spawn: (_command, _args, options) => {
        spawns += 1;
        return spawn(process.execPath, ["-e", `
          const readline = require("node:readline");
          const rl = readline.createInterface({ input: process.stdin });
          rl.on("line", (line) => {
            const req = JSON.parse(line);
            if ((req.cmd || "transcribe") === "cancel") return;
            if (req.args.task_id === "preso") return;
            process.stdout.write(JSON.stringify({
              language: "pt",
              words: [{ text: req.args.task_id, startMs: 0, endMs: 40, confidence: 1, sentenceIndex: 0 }],
              unaligned: [],
              taskId: req.args.task_id,
            }) + "\\n");
          });
        `], {
          cwd: options?.cwd,
          env: options?.env as NodeJS.ProcessEnv | undefined,
          stdio: ["pipe", "pipe", "pipe"],
        });
      },
    });
    const ac = new AbortController();
    const pendente = client.transcribe({
      taskId: "preso", wav: "preso.wav", language: "pt", signal: ac.signal,
    });
    const desfecho = pendente.then(() => "ok", (error: Error) => error.message);
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      ac.abort();
      const resultado = await Promise.race([
        desfecho,
        new Promise<string>((resolve) => setTimeout(() => resolve("pendurou"), 3000)),
      ]);
      expect(resultado).toMatch(/tarefa cancelada/);
      const seguinte = await client.transcribe({ taskId: "depois", wav: "depois.wav", language: "pt" });
      expect(seguinte.words[0]?.text).toBe("depois");
      expect(spawns).toBe(2);
    } finally {
      await client.close();
    }
  }, 5_000);
});
