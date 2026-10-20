import { expect, it, vi } from "vitest";
import { TypeSafeBudget, TypeSafeBudgetExceededError, TypeSafeTimeoutError } from "@decupa/typesafe";
import { isCancelledError } from "@decupa/trace";
import { createAssemblyDecisionContext, decideAssemblyCuts, resolveCutCandidates } from "./assembly-decisions.ts";
import { fixtureAssembly } from "./fixture.ts";
import { blankProject } from "./routes.ts";
import { proposeScenes, validateProposal } from "./scenes.ts";
import type { ProposalCheckpoint } from "./scenes.ts";

function projectWithSpeech(count = 22) {
  const project = blankProject("orçamento compartilhado");
  project.assembly = fixtureAssembly();
  project.assembly.sources[0]!.durationSeconds = count;
  project.analyses = [{
    sourceId: "a", key: "speech", status: "ready", words: [], wordsStatus: "missing",
    visual: [], visualCoverage: { requested: [], returned: [], missing: [] },
    speech: Array.from({ length: count }, (_, i) => ({
      id: `a:u${i}`, sourceId: "a", start: i, end: i + 1, text: `fala ${i}`,
    })),
  }];
  return project;
}

function proposalText(count = 22): string {
  return JSON.stringify({
    scenes: [{ id: "s1", selections: Array.from({ length: count }, (_, i) => ({ speechId: `a:u${i}` })), support: [], gaps: [] }],
    changedSceneIds: ["s1"],
    cutCandidates: Array.from({ length: count - 1 }, (_, i) => ({ sceneId: "s1", speechId: `a:u${i}`, reason: "redundante" })),
  });
}

function checkpointStore() {
  let value: unknown = null;
  const saves: ProposalCheckpoint[] = [];
  return {
    saves,
    load: async () => structuredClone(value),
    save: async (checkpoint: ProposalCheckpoint) => {
      value = structuredClone(checkpoint);
      saves.push(structuredClone(checkpoint));
    },
  };
}

it("conta retries da proposta e do reparo sem consumir os cinco minutos dos lotes Jev", async () => {
  vi.useFakeTimers();
  try {
    const project = projectWithSpeech();
    const budget = new TypeSafeBudget({ maxCalls: 10 });
    const remaining: number[] = [];
    let jevCalls = 0;
    const context = createAssemblyDecisionContext(
      { mode: "hybrid", model: "fake-jev" },
      { DECUPA_TYPESAFE: "1", TYPESAFE_API_KEY: "fake-key" },
      (async (_input, init) => {
        jevCalls += 1;
        remaining.push(budget.remainingMs);
        const request = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
        await new Promise(resolve => setTimeout(resolve, 1_000));
        return new Response(JSON.stringify({ model: "fake-jev", answers: Object.fromEntries(
          Object.keys(request.questions).map(id => [id, { type: "noul", noul: 0 }]),
        ) }));
      }) as typeof fetch,
      budget,
    );

    let sends = 0;
    const run = proposeScenes(project, "organizar", new AbortController().signal, {
      decision: context,
      send: async (_content, _signal, onAttempt) => {
        sends += 1;
        // A tentativa inicial já está reservada; cada callback adicional é um retry.
        onAttempt?.();
        onAttempt?.();
        await new Promise(resolve => setTimeout(resolve, 301_000));
        return sends === 1 ? "não é JSON" : proposalText();
      },
    });
    const settled = run.then(
      result => ({ result }),
      error => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(610_000);
    const outcome = await settled;

    expect("error" in outcome).toBe(false);
    if (!("result" in outcome)) throw outcome.error;
    expect(outcome.result).toMatchObject({ scenes: [{ id: "s1" }] });
    expect(sends).toBe(2);
    expect(jevCalls).toBe(2);
    expect(remaining).toEqual([300_000, 299_000]);
    expect(budget.callsUsed).toBe(sends * 2 + jevCalls);
  } finally {
    vi.useRealTimers();
  }
});

it("não salva checkpoint quando o teto de chamadas impede o reparo da resposta", async () => {
  const budget = new TypeSafeBudget({ maxCalls: 1 });
  const checkpoint = checkpointStore();
  let sends = 0;

  await expect(proposeScenes(projectWithSpeech(1), "organizar", new AbortController().signal, {
    send: async () => {
      sends += 1;
      return "resposta inválida";
    },
    checkpoint,
    decision: { mode: "off", model: "fake-jev", budget },
  })).rejects.toMatchObject({ name: "TypeSafeBudgetExceededError", reason: "calls" });

  expect(sends).toBe(1);
  expect(budget.callsUsed).toBe(1);
  expect(checkpoint.saves).toHaveLength(0);
});

it("corrida de cancelamento encerra send pendente que ignora signal sem checkpoint", async () => {
  const budget = new TypeSafeBudget({ maxCalls: 2 });
  const checkpoint = checkpointStore();
  const controller = new AbortController();
  let deliveredSignal: AbortSignal | undefined;
  let enteredSend!: () => void;
  const sendStarted = new Promise<void>(resolve => { enteredSend = resolve; });
  const pending = proposeScenes(projectWithSpeech(1), "organizar", controller.signal, {
    send: async (_content, signal) => {
      deliveredSignal = signal;
      enteredSend();
      return new Promise<string>(() => {});
    },
    checkpoint,
    decision: { mode: "off", model: "fake-jev", budget },
  });

  await sendStarted;
  controller.abort();
  const error = await pending.catch(reason => reason);

  expect(isCancelledError(error)).toBe(true);
  expect(deliveredSignal?.aborted).toBe(true);
  expect(budget.callsUsed).toBe(1);
  expect(checkpoint.saves).toHaveLength(0);
});

it("cancelamento anterior a proposeScenes não reserva chamada nem grava checkpoint", async () => {
  const budget = new TypeSafeBudget({ maxCalls: 2 });
  const checkpoint = checkpointStore();
  const controller = new AbortController();
  controller.abort();
  let sends = 0;

  const error = await proposeScenes(projectWithSpeech(1), "organizar", controller.signal, {
    send: async () => {
      sends += 1;
      return proposalText(1);
    },
    checkpoint,
    decision: { mode: "off", model: "fake-jev", budget },
  }).catch(reason => reason);

  expect(isCancelledError(error)).toBe(true);
  expect(sends).toBe(0);
  expect(budget.callsUsed).toBe(0);
  expect(checkpoint.saves).toHaveLength(0);
});

function oneCandidate() {
  const project = projectWithSpeech(2);
  const proposal = validateProposal({
    id: "proposal", baseRevision: project.revision, changedSceneIds: ["s1"], explanation: "teste",
    scenes: [{ id: "s1", selections: [{ speechId: "a:u0" }, { speechId: "a:u1" }], support: [], gaps: [] }],
  }, project);
  const candidates = resolveCutCandidates(project, proposal, [{ sceneId: "s1", speechId: "a:u0", reason: "redundante" }]);
  return { project, proposal, candidates };
}

it.each([
  [new TypeSafeTimeoutError(30_000), "Jev sem resposta no prazo"],
  [new TypeSafeBudgetExceededError("time"), "orçamento do Jev esgotado"],
  [new TypeSafeBudgetExceededError("calls"), "orçamento do Jev esgotado"],
] as const)("expõe motivo próprio para falha tipada de Jev: %s", async (error, reason) => {
  const { project, proposal, candidates } = oneCandidate();
  const result = await decideAssemblyCuts(project, proposal, candidates, {
    mode: "hybrid", model: "fake-jev", client: { decide: async () => { throw error; } },
  }, new AbortController().signal);

  expect(result.decisionReport).toMatchObject({ status: "fallback", reason });
  expect(result.scenes).toEqual(proposal.scenes);
});

it("preserva a causa de cancelamento em vez de convertê-la em fallback", async () => {
  const { project, proposal, candidates } = oneCandidate();
  const controller = new AbortController();
  const cancellation = new Error("operação cancelada pelo usuário");
  const result = decideAssemblyCuts(project, proposal, candidates, {
    mode: "hybrid", model: "fake-jev", client: { decide: async () => {
      controller.abort(cancellation);
      throw new Error("transporte interrompido");
    } },
  }, controller.signal);

  await expect(result).rejects.toBe(cancellation);
});
