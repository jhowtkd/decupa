import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Credentials } from "@decupa/triage";
import type { TypeSafeRequest } from "@decupa/typesafe";
import { fixtureAssembly } from "./fixture.ts";
import { proposeScenes, type ProposalCheckpoint } from "./scenes.ts";
import type { Project } from "./types.ts";
import { operationResolver } from "../analysis-operation.ts";

function project(): Project {
  return {
    version: 2,
    id: "h4-project",
    revision: 1,
    input: { kind: "script", text: "abrir com o tema", targetSeconds: 2 },
    assembly: fixtureAssembly(),
    scenes: [],
    analyses: [{
      sourceId: "a",
      key: "analysis-a",
      speech: [{ id: "a:u001", sourceId: "a", start: 0, end: 2, text: "olá tema" }],
      visual: [],
      status: "ready",
      words: [],
      wordsStatus: "missing",
      visualCoverage: { requested: [], returned: [], missing: [] },
    }],
    proposal: null,
    previewRevision: null,
    finalApprovedRevision: null,
    corrections: [],
    preparation: null,
    permissions: { model: false, visual: false },
    previewArtifact: null,
  };
}

function rawProposal(speechIds = ["a:u001"]): string {
  return JSON.stringify({
    scenes: [{ id: "s1", objective: "abrir", rationale: "tema", speechIds, support: [], gaps: [] }],
    changedSceneIds: ["s1"],
    explanation: "abertura",
  });
}

function memoryStore(initial: unknown = null) {
  let value = initial;
  const saves: ProposalCheckpoint[] = [];
  return {
    saves,
    load: async () => structuredClone(value),
    replace: (next: unknown) => { value = structuredClone(next); },
    save: async (checkpoint: ProposalCheckpoint) => {
      value = structuredClone(checkpoint);
      saves.push(structuredClone(checkpoint));
    },
  };
}

const signal = () => new AbortController().signal;

describe("checkpoint H4 de proposeScenes", () => {
  it("a identidade de config resolvida reflete credenciais e decision.json sem rede", async () => {
    const dir = await mkdtemp(join(tmpdir(), "h4-config-key-"));
    try {
      await mkdir(join(dir, ".decupa"), { recursive: true });
      let stored: Credentials = {
        preset: "custom",
        apiKey: "fake-custom-key",
        model: "fake-model-a",
        baseUrl: "https://fake.example.test/v1/chat/completions",
        typesafeApiKey: "fake-typesafe-key",
        typesafe: true,
      };
      let fetchCalls = 0;
      let sendCalls = 0;
      const resolve = operationResolver({
        dir,
        loadStored: async () => stored,
        env: {},
        fetchImpl: (async () => { fetchCalls += 1; throw new Error("unexpected network"); }) as typeof fetch,
        proposeSend: async () => { sendCalls += 1; return "{}"; },
        enableVisual: false,
      });

      const first = await resolve();
      const repeated = await resolve();
      expect(repeated.proposalConfigKey).toBe(first.proposalConfigKey);
      stored = { ...stored, model: "fake-model-b" };
      const modelChanged = await resolve();
      expect(modelChanged.proposalConfigKey).not.toBe(first.proposalConfigKey);
      stored = { ...stored, baseUrl: "https://another.fake.example.test/v1/chat/completions" };
      const endpointChanged = await resolve();
      expect(endpointChanged.proposalConfigKey).not.toBe(modelChanged.proposalConfigKey);

      await writeFile(join(dir, ".decupa", "decision.json"), JSON.stringify({ mode: "observe", model: "fake-jev-model" }));
      const decisionChanged = await resolve();
      expect(decisionChanged.proposalConfigKey).not.toBe(endpointChanged.proposalConfigKey);
      expect(sendCalls).toBe(0);
      expect(fetchCalls).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("retoma após a proposta validada sem chamar o gerador novamente", async () => {
    const p = project();
    p.analyses[0]!.speech.push({ id: "a:u002", sourceId: "a", start: 2, end: 2.8, text: "fim" });
    const store = memoryStore();
    let generations = 0;
    let decisions = 0;
    const text = JSON.stringify({
      scenes: [{ id: "s1", objective: "abrir", rationale: "tema", speechIds: ["a:u001", "a:u002"], support: [], gaps: [] }],
      changedSceneIds: ["s1"],
      cutCandidates: [{ sceneId: "s1", speechId: "a:u001", reason: "repetição" }],
    });
    const deps = {
      send: async () => { generations += 1; return text; },
      checkpoint: store,
      decision: {
        mode: "observe" as const,
        model: "fake",
        client: { decide: async (request: TypeSafeRequest) => {
          decisions += 1;
          if (decisions === 1) throw new Error("interrompido depois do texto salvo");
          return { model: "fake", answers: Object.fromEntries(Object.keys(request.questions).map(id => [id, { type: "noul" as const, noul: 0 }])) } as const;
        } },
      },
    };

    await expect(proposeScenes(p, "ajustar", signal(), deps)).resolves.toBeDefined();
    await expect(proposeScenes(p, "ajustar", signal(), deps)).resolves.toBeDefined();
    expect(generations).toBe(1);
    expect(store.saves).toHaveLength(2);
  });

  it("salva somente texto validado e rejeita texto ou candidatos inválidos", async () => {
    for (const text of [
      JSON.stringify({ scenes: [{ id: "s1", speechIds: ["fala-inventada"] }], changedSceneIds: ["s1"] }),
      JSON.stringify({ ...JSON.parse(rawProposal()), cutCandidates: [{ sceneId: "s1", speechId: "a:u001", reason: " " }] }),
    ]) {
      const store = memoryStore();
      await expect(proposeScenes(project(), "ajustar", signal(), {
        send: async () => text,
        checkpoint: store,
      })).rejects.toThrow();
      expect(store.saves).toHaveLength(0);
    }
  });

  it("um checkpoint corrompido é descartado e a proposta é regenerada", async () => {
    const store = memoryStore();
    let generations = 0;
    await proposeScenes(project(), "ajustar", signal(), {
      send: async () => { generations += 1; return rawProposal(); },
      checkpoint: store,
    });
    const original = store.saves.at(-1)!;
    store.replace({ ...original, generated: { ...original.generated, text: "{" } });
    store.saves.length = 0;
    await proposeScenes(project(), "ajustar", signal(), {
      send: async () => { generations += 1; return rawProposal(); },
      checkpoint: store,
    });
    expect(generations).toBe(2);
    expect(store.saves).toHaveLength(1);
  });

  it("invalida o checkpoint após mudança de revisão, briefing, fonte, análise, modelo ou configuração", async () => {
    const variations: Array<(p: Project) => void> = [
      (p) => { p.revision += 1; },
      (p) => { p.input.text = "briefing revisado"; },
      (p) => { p.assembly.sources[0]!.name = "outro-nome.mp4"; },
      (p) => { p.analyses[0]!.speech[0]!.text = "texto corrigido"; },
    ];

    for (const edit of variations) {
      const p = project();
      const store = memoryStore();
      let generations = 0;
      const deps = { send: async () => { generations += 1; return rawProposal(); }, checkpoint: store, model: "model-a", configKey: "config-a" };
      await proposeScenes(p, "ajustar", signal(), deps);
      edit(p);
      await proposeScenes(p, "ajustar", signal(), deps);
      expect(generations).toBe(2);
    }

    for (const changed of [
      { model: "model-b", configKey: "config-a" },
      { model: "model-a", configKey: "config-b" },
    ]) {
      const p = project();
      const store = memoryStore();
      let generations = 0;
      await proposeScenes(p, "ajustar", signal(), {
        send: async () => { generations += 1; return rawProposal(); }, checkpoint: store, model: "model-a", configKey: "config-a",
      });
      await proposeScenes(p, "ajustar", signal(), {
        send: async () => { generations += 1; return rawProposal(); }, checkpoint: store, ...changed,
      });
      expect(generations).toBe(2);
    }

    const p = project();
    const store = memoryStore();
    let generations = 0;
    const send = async () => { generations += 1; return rawProposal(); };
    await proposeScenes(p, "pedido inicial", signal(), { send, checkpoint: store });
    await proposeScenes(p, "pedido alterado", signal(), { send, checkpoint: store });
    expect(generations).toBe(2);
  });

  it("reaproveita o primeiro lote de cortes após abortar a chamada do segundo", async () => {
    const p = project();
    p.assembly.sources[0]!.durationSeconds = 30;
    const ids = Array.from({ length: 22 }, (_, i) => `a:u${String(i + 1).padStart(3, "0")}`);
    p.analyses[0]!.speech = ids.map((id, i) => ({ id, sourceId: "a", start: i, end: i + 0.8, text: `fala ${i}` }));
    const store = memoryStore();
    let generations = 0;
    const batched: string[][] = [];
    const firstAbort = new AbortController();
    const deps = {
      send: async () => {
        generations += 1;
        return JSON.stringify({
          scenes: [{ id: "s1", objective: "sequência", rationale: "teste", speechIds: ids, support: [], gaps: [] }],
          changedSceneIds: ["s1"],
          cutCandidates: ids.slice(0, 21).map((speechId) => ({ sceneId: "s1", speechId, reason: "redundância" })),
        });
      },
      checkpoint: store,
      decision: {
        mode: "observe" as const,
        model: "fake",
        client: { decide: async (request: TypeSafeRequest) => {
          const keys = Object.keys(request.questions);
          batched.push(keys);
          if (batched.length === 2) {
            firstAbort.abort();
          }
          return { model: "fake", answers: Object.fromEntries(keys.map((id) => [id, { type: "noul" as const, noul: 0 }])) } as const;
        } },
      },
    };

    await expect(proposeScenes(p, "ajustar", firstAbort.signal, deps)).rejects.toThrow();
    await proposeScenes(p, "ajustar", signal(), deps);
    expect(batched[0]).toHaveLength(20);
    expect(batched[1]).toHaveLength(1);
    expect(batched[2]).toHaveLength(1);
    expect(generations).toBe(1);
    expect(store.saves).toHaveLength(3);
  });

  it("mantém lote 20 válido ao reparar lote 0 entre interrupções no lote 40", async () => {
    const p = project();
    p.assembly.sources[0]!.durationSeconds = 50;
    const ids = Array.from({ length: 42 }, (_, i) => `a:u${String(i).padStart(3, "0")}`);
    p.analyses[0]!.speech = ids.map((id, i) => ({ id, sourceId: "a", start: i, end: i + 0.8, text: `fala ${i}` }));
    const stored = memoryStore();
    let phase = 1;
    const calls: Array<[number, string]> = [];
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const checkpoint = {
      load: stored.load,
      save: async (value: ProposalCheckpoint) => {
        await stored.save(value);
        if (phase === 2) secondAbort.abort();
      },
    };
    const deps = {
      send: async () => JSON.stringify({
        scenes: [{ id: "s1", objective: "sequência", rationale: "teste", speechIds: ids, support: [], gaps: [] }],
        changedSceneIds: ["s1"],
        cutCandidates: ids.slice(0, -1).map((speechId) => ({ sceneId: "s1", speechId, reason: "redundância" })),
      }),
      checkpoint,
      decision: {
        mode: "observe" as const,
        model: "fake",
        client: { decide: async (request: TypeSafeRequest) => {
          const id = Object.keys(request.questions)[0]!;
          calls.push([phase, id]);
          if (phase === 1 && id.endsWith("a:u000")) return { model: "fake", answers: {} };
          if (phase === 1 && id.endsWith("a:u040")) firstAbort.abort();
          return { model: "fake", answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: "noul" as const, noul: 0 }])) } as const;
        } },
      },
    };

    await expect(proposeScenes(p, "ajustar", firstAbort.signal, deps)).rejects.toThrow();
    expect(Object.keys(stored.saves.at(-1)!.decisions)).toHaveLength(1);
    phase = 2;
    await expect(proposeScenes(p, "ajustar", secondAbort.signal, deps)).rejects.toThrow();
    phase = 3;
    await proposeScenes(p, "ajustar", signal(), deps);

    expect(calls.filter(([, id]) => id.endsWith("u020"))).toHaveLength(1);
    expect(calls.map(([round, id]) => [round, id.split(":").at(-1)])).toEqual([
      [1, "u000"], [1, "u020"], [1, "u040"],
      [2, "u000"],
      [3, "u040"],
    ]);
  });

  it("não guarda resposta inválida de decisão e pode retomá-la", async () => {
    const p = project();
    p.analyses[0]!.speech.push({ id: "a:u002", sourceId: "a", start: 2, end: 2.8, text: "fim" });
    const store = memoryStore();
    const text = JSON.stringify({
      scenes: [{ id: "s1", objective: "sequência", rationale: "teste", speechIds: ["a:u001", "a:u002"], support: [], gaps: [] }],
      changedSceneIds: ["s1"],
      cutCandidates: [{ sceneId: "s1", speechId: "a:u001", reason: "redundância" }],
    });
    let calls = 0;
    const deps = {
      send: async () => text,
      checkpoint: store,
      decision: { mode: "observe" as const, model: "fake", client: { decide: async () => {
        calls += 1;
        return { model: "fake", answers: { "cut:s1:s1:a:u001": { type: "noul" as const, noul: calls === 1 ? 4 : 0 } } } as const;
      } } },
    };
    await proposeScenes(p, "ajustar", signal(), deps);
    expect(Object.keys(store.saves.at(-1)!.decisions)).toHaveLength(0);
    await proposeScenes(p, "ajustar", signal(), deps);
    expect(calls).toBe(2);
  });

  it("reusa o lote de apoio validado depois de interromper o lote seguinte", async () => {
    const p = project();
    p.assembly.sources[1]!.durationSeconds = 30;
    p.analyses[0]!.visual = Array.from({ length: 21 }, (_, i) => ({
      id: `b:v${String(i).padStart(2, "0")}`,
      sourceId: "b",
      start: i,
      end: i + 1,
      text: `imagem ${i}`,
      confidence: "observed" as const,
      tags: [],
    }));
    const store = memoryStore();
    let generations = 0;
    const requests: string[] = [];
    const firstAbort = new AbortController();
    const deps = {
      send: async () => { generations += 1; return rawProposal(); },
      checkpoint: store,
      decision: {
        mode: "observe" as const,
        model: "fake",
        client: { decide: async (request: TypeSafeRequest) => {
          const [id] = Object.entries(request.questions)[0]!;
          requests.push(id);
          if (requests.length === 2) firstAbort.abort();
          return { model: "fake", answers: { [id]: { type: "choice" as const, choice: "none", probabilities: { none: 1 }, confidence: 1 } } } as const;
        } },
      },
    };
    await expect(proposeScenes(p, "ajustar", firstAbort.signal, deps)).rejects.toThrow();
    await proposeScenes(p, "ajustar", signal(), deps);
    expect(requests).toHaveLength(3);
    expect(requests[1]).toBe(requests[2]);
    expect(generations).toBe(1);
  });
});
