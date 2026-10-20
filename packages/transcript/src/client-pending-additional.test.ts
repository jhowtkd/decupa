import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { expect, it } from "vitest";
import { createResidentSpeechClient, SpeechWorkerInterruptedError } from "./client.ts";

function fakeSilentChild(onWrite?: () => void): ReturnType<typeof spawn> {
  const child = new EventEmitter();
  const stdin = Object.assign(new EventEmitter(), {
    write: () => { onWrite?.(); return true; },
    end: () => undefined,
  });
  Object.assign(child, {
    stdin,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: () => true,
  });
  return child as unknown as ReturnType<typeof spawn>;
}

it("close classifica pedidos em voo, enfileirados e futuros como interrupção retomável", async () => {
  let entered!: () => void;
  const requestStarted = new Promise<void>((resolve) => { entered = resolve; });
  let spawns = 0;
  const client = createResidentSpeechClient({ spawn: () => { spawns += 1; return fakeSilentChild(entered); } });
  const inFlight = client.transcribe({ taskId: "active", wav: "a.wav", language: "pt" });
  await requestStarted;
  const queued = client.transcribe({ taskId: "queued", wav: "b.wav", language: "pt" });
  await client.close();

  for (const pending of [inFlight, queued]) {
    await expect(pending).rejects.toBeInstanceOf(SpeechWorkerInterruptedError);
  }
  await expect(client.transcribe({ taskId: "after-close", wav: "c.wav", language: "pt" }))
    .rejects.toBeInstanceOf(SpeechWorkerInterruptedError);
  expect(spawns).toBe(1);
});

it("abort da requisição ativa é uma interrupção retomável", async () => {
  let entered!: () => void;
  const requestStarted = new Promise<void>((resolve) => { entered = resolve; });
  const client = createResidentSpeechClient({ spawn: () => fakeSilentChild(entered) });
  const abort = new AbortController();
  const pending = client.transcribe({ taskId: "abort-me", wav: "a.wav", language: "pt", signal: abort.signal });
  await requestStarted;
  abort.abort();
  await expect(pending).rejects.toBeInstanceOf(SpeechWorkerInterruptedError);
  await client.close();
});
