import { expect, it } from "vitest";
import { fixtureAssembly } from "./fixture.ts";
import { compileScenes, proposeScenes, validateProposal } from "./scenes.ts";
import type { Project } from "./types.ts";

function project(): Project {
  const assembly = fixtureAssembly();
  return {
    version: 2,
    id: "p1",
    revision: 1,
    input: { kind: "script", text: "abrir com o tema", targetSeconds: 2 },
    assembly,
    scenes: [],
    analyses: [{
      sourceId: "a",
      key: "k",
      speech: [{ id: "a:u001", sourceId: "a", start: 0, end: 2, text: "olá tema" }],
      visual: [{
        id: "a:v0", sourceId: "a", start: 0, end: 1, text: "rosto",
        confidence: "observed", tags: [],
      }],
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

it("recusa fala com ID inexistente", () => {
  const p = project();
  const raw = {
    id: "p1", baseRevision: p.revision, changedSceneIds: ["s1"],
    explanation: "abertura",
    scenes: [{
      id: "s1", objective: "abrir", rationale: "tema",
      speechIds: ["inexistente"], support: [], gaps: [],
    }],
  };
  expect(() => validateProposal(raw, p)).toThrow(/referência/);
});

it("compila fala e apoio sem inventar texto", () => {
  const p = project();
  p.analyses[0]!.visual.push({
    id: "b:v0", sourceId: "b", start: 0, end: 1, text: "apoio",
    confidence: "observed", tags: [],
  });
  const proposal = validateProposal({
    id: "p1",
    baseRevision: 1,
    changedSceneIds: ["s1"],
    explanation: "abertura",
    scenes: [{
      id: "s1",
      objective: "abrir",
      rationale: "tema",
      speechIds: ["a:u001"],
      support: [{ visualId: "b:v0", offsetFrames: 25, durationFrames: 25 }],
      gaps: [],
    }],
  }, p);
  const compiled = compileScenes(p, proposal.scenes);
  expect(compiled.tracks).toHaveLength(3);
  expect(compiled.tracks[0]!.clips[0]!.sourceId).toBe("a");
  expect(compiled.tracks[2]!.clips[0]!.sourceId).toBe("a");
});

it("marca lacuna quando o trecho do roteiro não existe", () => {
  const p = project();
  const proposal = validateProposal({
    id: "p1",
    baseRevision: 1,
    changedSceneIds: ["s1"],
    explanation: "falta cobertura",
    scenes: [{
      id: "s1",
      objective: "fechar",
      rationale: "não há fala",
      speechIds: [],
      support: [],
      gaps: ["sem fala para o encerramento"],
    }],
  }, p);
  expect(proposal.scenes[0]!.gaps).toHaveLength(1);
  const compiled = compileScenes(p, proposal.scenes);
  expect(compiled.tracks.every((t) => t.clips.length === 0)).toBe(true);
});

it("proposta do modelo só entra por ID de fala existente", async () => {
  const p = project();
  const raw = {
    id: "p1",
    baseRevision: 1,
    changedSceneIds: ["s1"],
    explanation: "abertura",
    scenes: [{
      id: "s1",
      objective: "abrir",
      rationale: "tema",
      speechIds: ["a:u001"],
      support: [],
      gaps: [],
    }],
  };
  const proposal = await proposeScenes(p, "abrir", new AbortController().signal, {
    send: async () => JSON.stringify(raw),
  });
  expect(proposal.scenes[0]!.speechIds).toEqual(["a:u001"]);
});

it("Jev decide depois da geração e falha não repete o gerador", async () => {
  const p=project();p.analyses[0]!.speech.push({id:"a:u002",sourceId:"a",start:2,end:3,text:"fechamento"});
  let generations=0, decisions=0;
  const result=await proposeScenes(p,"ajustar",new AbortController().signal,{
    send:async()=>{generations++;return JSON.stringify({scenes:[{id:"s",speechIds:["a:u001","a:u002"]}],changedSceneIds:["s"],cutCandidates:[{sceneId:"s",speechId:"a:u001",reason:"repetição"}],decisionReport:{status:"inventado"}});},
    decision:{mode:"hybrid",model:"test",client:{decide:async req=>{decisions++;expect(JSON.stringify(req.state)).toContain("ajustar");throw Error("sk-secret");}}},
  });
  expect(generations).toBe(1);expect(decisions).toBe(1);
  expect(result.scenes[0]!.takes).toHaveLength(2);
  expect(result.decisionReport?.status).toBe("fallback");
});

it.each([undefined, 999, "1"])("vincula metadados do modelo ao snapshot: %s", async (modelRevision) => {
  const p = project();
  const result = await proposeScenes(p, "abrir", new AbortController().signal, {
    send: async (content) => {
      expect(JSON.stringify(content)).toContain('changedSceneIds');
      p.revision = 9;
      return JSON.stringify({ id: "inventado", baseRevision: modelRevision,
        scenes: [{ id: "s1", objective: "abrir", rationale: "tema", speechIds: ["a:u001"], support: [], gaps: [] }],
        changedSceneIds: ["s1"], explanation: "abertura" });
    },
  });
  expect(result.baseRevision).toBe(1);
  expect(result.id).not.toBe("inventado");
  expect(() => validateProposal(result, p)).toThrow(/revisão desatualizada/);
});

it("continua recusando referência inventada na resposta LLM", async () => {
  await expect(proposeScenes(project(), "abrir", new AbortController().signal, {
    send: async () => JSON.stringify({ scenes: [{ id: "s1", speechIds: ["fake"] }], changedSceneIds: ["s1"] }),
  })).rejects.toThrow(/referência de fala inexistente/);
});

function takeScene() {
  const p = project();
  p.scenes = [{
    id: "s1",
    objective: "abrir",
    rationale: "tema",
    speechIds: ["a:u001"],
    takes: [{
      id: "s1:a:u001", sourceId: "a", speechId: "a:u001",
      start: 0, end: 2, removed: [{ start: 0.4, end: 0.8 }], protected: [],
    }],
    visualEvidenceIds: [],
    support: [],
    gaps: [],
  }];
  return p;
}

function propose(id: string, baseRevision: number, scenes: unknown[], changed: string[]) {
  return { id, baseRevision, changedSceneIds: changed, explanation: "ajuste", scenes };
}

it("cena sem takes compila pelo legado com os mesmos frames", () => {
  const p = project();
  const legacy = compileScenes(p, [{
    id: "s1", objective: "abrir", rationale: "tema",
    speechIds: ["a:u001"], takes: [], visualEvidenceIds: [], support: [], gaps: [],
  }]);
  const fresh = validateProposal(propose("p2", 1, [{
    id: "s1", objective: "abrir", rationale: "tema",
    selections: [{ speechId: "a:u001" }], support: [], gaps: [],
  }], ["s1"]), p);
  const viaTakes = compileScenes(p, fresh.scenes);
  const frames = (tracks: { clips: { sourceId: string; startFrame: number; durationFrames: number; sourceStartSeconds: number }[] }[]) =>
    tracks.map((track) => track.clips.map((clip) =>
      [clip.sourceId, clip.startFrame, clip.durationFrames, clip.sourceStartSeconds]));
  // Mesma mídia nos mesmos frames; só os IDs internos mudam (take+fragmento).
  expect(frames(legacy.tracks)).toEqual(frames(viaTakes.tracks));
});

it("fonte excluída sai do prompt e é rejeitada na proposta e na aprovação", async () => {
  const p = project();
  p.assembly.sources[0]!.included = false;
  let prompt = "";
  await proposeScenes(p, "abrir", new AbortController().signal, {
    send: async (content) => {
      prompt = JSON.stringify(content);
      return JSON.stringify({
        id: "x", baseRevision: 1, changedSceneIds: [], explanation: "nada",
        scenes: [],
      });
    },
  });
  expect(prompt).not.toContain("a:u001");
  expect(prompt).toContain("excluídas do escopo");
  expect(() => validateProposal(propose("y", 1, [{
    id: "s1", objective: "ab", rationale: "t",
    selections: [{ speechId: "a:u001" }], support: [], gaps: [],
  }], ["s1"]), p)).toThrow(/excluída do escopo/);
});

it("compila takes com exclusões sem recortar frase", () => {
  const p = takeScene();
  const compiled = compileScenes(p, p.scenes);
  const a1 = compiled.tracks.find((t) => t.name === "A1")!.clips;
  expect(a1.map((c) => [c.startFrame, c.durationFrames, c.sourceStartSeconds])).toEqual([
    [0, 10, 0], [10, 30, 0.8],
  ]);
  const v1 = compiled.tracks.find((t) => t.name === "V1")!.clips;
  expect(v1).toHaveLength(2);
});

it("takeId reaproveita cortes; speechId do mesmo take é rejeitado", () => {
  const p = takeScene();
  const reused = validateProposal(propose("p2", 1, [{
    id: "s1", objective: "abrir", rationale: "tema",
    selections: [{ takeId: "s1:a:u001" }], support: [], gaps: [],
  }], ["s1"]), p);
  expect(reused.scenes[0]!.takes[0]!.removed).toEqual([{ start: 0.4, end: 0.8 }]);
  expect(reused.scenes[0]!.speechIds).toEqual(["a:u001"]);
  expect(() => validateProposal(propose("p3", 1, [{
    id: "s1", objective: "abrir", rationale: "tema",
    selections: [{ speechId: "a:u001" }], support: [], gaps: [],
  }], ["s1"]), p)).toThrow(/use takeId/);
});

it("rejeita takeId, speechId e evidência desconhecidos ou indisponíveis", () => {
  const p = takeScene();
  p.analyses[0]!.visual.push(
    { id: "a:v9", sourceId: "a", start: 0, end: 1, text: "escuro", confidence: "unavailable", tags: [] },
  );
  const scene = (extra: object) => ({
    id: "s2", objective: "nova", rationale: "tema",
    selections: [{ speechId: "a:u001" }], support: [], gaps: [], ...extra,
  });
  expect(() => validateProposal(propose("x", 1, [{
    id: "s1", objective: "ab", rationale: "t", selections: [{ takeId: "fantasma" }], support: [], gaps: [],
  }], ["s1"]), project())).toThrow(/take inexistente/);
  expect(() => validateProposal(propose("x", 1, [{
    id: "s1", objective: "ab", rationale: "t", selections: [{ speechId: "fantasma" }], support: [], gaps: [],
  }], ["s1"]), project())).toThrow(/fala inexistente/);
  expect(() => validateProposal(propose("x", 1, [scene({ visualEvidenceIds: ["v-fantasma"] })], ["s2"]), p))
    .toThrow(/visual inexistente/);
  expect(() => validateProposal(propose("x", 1, [scene({ visualEvidenceIds: ["a:v9"] })], ["s2"]), p))
    .toThrow(/não fundamenta/);
});

it("cena fora do escopo: eco só-id preserva, divergência rejeita", () => {
  const p = takeScene();
  const kept = validateProposal(propose("p2", 1, [{ id: "s1" }], []), p);
  expect(kept.scenes[0]).toEqual(p.scenes[0]);
  expect(() => validateProposal(propose("p3", 1, [{
    id: "s1", objective: "outro", rationale: "tema",
    selections: [{ takeId: "s1:a:u001" }], support: [], gaps: [],
  }], []), p)).toThrow(/fora do escopo/);
});

it("proposta não remove trecho protegido", () => {
  const p = takeScene();
  p.analyses[0]!.speech.push({ id: "a:u002", sourceId: "a", start: 0.5, end: 1.2, text: "meio" });
  p.scenes[0]!.takes[0]!.protected = [{ start: 1.0, end: 1.5 }];
  // Take novo cobrindo só parte do protegido ([1.2, 1.5) se perde): conflito.
  expect(() => validateProposal(propose("p2", 1, [{
    id: "s1", objective: "abrir", rationale: "tema",
    selections: [{ speechId: "a:u002" }],
    support: [], gaps: [],
  }], ["s1"]), p)).toThrow(/protegido/);
  // takeId reaproveita integralmente: preserva.
  const ok = validateProposal(propose("p3", 1, [{
    id: "s1", objective: "abrir", rationale: "tema",
    selections: [{ takeId: "s1:a:u001" }], support: [], gaps: [],
  }], ["s1"]), p);
  expect(ok.scenes[0]!.takes[0]!.protected).toEqual([{ start: 1.0, end: 1.5 }]);
});

it("categorias: fala não vira apoio e apoio não vira fala", () => {
  const p = project();
  p.analyses[0]!.visual.push(
    { id: "a:vx", sourceId: "a", start: 0, end: 1, text: "rosto", confidence: "observed", tags: [] },
  );
  expect(() => validateProposal(propose("x", 1, [{
    id: "s1", objective: "ab", rationale: "t",
    selections: [{ speechId: "a:u001" }],
    support: [{ visualId: "a:vx", offsetFrames: 0, durationFrames: 25 }],
    gaps: [],
  }], ["s1"]), p)).toThrow(/categoria speech/);
  // Fonte b (support) fornecendo fala: rejeita.
  p.analyses.push({
    sourceId: "b", key: "k2",
    speech: [{ id: "b:u001", sourceId: "b", start: 0, end: 1, text: "fundo" }],
    visual: [], status: "ready",
    words: [], wordsStatus: "missing",
    visualCoverage: { requested: [], returned: [], missing: [] },
  });
  expect(() => validateProposal(propose("y", 1, [{
    id: "s1", objective: "ab", rationale: "t",
    selections: [{ speechId: "b:u001" }], support: [], gaps: [],
  }], ["s1"]), p)).toThrow(/categoria support/);
});

it("apoio além da cena é limitado com nota na explicação", () => {
  const p = project();
  p.analyses[0]!.visual.push(
    { id: "b:v0", sourceId: "b", start: 0, end: 2, text: "apoio", confidence: "observed", tags: [] },
  );
  const proposal = validateProposal(propose("p2", 1, [{
    id: "s1", objective: "abrir", rationale: "tema",
    selections: [{ speechId: "a:u001" }],
    support: [{ visualId: "b:v0", offsetFrames: 40, durationFrames: 25 }],
    gaps: [],
  }], ["s1"]), p);
  // Cena tem 50 frames (2s a 25fps); apoio a partir de 40 pede 25, cabem 10.
  expect(proposal.scenes[0]!.rationale).toContain("limitado a 10f");
  const compiled = compileScenes(p, proposal.scenes);
  const v2 = compiled.tracks.find((t) => t.name === "V2")!.clips;
  expect(v2).toHaveLength(1);
  expect(v2[0]!.startFrame).toBe(40);
  expect(v2[0]!.durationFrames).toBe(10);
});

it("apoio posicionado após o início da cena mantém entrada correta e não é descartado", () => {
  const p = project();
  p.analyses[0]!.visual.push(
    { id: "b:v_short", sourceId: "b", start: 0, end: 1, text: "apoio curto", confidence: "observed", tags: [] },
  );
  const proposal = validateProposal(propose("p_broll", 1, [{
    id: "s1", objective: "abrir", rationale: "tema",
    selections: [{ speechId: "a:u001" }],
    support: [{ visualId: "b:v_short", offsetFrames: 30, durationFrames: 15 }],
    gaps: [],
  }], ["s1"]), p);

  const compiled = compileScenes(p, proposal.scenes);
  const v2 = compiled.tracks.find((t) => t.name === "V2")!.clips;
  expect(v2).toHaveLength(1);
  expect(v2[0]!.startFrame).toBe(30);
  expect(v2[0]!.durationFrames).toBe(15);
  expect(v2[0]!.sourceStartSeconds).toBe(0);
});

it("proposeScenes envia fala com texto efetivo corrigido", async () => {
  const p = project();
  p.analyses[0]!.words = [
    { id: "w1", sourceId: "a", text: "Niltão", confidence: null, start: 0.1, end: 0.4 },
    { id: "w2", sourceId: "a", text: "Pinto", confidence: null, start: 0.42, end: 0.7 },
  ];
  p.analyses[0]!.wordsStatus = "ready";
  p.corrections = [{
    id: "c1", sourceId: "a", start: 0.1, end: 0.4, text: "Nilton",
    status: "aligned",
    words: [{ id: "wc1", sourceId: "a", text: "Nilton", confidence: 0.9, start: 0.1, end: 0.4 }],
  }];
  let prompt = "";
  await proposeScenes(p, "abrir", new AbortController().signal, {
    send: async (content) => {
      prompt = JSON.stringify(content);
      return JSON.stringify({
        id: "x", baseRevision: 1, changedSceneIds: ["s1"], explanation: "ok",
        scenes: [{ id: "s1", objective: "ab", rationale: "t", selections: [{ speechId: "a:u001" }], support: [], gaps: [] }],
      });
    },
  });
  expect(prompt).toContain("Nilton Pinto");
  expect(prompt).not.toContain("Niltão");
});

it("fragmento de ~1 frame na grade não é descartado na compilação", () => {
  const p = project();
  // 25 fps: 0.02s=0.5f → round 1; 0.04s=1.0f → round 1; last<=first descarta.
  p.scenes = [{
    id: "s1",
    objective: "abrir",
    rationale: "tema",
    speechIds: ["a:u001"],
    takes: [{
      id: "t1", sourceId: "a", speechId: "a:u001",
      start: 0.02, end: 0.04, removed: [], protected: [],
    }],
    visualEvidenceIds: [],
    support: [],
    gaps: [],
  }];
  const compiled = compileScenes(p, p.scenes);
  const v1 = compiled.tracks.find((t) => t.name === "V1")!.clips;
  expect(v1).toHaveLength(1);
  expect(v1[0]!.durationFrames).toBe(1);
  expect(v1[0]!.startFrame).toBe(0);
});

it("aceita texto fora do JSON sem outra chamada e ainda valida suas referências", async () => {
  const p = project();
  const raw = { changedSceneIds: ["s1"], scenes: [{ id: "s1", objective: "abrir", speechIds: ["a:u001"], support: [], gaps: [] }] };
  let calls = 0;
  const proposal = await proposeScenes(p, "abrir", new AbortController().signal, {
    send: async () => { calls++; return JSON.stringify(raw) + (calls === 1 ? "\nExplicação fora do JSON" : ""); },
  });
  expect(calls).toBe(1);
  expect(proposal.scenes[0]!.speechIds).toEqual(["a:u001"]);
});

it("envia briefing salvo e pedido adicional sem apagar a duração", async () => {
  let sent = "";
  await proposeScenes(project(), "destacar abertura", new AbortController().signal, {
    send: async content => {
      sent = JSON.stringify(content);
      return JSON.stringify({scenes: [], changedSceneIds: [], explanation: "sem proposta"});
    },
  });
  expect(sent).toContain("abrir com o tema");
  expect(sent).toContain("targetSeconds");
  expect(sent).toContain("destacar abertura");
});


it("envia só evidências visuais existentes sem alterar o catálogo de b-roll", async () => {
  const p = project();
  p.scenes = [{id: "s1", objective: "abrir", rationale: "tema", speechIds: [], takes: [],
    visualEvidenceIds: ["a:v0"], support: [], gaps: []}];
  p.analyses[0]!.visual.push({...p.analyses[0]!.visual[0]!, id: "a:v1", text: "DESCRICAO_APENAS_BROLL"});
  let sent = "";
  await proposeScenes(p, "ajustar", new AbortController().signal, {
    send: async content => {
      sent = JSON.stringify(content);
      return JSON.stringify({scenes: [{id: "s1"}], changedSceneIds: [], explanation: "preservar"});
    },
  });
  expect(sent).toContain("rosto");
  expect(sent).not.toContain("DESCRICAO_APENAS_BROLL");
  expect(p.analyses[0]!.visual).toHaveLength(2);
});
