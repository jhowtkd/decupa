import { describe, expect, it } from "vitest";
import { acceptedDropIds, verifyClaims, type StructureClaim } from "./claims.ts";
import { parseSpeechIndex } from "./speech-index.ts";

/** Miniatura do material real: pré-rolo, corpo, retomada, aparte, pós-rolo. */
const index = parseSpeechIndex({
  source_duration: 100,
  budget: { lossless_floor_seconds: 50 },
  topic_runs: [{ keyword: "escala", unit_ids: ["u003", "u007"] }],
  units: [
    { id: "u001", index: 0, start: 0, end: 2, duration: 2, text: "Eu esqueci o começo, perdão." },
    { id: "u002", index: 1, start: 3, end: 5, duration: 2, text: "Agora vai, calma aí." },
    { id: "u003", index: 2, start: 6, end: 9, duration: 3, text: "Isso não escala e não te dá." },
    { id: "u004", index: 3, start: 10, end: 11, duration: 1, text: "Isso não escala" },
    { id: "u005", index: 4, start: 12, end: 13, duration: 1, text: "Isso não escala..." },
    { id: "u006", index: 5, start: 14, end: 16, duration: 2, text: "Nossa, hoje o sol está puxando." },
    { id: "u007", index: 6, start: 17, end: 21, duration: 4, text: "Dessa forma, não escala a comunicação." },
    { id: "u008", index: 7, start: 22, end: 24, duration: 2, text: "Ih, foi!" },
  ],
});

const claim = (c: Partial<StructureClaim> & Pick<StructureClaim, "unit_ids" | "reason">): StructureClaim =>
  ({ restated_by: null, note: "", source: "model", ...c });

describe("verifyClaims — pré-rolo", () => {
  it("aceita trecho contíguo do começo, antes do primeiro topic_run", () => {
    const [v] = verifyClaims([claim({ unit_ids: ["u001", "u002"], reason: "preroll" })], index);
    expect(v!.accepted).toBe(true);
  });

  it("rejeita pré-rolo que não começa na primeira unidade", () => {
    const [v] = verifyClaims([claim({ unit_ids: ["u002"], reason: "preroll" })], index);
    expect(v!.accepted).toBe(false);
    expect(v!.accepted === false && v!.failed).toMatch(/primeira unidade/);
  });

  it("rejeita pré-rolo que invade o corpo do vídeo", () => {
    // u003 já está num topic_run — não pode ser pré-rolo
    const [v] = verifyClaims([claim({ unit_ids: ["u001", "u002", "u003"], reason: "preroll" })], index);
    expect(v!.accepted).toBe(false);
    expect(v!.accepted === false && v!.failed).toMatch(/topic_run/);
  });

  it("rejeita pré-rolo com buraco no meio", () => {
    const [v] = verifyClaims([claim({ unit_ids: ["u001", "u003"], reason: "preroll" })], index);
    expect(v!.accepted).toBe(false);
    expect(v!.accepted === false && v!.failed).toMatch(/contígu/);
  });
});

describe("verifyClaims — pós-rolo", () => {
  it("aceita trecho contíguo do fim, depois do último topic_run", () => {
    const [v] = verifyClaims([claim({ unit_ids: ["u008"], reason: "postroll" })], index);
    expect(v!.accepted).toBe(true);
  });

  it("rejeita pós-rolo que não termina na última unidade", () => {
    const [v] = verifyClaims([claim({ unit_ids: ["u006"], reason: "postroll" })], index);
    expect(v!.accepted).toBe(false);
    expect(v!.accepted === false && v!.failed).toMatch(/última unidade/);
  });
});

describe("verifyClaims — bloco de retomada", () => {
  it("aceita bloco cujas unidades se repetem, com versão completa depois", () => {
    const [v] = verifyClaims(
      [claim({ unit_ids: ["u003", "u004", "u005"], reason: "restart_block", restated_by: "u007" })],
      index,
    );
    expect(v!.accepted).toBe(true);
  });

  it("rejeita quando falta restated_by", () => {
    const [v] = verifyClaims(
      [claim({ unit_ids: ["u003", "u004", "u005"], reason: "restart_block" })],
      index,
    );
    expect(v!.accepted).toBe(false);
    expect(v!.accepted === false && v!.failed).toMatch(/restated_by/);
  });

  it("rejeita quando nenhuma unidade do bloco repete outra", () => {
    const [v] = verifyClaims(
      [claim({ unit_ids: ["u006", "u007"], reason: "restart_block", restated_by: "u008" })],
      index,
    );
    expect(v!.accepted).toBe(false);
    expect(v!.accepted === false && v!.failed).toMatch(/quase-verbatim/);
  });

  it("rejeita quando restated_by também está sendo dropada", () => {
    const [v] = verifyClaims(
      [
        claim({ unit_ids: ["u003", "u004", "u005"], reason: "restart_block", restated_by: "u007" }),
        claim({ unit_ids: ["u007"], reason: "aside" }),
      ],
      index,
    );
    expect(v!.accepted).toBe(false);
    expect(v!.accepted === false && v!.failed).toMatch(/também está sendo dropada/);
  });

  it("rejeita quando restated_by vem antes do bloco", () => {
    const [v] = verifyClaims(
      [claim({ unit_ids: ["u004", "u005"], reason: "restart_block", restated_by: "u003" })],
      index,
    );
    expect(v!.accepted).toBe(false);
    expect(v!.accepted === false && v!.failed).toMatch(/posterior/);
  });
});

describe("verifyClaims — aparte", () => {
  it("aceita unidade fora de topic_run com conteúdo dos dois lados", () => {
    const [v] = verifyClaims([claim({ unit_ids: ["u006"], reason: "aside" })], index);
    expect(v!.accepted).toBe(true);
  });

  it("rejeita aparte que pertence a um topic_run", () => {
    const [v] = verifyClaims([claim({ unit_ids: ["u007"], reason: "aside" })], index);
    expect(v!.accepted).toBe(false);
    expect(v!.accepted === false && v!.failed).toMatch(/topic_run/);
  });

  it("rejeita aparte na borda — isso seria pré ou pós-rolo", () => {
    const [v] = verifyClaims([claim({ unit_ids: ["u008"], reason: "aside" })], index);
    expect(v!.accepted).toBe(false);
    expect(v!.accepted === false && v!.failed).toMatch(/dos dois lados/);
  });

  it("aceita aparte em topic_run quando a unidade é fala com o operador", () => {
    const withCue = parseSpeechIndex({
      source_duration: 20,
      budget: { lossless_floor_seconds: 10 },
      topic_runs: [{ keyword: "escala", unit_ids: ["u002"] }],
      units: [
        { id: "u001", index: 0, start: 0, end: 2, duration: 2, text: "Dicas pra você parar de ser chatão." },
        { id: "u002", index: 1, start: 3, end: 5, duration: 2, text: "Peraí, vou repetir." },
        { id: "u003", index: 2, start: 6, end: 9, duration: 3, text: "Dessa forma, não escala a comunicação." },
      ],
    });
    const [v] = verifyClaims([claim({ unit_ids: ["u002"], reason: "aside" })], withCue);
    expect(v!.accepted).toBe(true);
  });
});

describe("verifyClaims — categoria inventada", () => {
  it("rejeita reason fora do enum com uma frase que diz qual foi", () => {
    // Provedor sem `json_schema` (Z.ai usa `json_object`) não obriga o enum.
    // Sem um `default` no switch isto virava rejeição com `failed: undefined`,
    // e o relatório imprimia "falhou: undefined".
    const invalida = { unit_ids: ["u001"], reason: "porque_sim", restated_by: null, note: "", source: "model" };
    const [v] = verifyClaims([invalida as unknown as StructureClaim], index);
    expect(v!.accepted).toBe(false);
    expect(v!.accepted === false && v!.failed).toMatch(/porque_sim/);
    expect(v!.accepted === false && v!.failed).toMatch(/retake/);
    expect(v!.accepted === false && v!.failed).toMatch(/dead_air/);
    expect(v!.accepted === false && v!.failed).toMatch(/director_cue/);
  });
});

describe("verifyClaims — id inventado", () => {
  it("rejeita em vez de estourar quando o modelo cita unidade inexistente", () => {
    const [v] = verifyClaims([claim({ unit_ids: ["u999"], reason: "preroll" })], index);
    expect(v!.accepted).toBe(false);
    expect(v!.accepted === false && v!.failed).toMatch(/u999/);
  });
});

describe("verifyClaims — índice sem unidades", () => {
  it("rejeita alegação defensivamente se o índice não tiver unidades", () => {
    const emptyIndex = {
      units: [],
      topicRuns: [],
      trimCandidates: [],
      losslessFloorSeconds: 0,
      sourceDurationSeconds: 0,
    };
    const [v] = verifyClaims([claim({ unit_ids: ["u001"], reason: "preroll" })], emptyIndex);
    expect(v!.accepted).toBe(false);
    expect(v!.accepted === false && v!.failed).toMatch(/não possui unidades/);
  });
});

describe("ordem de avaliação", () => {
  it("é independente da ordem das alegações", () => {
    const a = claim({ unit_ids: ["u001", "u002"], reason: "preroll" });
    const b = claim({ unit_ids: ["u006"], reason: "aside" });
    const c = claim({ unit_ids: ["u008"], reason: "postroll" });
    const forward = verifyClaims([a, b, c], index).map((v) => v.accepted);
    const backward = verifyClaims([c, b, a], index).map((v) => v.accepted).reverse();
    expect(forward).toEqual(backward);
    expect(forward).toEqual([true, true, true]);
  });
});

const ritmoish = parseSpeechIndex({
  source_duration: 80,
  budget: { lossless_floor_seconds: 40 },
  topic_runs: [{ keyword: "resultado", unit_ids: ["u026", "u027"] }],
  trim_candidates: [
    {
      id: "u021",
      seconds: 4.461,
      text: "E quem",
      reasons: ["almost no content for its length", "very slow (1.1 chars/s) — dead air inside the sentence"],
    },
    {
      id: "u027",
      seconds: 1.261,
      text: "E quem contrata quer resultado.",
      reasons: ["restates u026 (similarity 0.881)"],
    },
  ],
  units: [
    { id: "u012", index: 0, start: 0, end: 2, duration: 2, text: "empresas, entre outras.", has_terminal_punct: true, word_count: 3 },
    { id: "u013", index: 1, start: 3, end: 5, duration: 2, text: "entre outras empresas,", has_terminal_punct: false, word_count: 3 },
    { id: "u020", index: 2, start: 6, end: 10, duration: 4, text: "Quem estuda na instituição quer sentir pertecente.", has_terminal_punct: true, word_count: 7 },
    { id: "u021", index: 3, start: 11, end: 15, duration: 4.4, text: "E quem", has_terminal_punct: false, word_count: 2, cps: 1.12 },
    { id: "u022", index: 4, start: 16, end: 17, duration: 1.3, text: "já está na instituição", has_terminal_punct: false, word_count: 4 },
    { id: "u023", index: 5, start: 18, end: 20, duration: 1.7, text: "quer sentir pertencente dela.", has_terminal_punct: true, word_count: 4 },
    { id: "u026", index: 6, start: 21, end: 24, duration: 2.7, text: "E quem contrata quer sentir o resultado.", has_terminal_punct: true, word_count: 7 },
    { id: "u027", index: 7, start: 25, end: 26, duration: 1.3, text: "E quem contrata quer resultado.", has_terminal_punct: true, word_count: 5, near_duplicate_of: "u026", similarity: 0.881 },
    { id: "u028", index: 8, start: 27, end: 30, duration: 3, text: "Aí você tendo isso em mente, você vai lá e fala", has_terminal_punct: false, word_count: 11 },
  ],
});

describe("verifyClaims — retake", () => {
  it("aceita drop de u026 com restated_by u027", () => {
    const [v] = verifyClaims(
      [claim({ unit_ids: ["u026"], reason: "retake", restated_by: "u027", source: "mechanical" })],
      ritmoish,
    );
    expect(v!.accepted).toBe(true);
  });

  it("aceita drop de u012 com restated_by u013", () => {
    const [v] = verifyClaims(
      [claim({ unit_ids: ["u012"], reason: "retake", restated_by: "u013", source: "mechanical" })],
      ritmoish,
    );
    expect(v!.accepted).toBe(true);
  });

  it("aceita restated_by anterior quando o take de depois perdeu (u021-u023 vs u020)", () => {
    const [v] = verifyClaims(
      [claim({ unit_ids: ["u021", "u022", "u023"], reason: "retake", restated_by: "u020", source: "mechanical" })],
      ritmoish,
    );
    expect(v!.accepted).toBe(true);
  });

  it("rejeita restated_by anterior quando a fonte é o modelo", () => {
    const [v] = verifyClaims(
      [claim({ unit_ids: ["u021", "u022", "u023"], reason: "retake", restated_by: "u020", source: "model" })],
      ritmoish,
    );
    expect(v!.accepted).toBe(false);
    expect(v!.accepted === false && v!.failed).toMatch(/posterior/);
  });

  it("rejeita quando falta restated_by", () => {
    const [v] = verifyClaims(
      [claim({ unit_ids: ["u026"], reason: "retake" })],
      ritmoish,
    );
    expect(v!.accepted).toBe(false);
    expect(v!.accepted === false && v!.failed).toMatch(/restated_by/);
  });

  it("rejeita quando restated_by também está sendo dropada", () => {
    const [v] = verifyClaims(
      [
        claim({ unit_ids: ["u026"], reason: "retake", restated_by: "u027" }),
        claim({ unit_ids: ["u027"], reason: "aside" }),
      ],
      ritmoish,
    );
    expect(v!.accepted).toBe(false);
    expect(v!.accepted === false && v!.failed).toMatch(/também está sendo dropada/);
  });

  it("rejeita quando o bloco dropado não é retomada de restated_by", () => {
    const [v] = verifyClaims(
      [claim({ unit_ids: ["u012"], reason: "retake", restated_by: "u028" })],
      ritmoish,
    );
    expect(v!.accepted).toBe(false);
    expect(v!.accepted === false && v!.failed).toMatch(/retomada|similar/);
  });
});

describe("verifyClaims — ar morto", () => {
  it("aceita unidade em trim_candidates com razão de dead air", () => {
    const [v] = verifyClaims(
      [claim({ unit_ids: ["u021"], reason: "dead_air", source: "mechanical" })],
      ritmoish,
    );
    expect(v!.accepted).toBe(true);
  });

  it("rejeita restates-only em trim_candidates (isso é retake, não ar morto)", () => {
    const [v] = verifyClaims(
      [claim({ unit_ids: ["u027"], reason: "dead_air" })],
      ritmoish,
    );
    expect(v!.accepted).toBe(false);
    expect(v!.accepted === false && v!.failed).toMatch(/ar morto|dead air|trim/i);
  });

  it("rejeita unidade fora de trim_candidates", () => {
    const [v] = verifyClaims(
      [claim({ unit_ids: ["u020"], reason: "dead_air" })],
      ritmoish,
    );
    expect(v!.accepted).toBe(false);
  });

  it("rejeita ar morto de mais de uma unidade", () => {
    const [v] = verifyClaims(
      [claim({ unit_ids: ["u021", "u022"], reason: "dead_air" })],
      ritmoish,
    );
    expect(v!.accepted).toBe(false);
    expect(v!.accepted === false && v!.failed).toMatch(/uma unidade|única unidade|só uma/i);
  });
});

describe("verifyClaims — fala com operador", () => {
  it("aceita unidade cujo texto casa no léxico", () => {
    const [v] = verifyClaims(
      [claim({ unit_ids: ["u001"], reason: "director_cue" })],
      index,
    );
    expect(v!.accepted).toBe(true);
  });

  it("rejeita unidade de conteúdo sem pista de operador", () => {
    const [v] = verifyClaims(
      [claim({ unit_ids: ["u007"], reason: "director_cue" })],
      index,
    );
    expect(v!.accepted).toBe(false);
    expect(v!.accepted === false && v!.failed).toMatch(/operador|léxico|cue/i);
  });
});

describe("acceptedDropIds", () => {
  it("junta só os ids das alegações aceitas", () => {
    const verdicts = verifyClaims(
      [
        claim({ unit_ids: ["u001", "u002"], reason: "preroll" }),
        claim({ unit_ids: ["u007"], reason: "aside" }), // rejeitada
      ],
      index,
    );
    expect([...acceptedDropIds(verdicts)].sort()).toEqual(["u001", "u002"]);
  });
});
