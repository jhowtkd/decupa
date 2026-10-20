import { describe, expect, it } from "vitest";
import { isCancelledError } from "@decupa/trace";
import {
  TypeSafeBudget,
  TypeSafeBudgetExceededError,
  TypeSafeClient,
  TypeSafeTimeoutError,
} from "./index.ts";

const request = { state: "deadline regression", questions: {} };

function client(fetchImpl: typeof fetch) {
  return new TypeSafeClient({
    apiKey: "test-key",
    fetchImpl,
    retryBudgetMs: 5,
    maxRetries: 0,
  });
}

function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<"settled" | "pending"> {
  return Promise.race([
    promise.then(() => "settled" as const, () => "settled" as const),
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), ms)),
  ]);
}

describe("TypeSafe deadlines", () => {
  it("uses the lazy default limit of five minutes and one hundred calls", async () => {
    let now = 1_000;
    const budget = new TypeSafeBudget({ now: () => now });
    expect(budget.callsUsed).toBe(0);
    expect(budget.remainingMs).toBe(300_000);
    now += 25;
    expect(budget.remainingMs).toBe(300_000);
    await expect(budget.run(async () => "started")).resolves.toBe("started");
    expect(budget.callsUsed).toBe(1);
    expect(budget.remainingMs).toBe(300_000);
    for (let call = 1; call < 100; call += 1) {
      await budget.run(async () => undefined);
    }
    await expect(budget.run(async () => "must not run")).rejects.toMatchObject({ reason: "calls" });
    expect(budget.callsUsed).toBe(100);
  });

  it("rejects and aborts fetch when the retry budget expires during a never-resolving fetch", async () => {
    let fetchSignal: AbortSignal | undefined;
    const fetchImpl = ((_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      fetchSignal = init?.signal ?? undefined;
      // Deliberately ignores the signal, as some fetch implementations/adapters can.
      return new Promise<Response>(() => {});
    }) as typeof fetch;

    const decision = client(fetchImpl).decide(request);

    expect(await settlesWithin(decision, 30)).toBe("settled");
    await expect(decision).rejects.toBeInstanceOf(TypeSafeTimeoutError);
    expect(fetchSignal?.aborted).toBe(true);
  });

  it("aborts the request when response headers arrive but reading the body never resolves", async () => {
    let fetchSignal: AbortSignal | undefined;
    const fetchImpl = ((_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      fetchSignal = init?.signal ?? undefined;
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => new Promise<string>(() => {}),
      } as Response);
    }) as typeof fetch;

    const decision = client(fetchImpl).decide(request);

    expect(await settlesWithin(decision, 30)).toBe("settled");
    await expect(decision).rejects.toBeInstanceOf(TypeSafeTimeoutError);
    expect(fetchSignal?.aborted).toBe(true);
  });

  it("applies requestTimeoutMs independently of the larger decide retry budget", async () => {
    let fetchSignal: AbortSignal | undefined;
    const ts = new TypeSafeClient({
      apiKey: "test-key",
      retryBudgetMs: 10_000,
      requestTimeoutMs: 5,
      fetchImpl: ((_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        fetchSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      }) as typeof fetch,
    });
    const decision = ts.decide(request);

    expect(await settlesWithin(decision, 30)).toBe("settled");
    await expect(decision).rejects.toBeInstanceOf(TypeSafeTimeoutError);
    expect(fetchSignal?.aborted).toBe(true);
  });

  it("aborts while reading the body of an HTTP error response", async () => {
    let fetchSignal: AbortSignal | undefined;
    const ts = new TypeSafeClient({
      apiKey: "test-key",
      requestTimeoutMs: 5,
      maxRetries: 0,
      fetchImpl: ((_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        fetchSignal = init?.signal ?? undefined;
        return Promise.resolve({
          ok: false,
          status: 429,
          text: () => new Promise<string>(() => {}),
        } as Response);
      }) as typeof fetch,
    });
    const decision = ts.decide(request);

    expect(await settlesWithin(decision, 30)).toBe("settled");
    await expect(decision).rejects.toBeInstanceOf(TypeSafeTimeoutError);
    expect(fetchSignal?.aborted).toBe(true);
  });

  it("counts failed work and rejects calls after the shared call limit", async () => {
    const budget = new TypeSafeBudget({ maxDurationMs: 10_000, maxCalls: 1 });
    await expect(budget.run(async () => { throw new Error("network failure"); })).rejects.toThrow("network failure");

    await expect(budget.run(async () => "must not run")).rejects.toMatchObject({
      name: "TypeSafeBudgetExceededError",
      reason: "calls",
    });
    expect(budget.callsUsed).toBe(1);
  });

  it("counts each retry fetch against the same call limit", async () => {
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ error: "slow" }), { status: 429 });
    }) as typeof fetch;
    const budget = new TypeSafeBudget({ maxDurationMs: 10_000, maxCalls: 1 });
    const ts = new TypeSafeClient({
      apiKey: "test-key",
      fetchImpl,
      budget,
      retryBudgetMs: 5_000,
      maxRetries: 2,
      random: () => 0,
      sleep: async () => {},
    });

    await expect(ts.decide(request)).rejects.toMatchObject({
      name: "TypeSafeBudgetExceededError",
      reason: "calls",
    });
    expect(fetchCalls).toBe(1);
    expect(budget.callsUsed).toBe(1);
  });

  it("admits only one concurrent call at the limit", async () => {
    const budget = new TypeSafeBudget({ maxDurationMs: 10_000, maxCalls: 1 });
    let started = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const first = budget.run(async () => { started += 1; await held; return "ok"; });
    const second = budget.run(async () => { started += 1; return "unexpected"; });

    await expect(second).rejects.toMatchObject({ reason: "calls" });
    expect(started).toBe(1);
    release();
    await expect(first).resolves.toBe("ok");
  });

  it("shares elapsed time across successful runs and charges failed or cancelled work", async () => {
    let now = 100;
    const budget = new TypeSafeBudget({ maxDurationMs: 10, maxCalls: 5, now: () => now });
    await expect(budget.run(async () => "first")).resolves.toBe("first");
    expect(budget.callsUsed).toBe(1);
    expect(budget.remainingMs).toBe(10);

    now += 11;
    await expect(budget.run(async () => "must not run")).rejects.toBeInstanceOf(TypeSafeBudgetExceededError);
    expect(budget.callsUsed).toBe(1);
  });

  it("preserves manual cancellation as AbortError instead of a budget timeout", async () => {
    const budget = new TypeSafeBudget({ maxDurationMs: 10_000, maxCalls: 2 });
    const controller = new AbortController();
    const decision = budget.run((signal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }), controller.signal);
    controller.abort(new DOMException("cancelled", "AbortError"));

    await expect(decision.catch((error) => isCancelledError(error))).resolves.toBe(true);
    expect(budget.callsUsed).toBe(1);
  });

  it("aborts a pending run at the shared time limit and leaves the budget exhausted", async () => {
    const budget = new TypeSafeBudget({ maxDurationMs: 5, maxCalls: 3 });
    const decision = budget.run(() => new Promise<string>(() => {}));

    await expect(decision).rejects.toMatchObject({
      name: "TypeSafeBudgetExceededError",
      reason: "time",
    });
    await expect(budget.run(async () => "must not run")).rejects.toMatchObject({
      name: "TypeSafeBudgetExceededError",
      reason: "time",
    });
    expect(budget.callsUsed).toBe(1);
  });

  it("does not consume a call when manually cancelled before run starts", async () => {
    const budget = new TypeSafeBudget({ maxDurationMs: 1_000, maxCalls: 1 });
    const controller = new AbortController();
    controller.abort();

    await expect(budget.run(async () => "must not run", controller.signal)
      .catch((error) => isCancelledError(error))).resolves.toBe(true);
    expect(budget.callsUsed).toBe(0);
  });

  it("does not reserve a call when runCalls starts pre-cancelled", async () => {
    const budget = new TypeSafeBudget({ maxCalls: 1 });
    const controller = new AbortController();
    controller.abort();

    await expect(budget.runCalls(async () => "must not run", controller.signal)
      .catch(error => isCancelledError(error))).resolves.toBe(true);
    expect(budget.callsUsed).toBe(0);
  });

  it("runCalls remains outside the exhausted time budget while run is blocked by it", async () => {
    let now = 0;
    const budget = new TypeSafeBudget({ maxDurationMs: 5, maxCalls: 4, now: () => now });
    let finishText!: (value: string) => void;
    const text = budget.runCalls(() => new Promise<string>(resolve => { finishText = resolve; }));
    let textSettled = false;
    void text.then(() => { textSettled = true; }, () => { textSettled = true; });

    await expect(budget.withinTime(async () => {
      now = 6;
      return "late Jev result";
    })).rejects.toMatchObject({ name: "TypeSafeBudgetExceededError", reason: "time" });
    await expect(budget.run(async () => "must not run")).rejects.toMatchObject({
      name: "TypeSafeBudgetExceededError", reason: "time",
    });
    expect(textSettled).toBe(false);
    expect(budget.callsUsed).toBe(1);

    finishText("text completed");
    await expect(text).resolves.toBe("text completed");
    await expect(budget.runCalls(async () => "new text after Jev expired"))
      .resolves.toBe("new text after Jev expired");
    expect(budget.callsUsed).toBe(2);
  });

  it("runCalls reserves the first attempt, charges retries, and stops at maxCalls", async () => {
    const budget = new TypeSafeBudget({ maxCalls: 3 });
    let attempts = 0;

    await expect(budget.runCalls(async (_signal, onAttempt) => {
      onAttempt(); // primeira tentativa incluída na reserva inicial
      attempts += 1;
      onAttempt();
      attempts += 1;
      onAttempt();
      attempts += 1;
      onAttempt(); // excede o teto ao tentar a quarta tentativa
      return "não alcançado";
    })).rejects.toMatchObject({ name: "TypeSafeBudgetExceededError", reason: "calls" });

    expect(attempts).toBe(3);
    expect(budget.callsUsed).toBe(3);
  });

  it("runCalls mantém a reserva da chamada quando o trabalho falha", async () => {
    const budget = new TypeSafeBudget({ maxCalls: 1 });
    await expect(budget.runCalls(async () => { throw new Error("falha no texto"); }))
      .rejects.toThrow("falha no texto");

    await expect(budget.runCalls(async () => "must not run")).rejects.toMatchObject({
      name: "TypeSafeBudgetExceededError", reason: "calls",
    });
    expect(budget.callsUsed).toBe(1);
  });
});
