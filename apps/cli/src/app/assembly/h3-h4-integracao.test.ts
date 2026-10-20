import { expect, it } from "vitest";
import { TypeSafeBudget, TypeSafeBudgetExceededError, TypeSafeClient, type TypeSafeRequest } from "@decupa/typesafe";
import { fixtureAssembly } from "./fixture.ts";
import { blankProject } from "./routes.ts";
import { proposeScenes, type ProposalCheckpoint } from "./scenes.ts";
import type { Project } from "./types.ts";

function project(count = 1): Project {
  const p = blankProject("integração H3 H4");
  p.assembly = fixtureAssembly();
  p.assembly.sources[0]!.durationSeconds = count;
  p.analyses = [{
    sourceId: "a", key: "analysis-a", speech: Array.from({ length: count }, (_, i) => ({
      id: `a:u${String(i + 1).padStart(3, "0")}`, sourceId: "a", start: i, end: i + 0.8, text: `fala ${i + 1}`,
    })), visual: [], status: "ready", words: [], wordsStatus: "missing",
    visualCoverage: { requested: [], returned: [], missing: [] },
  }];
  return p;
}

function proposalText(count = 1, candidates = false): string {
  const ids = Array.from({ length: count }, (_, i) => `a:u${String(i + 1).padStart(3, "0")}`);
  return JSON.stringify({
    scenes: [{ id: "s1", objective: "organizar", rationale: "teste", speechIds: ids, support: [], gaps: [] }],
    changedSceneIds: ["s1"], explanation: "costura",
    ...(candidates ? { cutCandidates: ids.slice(0, -1).map((speechId) => ({ sceneId: "s1", speechId, reason: "redundância" })) } : {}),
  });
}

function memoryStore(initial: unknown = null) {
  let value = structuredClone(initial);
  const saves: ProposalCheckpoint[] = [];
  return {
    saves,
    load: async () => structuredClone(value),
    save: async (checkpoint: ProposalCheckpoint) => {
      value = structuredClone(checkpoint);
      saves.push(structuredClone(checkpoint));
    },
    value: () => structuredClone(value),
    replace: (next: unknown) => { value = structuredClone(next); },
  };
}

function decisionClient(budget: TypeSafeBudget, fetchImpl: typeof fetch) {
  return new TypeSafeClient({ apiKey: "fake-typesafe-key", model: "fake-jev", fetchImpl, budget });
}

const signal = () => new AbortController().signal;

it("conta texto novo com checkpoint no orçamento compartilhado e encaminha cancelamento e tentativa", async () => {
  const p = project();
  const budget = new TypeSafeBudget({ maxDurationMs: 10_000, maxCalls: 1 });
  const store = memoryStore();
  let sentSignal: AbortSignal | undefined;
  let sentAttempt: (() => void) | undefined;
  let sends = 0;

  await proposeScenes(p, "organizar", signal(), {
    send: async (_content, requestSignal, onAttempt) => {
      sends += 1;
      sentSignal = requestSignal;
      sentAttempt = onAttempt;
      return proposalText();
    },
    checkpoint: store,
    configKey: "config-teste",
    decision: { mode: "observe", model: "fake-jev", budget },
  });

  expect(sends).toBe(1);
  expect(sentSignal).toBeInstanceOf(AbortSignal);
  expect(sentSignal?.aborted).toBe(false);
  expect(sentAttempt).toEqual(expect.any(Function));
  expect(budget.callsUsed).toBe(1);
  expect(store.saves).toHaveLength(1);
});

it("retoma texto válido do checkpoint sem send nem consumo do orçamento", async () => {
  const p = project();
  const store = memoryStore();
  const options = { checkpoint: store, configKey: "config-teste", model: "fake-text", decision: { mode: "off" as const, model: "fake-jev" } };
  await proposeScenes(p, "organizar", signal(), { ...options, send: async () => proposalText() });
  store.saves.length = 0;
  const budget = new TypeSafeBudget({ maxDurationMs: 10_000, maxCalls: 1 });
  let sends = 0;

  await proposeScenes(p, "organizar", signal(), {
    ...options,
    decision: { mode: "off", model: "fake-jev", budget },
    send: async () => { sends += 1; return proposalText(); },
  });

  expect(sends).toBe(0);
  expect(budget.callsUsed).toBe(0);
  expect(store.saves).toHaveLength(0);
});

it("reusa lote Jev salvo sem fetch/orçamento e cobra somente o lote ausente", async () => {
  const p = project(22);
  const store = memoryStore();
  const initialBudget = new TypeSafeBudget({ maxDurationMs: 10_000, maxCalls: 10 });
  let initialFetches = 0;
  const initialClient = decisionClient(initialBudget, (async (_input, init) => {
    initialFetches += 1;
    const request = JSON.parse(String(init?.body)) as TypeSafeRequest;
    return new Response(JSON.stringify({ model: "fake-jev", answers: Object.fromEntries(
      Object.keys(request.questions).map((id) => [id, { type: "noul", noul: 0.1 }]),
    ) }));
  }) as typeof fetch);
  const base = {
    send: async () => proposalText(22, true), checkpoint: store, configKey: "config-teste", model: "fake-text",
    decision: { mode: "observe" as const, model: "fake-jev", client: initialClient, budget: initialBudget },
  };

  await proposeScenes(p, "organizar", signal(), base);
  expect(initialFetches).toBe(2);
  const saved = store.value() as ProposalCheckpoint;
  const keys = Object.keys(saved.decisions);
  expect(keys).toHaveLength(2);
  delete saved.decisions[keys[1]!];
  if (saved.requests) delete saved.requests[keys[1]!];
  store.replace(saved);

  const replayBudget = new TypeSafeBudget({ maxDurationMs: 10_000, maxCalls: 10 });
  let replayFetches = 0;
  const replayClient = decisionClient(replayBudget, (async (_input, init) => {
    replayFetches += 1;
    const request = JSON.parse(String(init?.body)) as TypeSafeRequest;
    return new Response(JSON.stringify({ model: "fake-jev", answers: Object.fromEntries(
      Object.keys(request.questions).map((id) => [id, { type: "noul", noul: 0.1 }]),
    ) }));
  }) as typeof fetch);
  await proposeScenes(p, "organizar", signal(), {
    ...base,
    decision: { mode: "observe", model: "fake-jev", client: replayClient, budget: replayBudget },
  });

  expect(replayFetches).toBe(1);
  expect(replayBudget.callsUsed).toBe(1);
});

it("falha sem salvar checkpoint quando o orçamento novo está esgotado", async () => {
  const budget = new TypeSafeBudget({ maxDurationMs: 10_000, maxCalls: 0 });
  const store = memoryStore();
  let sends = 0;

  await expect(proposeScenes(project(), "organizar", signal(), {
    send: async () => { sends += 1; return proposalText(); },
    checkpoint: store,
    decision: { mode: "off", model: "fake-jev", budget },
  })).rejects.toBeInstanceOf(TypeSafeBudgetExceededError);

  expect(sends).toBe(0);
  expect(budget.callsUsed).toBe(0);
  expect(store.saves).toHaveLength(0);
});
