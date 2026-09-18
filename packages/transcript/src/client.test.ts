import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createResidentSpeechClient } from "./client.ts";

function fakeServe(): string {
  return `
    const readline = require("node:readline");
    const rl = readline.createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const req = JSON.parse(line);
      const args = req.args || {};
      process.stdout.write(JSON.stringify({
        language: args.language || "pt",
        words: [{ text: args.task_id, startMs: 0, endMs: 40, confidence: 1, sentenceIndex: 0 }],
        unaligned: [],
        taskId: args.task_id,
      }) + "\\n");
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
});
