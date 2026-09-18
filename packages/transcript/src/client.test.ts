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
      expect(spawned[0]!.args).toEqual(["run", "python", "worker.py", "--serve"]);
      expect(spawned.some((call) => call.args.includes("transcribe.py"))).toBe(false);
      expect(new Set([a.words[0]?.text, b.words[0]?.text])).toEqual(new Set(["cam-a.mp4", "cam-b.mp4"]));
    } finally {
      await client.close();
    }
  });

  it("cancelamento da tarefa lenta não devolve a resposta da outra", async () => {
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
    const ac = new AbortController();
    try {
      const slow = client.transcribe({
        taskId: "slow", wav: "slow.wav", language: "pt", signal: ac.signal,
      });
      await expect.poll(() => written.some((line) => line.includes('"slow"'))).toBe(true);
      ac.abort();
      await expect(slow).rejects.toThrow(/tarefa cancelada: slow/);
      expect(written.some((line) => line.includes('"cancel"') && line.includes("slow"))).toBe(true);
      const fast = await client.transcribe({ taskId: "fast", wav: "fast.wav", language: "pt" });
      expect(fast.words[0]?.text).toBe("fast");
    } finally {
      await client.close();
    }
  }, 8000);
});
