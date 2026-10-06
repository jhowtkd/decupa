import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertFillerGoldGate, evaluateFillerGold, fillerGoldGate, FILLER_NEGATIVE_CATEGORIES,
  measureFillerGold, parseFillerGold, type FillerGoldItem,
} from "./filler-gold.ts";
import {
  classifyFillers, FILLER_AUTO_CATEGORIES, FILLER_CATEGORIES, FILLER_MECHANIC_VERSION,
  FILLER_MIN_GAP_SECONDS, normalizeFillerText, type FillerToken,
} from "./fillers.ts";
import { ritmoFillerTokens } from "./fillers.fixture.ts";

const ritmoBytes = readFileSync(new URL("../fixtures/ritmo.speech_index.json", import.meta.url));
const ritmo = JSON.parse(ritmoBytes.toString());
const goldRaw = JSON.parse(readFileSync(new URL("../fixtures/cacoetes.pt-br.json", import.meta.url), "utf8"));
const gold = parseFillerGold(goldRaw);

describe("canário — texto do ritmo, sem prova de alinhamento ou áudio", () => {
  // Este fixture não tem confidence: true é simulação só para exercer regras.
  const tokens = ritmoFillerTokens(ritmo, { simulateAlignment: true });

  it("fixa as três tags textuais e os conjuntos com corredor por fluxo", () => {
    // Antes de u031/u037/u040 há 20/60/100 ms. Só a Limpeza aceita
    // os 20 ms de u031; a Montagem exige 50 ms (igualdade aceita).
    for (const flow of ["montagem", "limpeza"] as const) {
      const candidates = classifyFillers(tokens, FILLER_AUTO_CATEGORIES[flow], FILLER_MIN_GAP_SECONDS[flow]);
      expect(candidates).toHaveLength(15);
      expect(candidates.filter(candidate => candidate.category === "ambiguous")).toHaveLength(11);
      const tags = candidates.filter(candidate => candidate.category === "tag_final");
      expect(tags.map(candidate => candidate.wordIds[0])).toEqual(["ritmo:u031:w8", "ritmo:u037:w7", "ritmo:u040:w6"]);
      expect(tags.filter(candidate => candidate.verdict === "signal").map(candidate => candidate.wordIds[0])).toEqual(
        flow === "montagem" ? ["ritmo:u037:w7", "ritmo:u040:w6"] : ["ritmo:u031:w8", "ritmo:u037:w7", "ritmo:u040:w6"],
      );
      expect(tags.filter(candidate => candidate.verdict === "abstain").map(candidate => candidate.wordIds[0])).toEqual(
        flow === "montagem" ? ["ritmo:u031:w8"] : [],
      );
      const units = candidates.filter(candidate => candidate.category === "unit_only_filler");
      // u003 tem 30 ms antes: continua B3 nos dois fluxos, mas não cabe
      // no corredor de 50 ms da Montagem.
      expect(units.map(candidate => [candidate.wordIds, candidate.verdict])).toEqual([
        [["ritmo:u003:w0"], flow === "montagem" ? "abstain" : "signal"],
      ]);
    }
  });

  it("os sete tá verbais ficam preservados nos dois fluxos", () => {
    const verbs = tokens.filter(token => normalizeFillerText(token.text) === "tá" && !token.isLastInUnit);
    expect(verbs).toHaveLength(7);
    const auto = new Set(FILLER_CATEGORIES.filter(category => category !== "ambiguous"));
    for (const flow of ["montagem", "limpeza"] as const) {
      const candidates = classifyFillers(tokens, auto, FILLER_MIN_GAP_SECONDS[flow]);
      const cutIds = candidates.filter(candidate => candidate.verdict === "cut").flatMap(candidate => candidate.wordIds);
      expect(verbs.every(token => !cutIds.includes(token.wordId))).toBe(true);
      for (const verb of verbs) {
        expect(candidates.find(candidate => candidate.wordIds.includes(verb.wordId)))
          .toMatchObject({ category: "ambiguous", verdict: expect.not.stringMatching(/^cut$/) });
      }
    }
  });

  it("Entende? é unidade inteira e só sinaliza", () => {
    expect(classifyFillers(tokens, FILLER_AUTO_CATEGORIES.limpeza, FILLER_MIN_GAP_SECONDS.limpeza)).toContainEqual(expect.objectContaining({
      category: "unit_only_filler", wordIds: ["ritmo:u003:w0"], verdict: "signal",
    }));
  });

  it("sem simulação, palavras sem confidence se abstêm", () => {
    const real = ritmoFillerTokens(ritmo, { simulateAlignment: false });
    expect(real.every(token => !token.aligned)).toBe(true);
    expect(classifyFillers(real, FILLER_AUTO_CATEGORIES.limpeza, FILLER_MIN_GAP_SECONDS.limpeza).every(candidate => candidate.verdict === "abstain")).toBe(true);
  });
});

describe("procedência do gold inicial", () => {
  it("só contém dev por leitura técnica independente, nunca escuta inventada", () => {
    expect(gold.items.length).toBeGreaterThan(0);
    expect(gold.items.every(item => item.split === "dev" && item.method === "implementation-reading"
      && item.audio === "unreviewed" && item.mechanicVersion === null
      && item.source.labelNote.includes("rótulo de leitura, não de escuta"))).toBe(true);
    expect(gold.provenance.sourceSha256).toBe(createHash("sha256").update(ritmoBytes).digest("hex"));
    expect(gold.provenance.transcriptSha256).toBe(ritmo.transcript_sha256);
    expect(gold.provenance.asrProfile).toBeNull();
    expect(gold.provenance.timingNote).toContain("Alinhamento simulado");
    const tokens = ritmoFillerTokens(ritmo, { simulateAlignment: true });
    for (const item of gold.items) {
      expect(item.tokens).toEqual(tokens.filter(token => token.unitId === item.source.unitId));
      expect(item.source.transcriptSha256).toBe(ritmo.transcript_sha256);
    }
  });

  it("eval só aceita human-listening, e leitura técnica não pode ter audio ok", () => {
    const evalReading = structuredClone(goldRaw); evalReading.items[0].split = "eval";
    expect(() => parseFillerGold(evalReading)).toThrow(/rótulos/);
    const heardReading = structuredClone(goldRaw); heardReading.items[0].audio = "ok";
    expect(() => parseFillerGold(heardReading)).toThrow(/rótulos/);
    const invalid = structuredClone(goldRaw); invalid.items[0].tokens[0].start = "inválido";
    expect(() => parseFillerGold(invalid)).toThrow(/start/);
  });

  it("rejeita method, split, cell e categoria redundante inválidos", () => {
    for (const field of ["method", "split"] as const) {
      const invalid = structuredClone(goldRaw); invalid.items[0][field] = "desconhecido";
      expect(() => parseFillerGold(invalid)).toThrow(/rótulos/);
    }
    for (const field of ["flow", "category"] as const) {
      const invalid = structuredClone(goldRaw); invalid.items[0].cell[field] = "desconhecido";
      expect(() => parseFillerGold(invalid)).toThrow(/rótulos/);
    }
    const mismatch = structuredClone(goldRaw); mismatch.items[0].category = "ambiguous";
    expect(() => parseFillerGold(mismatch)).toThrow(/rótulos/);
    const redundant = structuredClone(goldRaw); redundant.items[0].category = redundant.items[0].cell.category;
    expect(parseFillerGold(redundant)).toEqual(gold);
  });

  it.each(["ok", "bad_join"])("áudio %s exige uma versão da mecânica", audio => {
    const reviewed = structuredClone(goldRaw);
    Object.assign(reviewed.items[0], { split: "eval", method: "human-listening", audio });
    expect(() => parseFillerGold(reviewed)).toThrow(/mechanicVersion/);
    reviewed.items[0].mechanicVersion = FILLER_MECHANIC_VERSION.montagem;
    expect(parseFillerGold(reviewed).items[0].audio).toBe(audio);
  });

  it("trava exatamente as categorias iniciais e seu portão de compatibilidade", () => {
    expect([...FILLER_AUTO_CATEGORIES.montagem]).toEqual(["hesitation"]);
    expect([...FILLER_AUTO_CATEGORIES.limpeza]).toEqual(["hesitation", "repetition"]);
    expect(() => assertFillerGoldGate(gold.items)).not.toThrow();
  });
});

// Casos sintéticos só testam o portão; não são evidência humana nem itens do corpus.
function synthetic(text: string, category: FillerGoldItem["cell"]["category"] = "tag_final"): FillerGoldItem {
  const words = text.split(" ");
  const tokens: FillerToken[] = words.map((text, i) => ({
    wordId: `w${i}`, text, start: i + 0.1, end: i + 0.5, aligned: true,
    unitId: "u1", unitEndsWithQuestion: words.at(-1)!.endsWith("?"), isLastInUnit: i === words.length - 1,
    unitWordCount: words.length, nextUnitOpensWithAnswer: false,
    separatorBefore: i ? (words[i - 1]!.match(/[,.;!?]+$/)?.[0] ?? "") + " " : "",
    prevEnd: i ? i - 0.5 : null, nextStart: i + 1 < words.length ? i + 1.1 : null,
  }));
  return { id: "synthetic", split: "eval", cell: { flow: "montagem", category }, tokens,
    targetWordIds: [tokens.at(-1)!.wordId], editorial: "cut", audio: "ok", reachable: true, control: false,
    method: "human-listening", mechanicVersion: FILLER_MECHANIC_VERSION.montagem,
    source: { unitId: "u1", transcriptSha256: "synthetic", labelNote: "simulação de metadados, não evidência" },
  };
}

function tenHeard(): FillerGoldItem[] {
  return Array.from({ length: 10 }, (_, i) => ({ ...synthetic("funciona né?"), id: `synthetic-${i}` }));
}

describe("gold — métricas e negativos", () => {
  it("separa retirada incorreta de omissão e conserva inalcançáveis no denominador", () => {
    const correct = synthetic("funciona né?");
    const incorrect = { ...correct, id: "incorrect", editorial: "keep" as const, control: true };
    const omission = { ...correct, id: "omission", reachable: false, tokens: [] };
    const row = measureFillerGold([correct, incorrect, omission], "eval").find(row => row.cell.flow === "montagem" && row.cell.category === "tag_final")!;
    expect(row).toMatchObject({ n: 3, reachable: 2, detected: 2, incorrect_removal: 1, omission: 1, correct_removal: 1 });
    expect(row.coverage).toBe(2 / 3);
    expect(row.reachability).toBe(2 / 3);
    const estimated = structuredClone(correct); estimated.tokens[1]!.aligned = false;
    expect(evaluateFillerGold(estimated)).toMatchObject({ abstained: true, incorrect_removal: 0, omission: 1 });
  });

  it("cobre as sete categorias de negativo sem liberar cortes", () => {
    const cases = {
      e_hesitacao: synthetic("eu é acho", "ambiguous"),
      ta_verbo: synthetic("ele tá trabalhando", "ambiguous"),
      sim_resposta: synthetic("Sim.", "ambiguous"),
      ha_pergunta: synthetic("Hã?", "unit_only_filler"),
      hum_concordancia: synthetic("Hum.", "unit_only_filler"),
      ne_pergunta_real: synthetic("funciona né?"),
      enfase_repetida: synthetic("muito, muito importante", "repetition"),
    };
    expect(Object.keys(cases)).toEqual([...FILLER_NEGATIVE_CATEGORIES]);
    cases.ne_pergunta_real.tokens.at(-1)!.nextUnitOpensWithAnswer = true;
    for (const item of Object.values(cases)) {
      for (const flow of ["montagem", "limpeza"] as const) {
        expect(classifyFillers(item.tokens, FILLER_AUTO_CATEGORIES[flow], FILLER_MIN_GAP_SECONDS[flow])
          .some(candidate => candidate.verdict === "cut")).toBe(false);
      }
    }
  });
});

describe("portão — escuta por célula e versão da mecânica", () => {
  const cell = { flow: "montagem" as const, category: "tag_final" as const };

  it("dez aprovados humanos na versão atual liberam só sua célula", () => {
    expect(fillerGoldGate(tenHeard(), cell)).toMatchObject({ passed: true, heard: 10 });
    expect(fillerGoldGate(tenHeard(), { flow: "limpeza", category: "tag_final" }).passed).toBe(false);
    expect(fillerGoldGate(tenHeard().slice(0, 9), cell)).toMatchObject({ passed: false, heard: 9 });
  });

  it("nova mecânica obriga novo ensaio", () => {
    expect(fillerGoldGate(tenHeard(), cell, "montagem:2").reasons).toContain("rode o ensaio de novo para esta célula");
    expect(() => assertFillerGoldGate(tenHeard(), { montagem: new Set(["tag_final"]), limpeza: new Set() }, { montagem: "montagem:2", limpeza: "outro" }))
      .toThrow("rode o ensaio de novo para esta célula");
  });

  it("controle que seria cortado reprova e não entra no mínimo", () => {
    const control = { ...synthetic("funciona né?"), id: "control", control: true, editorial: "keep" as const };
    const gate = fillerGoldGate([...tenHeard(), control], cell);
    expect(gate).toMatchObject({ passed: false, heard: 10 });
    expect(gate.reasons).toContain("incorrect_removal editorial, incluindo controles");
    const controls = tenHeard().map(item => ({ ...item, control: true }));
    expect(fillerGoldGate(controls, cell)).toMatchObject({ passed: false, heard: 0 });
  });

  it("bad_join ouvido reprova até células de compatibilidade", () => {
    const bad = { ...synthetic("eu hã acho", "hesitation"), audio: "bad_join" as const, targetWordIds: ["w1"] };
    expect(fillerGoldGate([bad], bad.cell).reasons).toContain("bad_join ouvido nesta célula");
    const samples = tenHeard(); samples[0]!.audio = "bad_join";
    expect(fillerGoldGate(samples, cell).passed).toBe(false);
  });

  it("compatibilidade dispensa n mínimo, mas nunca ignora corte editorial incorreto", () => {
    for (const flow of ["montagem", "limpeza"] as const) expect(fillerGoldGate([], { flow, category: "hesitation" }).passed).toBe(true);
    expect(fillerGoldGate([], { flow: "limpeza", category: "repetition" }).passed).toBe(true);
    expect(fillerGoldGate([], { flow: "montagem", category: "repetition" }).passed).toBe(false);
    const keep = { ...synthetic("eu hã acho", "hesitation"), targetWordIds: ["w1"], editorial: "keep" as const, control: true };
    expect(fillerGoldGate([keep], keep.cell).passed).toBe(false);
  });

  it("implementation-reading nunca libera nem reprova uma célula", () => {
    const reading = tenHeard().map(item => ({ ...item, method: "implementation-reading" as const }));
    expect(fillerGoldGate(reading, cell)).toMatchObject({ passed: false, heard: 0 });
    // Mesmo metadados falsos de áudio/corte vindos da leitura ficam fora.
    const fakeControl = { ...reading[0]!, control: true, editorial: "keep" as const, audio: "bad_join" as const };
    expect(fillerGoldGate([...tenHeard(), fakeControl], cell)).toMatchObject({ passed: true, heard: 10, reasons: [] });
    const readingCompatibility = { ...synthetic("eu hã acho", "hesitation"), method: "implementation-reading" as const,
      targetWordIds: ["w1"], editorial: "keep" as const, audio: "bad_join" as const };
    expect(fillerGoldGate([readingCompatibility], readingCompatibility.cell).passed).toBe(true);
  });
});
