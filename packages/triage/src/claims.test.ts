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
  ({ restated_by: null, note: "", ...c });

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
});

describe("verifyClaims — categoria inventada", () => {
  it("rejeita reason fora do enum com uma frase que diz qual foi", () => {
    // Provedor sem `json_schema` (Z.ai usa `json_object`) não obriga o enum.
    // Sem um `default` no switch isto virava rejeição com `failed: undefined`,
    // e o relatório imprimia "falhou: undefined".
    const invalida = { unit_ids: ["u001"], reason: "porque_sim", restated_by: null, note: "" };
    const [v] = verifyClaims([invalida as unknown as StructureClaim], index);
    expect(v!.accepted).toBe(false);
    expect(v!.accepted === false && v!.failed).toMatch(/porque_sim/);
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
