import { describe, expect, it } from "vitest";
import { collectSink, createTracer, isCancelledError, sanitizeTraceEvent, type TraceEvent } from "./index.ts";

function serialize(events: TraceEvent[]): string {
  return JSON.stringify(events);
}

describe("createTracer", () => {
  it("emite queued, started e um único finished por tentativa bem-sucedida", async () => {
    const sink = collectSink();
    const tracer = createTracer(sink);
    const result = await tracer.run("transcribing", async () => "ok");
    expect(result).toBe("ok");
    expect(sink.events.map((e) => e.phase)).toEqual(["queued", "started", "finished"]);
    expect(sink.events.map((e) => e.stage)).toEqual(["transcribing", "transcribing", "transcribing"]);
    expect(new Set(sink.events.map((e) => e.attemptId)).size).toBe(1);
    expect(sink.events.filter((e) => e.phase === "finished")).toHaveLength(1);
    expect(sink.events[2]!.category).toBe("ok");
    expect(sink.events[2]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("tarefa com erro ainda emite finished e relança", async () => {
    const sink = collectSink();
    const tracer = createTracer(sink);
    await expect(tracer.run("indexing", async () => {
      throw new Error("falhou o índice");
    })).rejects.toThrow(/falhou o índice/);
    expect(sink.events.map((e) => e.phase)).toEqual(["queued", "started", "finished"]);
    expect(sink.events.filter((e) => e.phase === "finished")).toHaveLength(1);
    expect(sink.events[2]!.category).toBe("error");
  });

  it("erro do sink não muda o retorno da tarefa", async () => {
    const tracer = createTracer({
      emit() {
        throw new Error("disco cheio");
      },
    });
    await expect(tracer.run("visual", async () => 42)).resolves.toBe(42);
  });

  it("erro do sink numa tarefa que falha não troca o erro original", async () => {
    const tracer = createTracer({
      emit() {
        throw new Error("sink morto");
      },
    });
    await expect(tracer.run("visual", async () => {
      throw new Error("ffmpeg ausente");
    })).rejects.toThrow(/ffmpeg ausente/);
  });

  it("cancelamento tem categoria própria e ainda emite finished", async () => {
    const sink = collectSink();
    const tracer = createTracer(sink);
    const controller = new AbortController();
    const pending = tracer.run("planning", async () => {
      controller.abort();
      throw Object.assign(new Error("AbortError"), { name: "AbortError" });
    }, { signal: controller.signal });
    await expect(pending).rejects.toSatisfy((err) => isCancelledError(err));
    const finished = sink.events.filter((e) => e.phase === "finished");
    expect(finished).toHaveLength(1);
    expect(finished[0]!.category).toBe("cancelled");
  });

  it("abortado na fila emite finished cancelled sem started de trabalho", async () => {
    const sink = collectSink();
    const tracer = createTracer(sink);
    const controller = new AbortController();
    controller.abort();
    await expect(tracer.run("transcribing", async () => "não deveria", { signal: controller.signal }))
      .rejects.toSatisfy((err) => isCancelledError(err));
    expect(sink.events.map((e) => e.phase)).toEqual(["queued", "finished"]);
    expect(sink.events[1]!.category).toBe("cancelled");
  });

  it("espera entre queued e started sem contar como trabalho", async () => {
    const sink = collectSink();
    const tracer = createTracer(sink);
    const order: string[] = [];
    await tracer.run("visual", async () => {
      order.push("work");
      return "ok";
    }, {
      wait: async () => {
        order.push("wait");
      },
    });
    expect(order).toEqual(["wait", "work"]);
    expect(sink.events.map((e) => e.phase)).toEqual(["queued", "started", "finished"]);
  });

  it("eventos serializados não carregam texto privado, mídia nem credencial", async () => {
    const sink = collectSink();
    const tracer = createTracer(sink);
    await tracer.run("transcribing", async () => ({
      transcript: "olá turma, hoje vamos falar sobre o contrato",
      path: "/Users/jhow/aula-secreta.mp4",
      apiKey: "sk-live-secret-key",
    }));
    const blob = serialize(sink.events);
    expect(blob).not.toMatch(/olá turma/i);
    expect(blob).not.toMatch(/aula-secreta/);
    expect(blob).not.toMatch(/sk-live/);
    expect(blob).not.toMatch(/\/Users\//);
    for (const event of sink.events) {
      expect(Object.keys(event).sort()).toEqual(
        expect.arrayContaining(["attemptId", "atMs", "phase", "stage"]),
      );
      expect(event).not.toHaveProperty("transcript");
      expect(event).not.toHaveProperty("path");
      expect(event).not.toHaveProperty("apiKey");
    }
  });

  it("sanitizeTraceEvent descarta campos extras e valores perigosos", () => {
    const dirty = {
      attemptId: "a1",
      stage: "transcribing",
      phase: "finished",
      atMs: 10,
      durationMs: 5,
      category: "ok",
      transcript: "fala privada",
      videoPath: "/tmp/aula.mp4",
      authorization: "Bearer secret",
    };
    const clean = sanitizeTraceEvent(dirty);
    expect(clean).toEqual({
      attemptId: "a1",
      stage: "transcribing",
      phase: "finished",
      atMs: 10,
      durationMs: 5,
      category: "ok",
    });
    expect(JSON.stringify(clean)).not.toMatch(/fala privada|aula\.mp4|Bearer/);
  });
});
