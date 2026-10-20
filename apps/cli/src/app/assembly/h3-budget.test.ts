import { expect, it } from "vitest";
import { TypeSafeBudget, TypeSafeBudgetExceededError } from "@decupa/typesafe";
import { resolveAppTransports } from "../analysis-transports.ts";
import { createAssemblyDecisionContext } from "./assembly-decisions.ts";
import { decideAssemblyCuts, resolveCutCandidates } from "./assembly-decisions.ts";
import { brollCandidates, selectBroll } from "./broll.ts";
import { fixtureAssembly } from "./fixture.ts";
import { proposeScenes, validateProposal } from "./scenes.ts";
import { blankProject } from "./routes.ts";

it("creates a lazy default decision budget and accepts a shared budget", () => {
  const defaultContext = createAssemblyDecisionContext({ mode: "off" }, {});
  expect(defaultContext.budget).toBeInstanceOf(TypeSafeBudget);
  expect(defaultContext.budget?.callsUsed).toBe(0);
  expect(defaultContext.budget?.remainingMs).toBe(300_000);

  const shared = new TypeSafeBudget({ maxDurationMs: 12_000, maxCalls: 7 });
  const context = createAssemblyDecisionContext({ mode: "off" }, {}, undefined, shared);
  expect(context.budget).toBe(shared);
});

it("shares the proposal, JSON correction, cuts and support call ceiling while preserving the proposal", async () => {
  const project = blankProject("orçamento montagem");
  project.assembly = fixtureAssembly();
  project.assembly.sources[0]!.durationSeconds = 2;
  project.assembly.sources[1]!.durationSeconds = 3;
  project.analyses = [
    {
      sourceId: "a", key: "speech", status: "ready", words: [], wordsStatus: "missing",
      visual: [], visualCoverage: { requested: [], returned: [], missing: [] },
      speech: [
        { id: "a:first", sourceId: "a", start: 0, end: 1, text: "público chegou" },
        { id: "a:last", sourceId: "a", start: 1, end: 2, text: "público participou" },
      ],
    },
    {
      sourceId: "b", key: "visual", status: "ready", words: [], wordsStatus: "ready", speech: [],
      visualCoverage: { requested: [], returned: [], missing: [] },
      visual: [0, 1, 2].map((start) => ({
        id: `b:v${start}`, sourceId: "b", start, end: start + 1,
        text: "público participando", confidence: "observed" as const, tags: ["público"],
      })),
    },
  ];
  const budget = new TypeSafeBudget({ maxDurationMs: 30_000, maxCalls: 2 });
  let textCalls = 0;
  let modelCalls = 0;
  const context = createAssemblyDecisionContext(
    { mode: "hybrid", model: "test" },
    { DECUPA_TYPESAFE: "1", TYPESAFE_API_KEY: "fake-key" },
    (async () => {
      modelCalls += 1;
      return new Response(JSON.stringify({ model: "test", answers: {} }));
    }) as typeof fetch,
    budget,
  );
  const initial = "not JSON";
  const corrected = JSON.stringify({
    scenes: [{ id: "s1", selections: [{ speechId: "a:first" }, { speechId: "a:last" }], support: [], gaps: [] }],
    changedSceneIds: ["s1"],
    cutCandidates: [{ sceneId: "s1", speechId: "a:first", reason: "repetição" }],
  });

  const result = await proposeScenes(project, "organizar", new AbortController().signal, {
    decision: context,
    send: async (_content, signal) => {
      textCalls += 1;
      signal?.throwIfAborted();
      return textCalls === 1 ? initial : corrected;
    },
  });

  expect(textCalls).toBe(2);
  expect(modelCalls).toBe(0);
  expect(budget.callsUsed).toBe(2);
  expect(result.scenes[0]!.takes.map((take) => take.speechId)).toEqual(["a:first", "a:last"]);
  expect(result.decisionReport?.status).toBe("fallback");
  expect(result.decisionReport?.cuts).toMatchObject([{ applied: false, score: null }]);
  expect(result.decisionReport?.supports).toMatchObject([{ outcome: "fallback" }]);
});

function projectWithSpeech(count: number) {
  const project = blankProject("lotes H3");
  project.assembly = fixtureAssembly();
  project.assembly.sources[0]!.durationSeconds = count;
  project.assembly.sources[1]!.durationSeconds = 60;
  const speech = Array.from({ length: count }, (_, i) => ({
    id: `a:u${i}`, sourceId: "a", start: i, end: i + 1, text: `fala ${i}`,
  }));
  project.analyses = [{
    sourceId: "a", key: "speech", status: "ready", words: [], wordsStatus: "missing",
    visual: [], visualCoverage: { requested: [], returned: [], missing: [] }, speech,
  }, {
    sourceId: "b", key: "visual", status: "ready", words: [], wordsStatus: "ready", speech: [],
    visualCoverage: { requested: [], returned: [], missing: [] },
    visual: Array.from({ length: Math.max(count, 21) }, (_, i) => ({
      id: `b:v${i}`, sourceId: "b", start: i * 2, end: i * 2 + 1,
      text: `imagem ${i}`, confidence: "observed" as const, tags: [],
    })),
  }];
  return project;
}

function proposalFor(project: ReturnType<typeof projectWithSpeech>, count: number) {
  return validateProposal({
    id: "h3", baseRevision: project.revision, changedSceneIds: ["s1"], explanation: "teste",
    scenes: [{ id: "s1", selections: Array.from({ length: count }, (_, i) => ({ speechId: `a:u${i}` })), support: [], gaps: [] }],
  }, project);
}

it("counts every cuts batch and falls back on the next batch when the shared budget is exhausted", async () => {
  const project = projectWithSpeech(22);
  const proposal = proposalFor(project, 22);
  const raw = Array.from({ length: 21 }, (_, i) => ({ sceneId: "s1", speechId: `a:u${i}`, reason: "redundante" }));
  const budget = new TypeSafeBudget({ maxDurationMs: 30_000, maxCalls: 1 });
  let fetchCalls = 0;
  const context = createAssemblyDecisionContext({ mode: "hybrid" }, { DECUPA_TYPESAFE: "1", TYPESAFE_API_KEY: "fake-key" }, (async (_input, init) => {
    fetchCalls += 1;
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
    return new Response(JSON.stringify({ model: "test", answers: Object.fromEntries(
      Object.keys(body.questions).map((id) => [id, { type: "noul", noul: 0 }]),
    ) }));
  }) as typeof fetch, budget);

  const result = await decideAssemblyCuts(
    project, proposal, resolveCutCandidates(project, proposal, raw), context, new AbortController().signal,
  );

  expect(fetchCalls).toBe(1);
  expect(budget.callsUsed).toBe(1);
  expect(result.scenes[0]!.speechIds).toHaveLength(22);
  expect(result.decisionReport?.status).toBe("fallback");
  expect(result.decisionReport?.cuts).toHaveLength(21);
  expect(result.decisionReport?.cuts.every((cut) => !cut.applied)).toBe(true);
});

it("counts support tournament batches against the shared budget and preserves the scene on fallback", async () => {
  const project = projectWithSpeech(3);
  const proposal = proposalFor(project, 3);
  expect(brollCandidates(project)).toHaveLength(21);
  const budget = new TypeSafeBudget({ maxDurationMs: 30_000, maxCalls: 2 });
  let fetchCalls = 0;
  const context = createAssemblyDecisionContext({ mode: "hybrid" }, { DECUPA_TYPESAFE: "1", TYPESAFE_API_KEY: "fake-key" }, (async (_input, init) => {
    fetchCalls += 1;
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, { criteria: Record<string, string> }> };
    const [[id, question]] = Object.entries(body.questions);
    const choice = Object.keys(question!.criteria).find((key) => key !== "none") ?? "none";
    return new Response(JSON.stringify({ model: "test", answers: {
      [id!]: { type: "choice", choice, confidence: 1, probabilities: Object.fromEntries(
        Object.keys(question!.criteria).map((key) => [key, key === choice ? 1 : 0]),
      ) },
    } }));
  }) as typeof fetch, budget);

  const result = await selectBroll(project, proposal, context, new AbortController().signal);

  expect(fetchCalls).toBe(2);
  expect(budget.callsUsed).toBe(2);
  expect(result.scenes[0]!.support).toEqual([]);
  expect(result.decisionReport?.status).toBe("fallback");
  expect(result.decisionReport?.supports).toMatchObject([{ outcome: "fallback" }]);
});

it("charges each real OpenAI compatible retry attempt and blocks its next HTTP request", async () => {
  const budget = new TypeSafeBudget({ maxDurationMs: 30_000, maxCalls: 1 });
  const context = createAssemblyDecisionContext({ mode: "off" }, {}, undefined, budget);
  const project = blankProject("retry com teto");
  project.assembly = fixtureAssembly();
  let fetchCalls = 0;
  const transports = resolveAppTransports({
    env: { DECUPA_ASSEMBLY_TEXT_PROVIDER: "openai", OPENAI_API_KEY: "fake-openai-key" },
    fetchImpl: (async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ error: { message: "temporary server error" } }), {
        status: 500,
        headers: { "Retry-After": "0" },
      });
    }) as typeof fetch,
  });

  await expect(proposeScenes(project, "retry", new AbortController().signal, {
    decision: context,
    send: (content, signal, onAttempt) => transports.textSend(content, signal, onAttempt),
  })).rejects.toBeInstanceOf(TypeSafeBudgetExceededError);

  expect(fetchCalls).toBe(1);
  expect(budget.callsUsed).toBe(1);
});
