import { describe, expect, it } from "vitest";
import { parseDensityCandidates, parseStructureClaims, readChoice } from "./zai.ts";

/** Forma de resposta do Chat Completions da Z.ai. */
const body = (message: Record<string, unknown>, finish = "stop") => ({
  choices: [{ finish_reason: finish, index: 0, message }],
});

describe("readChoice", () => {
  it("devolve o content, ignorando o reasoning", () => {
    // O modelo pensa sempre; `thinking` não pode ser desligado neste modelo.
    // Só `content` é resposta — `reasoning_content` é rascunho.
    const raw = body({ content: '{"claims":[]}', reasoning_content: "pensando alto..." });
    expect(readChoice(raw)).toBe('{"claims":[]}');
  });

  it("estoura quando o orçamento acabou dentro do raciocínio", () => {
    // O caso real medido em 2026-09-04: HTTP 200, finish_reason "length",
    // content vazio, 3000 chars de raciocínio. Sem esta guarda o adaptador
    // devolveria zero alegações e a triagem manteria tudo — parecendo que o
    // modelo analisou e não achou nada.
    const raw = body({ content: "", reasoning_content: "x".repeat(3000) }, "length");
    expect(() => readChoice(raw)).toThrow(/max_tokens/);
  });

  it("estoura com content vazio mesmo quando terminou normalmente", () => {
    expect(() => readChoice(body({ content: "" }))).toThrow(/vazia/);
  });

  it("estoura quando a resposta traz erro no lugar de choices", () => {
    const raw = { error: { code: "1113", message: "Insufficient balance" } };
    expect(() => readChoice(raw)).toThrow(/1113|Insufficient balance/);
  });

  it("estoura quando não há choices", () => {
    expect(() => readChoice({})).toThrow(/choices/);
  });
});

describe("parseStructureClaims", () => {
  const claim = {
    unit_ids: ["u001", "u002"],
    reason: "preroll",
    restated_by: null,
    note: "falando com o operador",
  };

  it("lê a lista de alegações", () => {
    const out = parseStructureClaims(JSON.stringify({ claims: [claim] }));
    expect(out).toHaveLength(1);
    expect(out[0]!.reason).toBe("preroll");
  });

  it("tolera JSON embrulhado em cerca de markdown", () => {
    // O raciocínio observado citava instrução de sistema pedindo bloco de
    // código; sem schema para impor, a cerca pode aparecer.
    const fenced = "```json\n" + JSON.stringify({ claims: [claim] }) + "\n```";
    expect(parseStructureClaims(fenced)).toHaveLength(1);
  });

  it("normaliza restated_by ausente para null", () => {
    const semCampo = { unit_ids: ["u001"], reason: "preroll", note: "" };
    expect(parseStructureClaims(JSON.stringify({ claims: [semCampo] }))[0]!.restated_by).toBeNull();
  });

  it("preserva reason desconhecida em vez de descartar", () => {
    // `json_object` não é `json_schema`: nada obriga o enum. Deixar passar faz
    // a alegação percorrer a verificação normal e aparecer como rejeitada no
    // relatório; filtrar aqui a apagaria silenciosamente.
    const inventada = { unit_ids: ["u001"], reason: "porque_sim", note: "" };
    const out = parseStructureClaims(JSON.stringify({ claims: [inventada] }));
    expect(out).toHaveLength(1);
    expect(out[0]!.reason).toBe("porque_sim");
  });

  it("devolve lista vazia quando não há a chave claims", () => {
    expect(parseStructureClaims('{"outra":[]}')).toEqual([]);
  });

  it("estoura em JSON malformado, com um pedaço do texto no erro", () => {
    expect(() => parseStructureClaims("desculpe, não consegui")).toThrow(/desculpe/);
  });

  it("descarta entrada sem unit_ids utilizável", () => {
    const ruim = { reason: "preroll", note: "sem ids" };
    expect(parseStructureClaims(JSON.stringify({ claims: [ruim] }))).toEqual([]);
  });
});

describe("parseDensityCandidates", () => {
  it("lê os candidatos", () => {
    const raw = JSON.stringify({ candidates: [{ unit_ids: ["u007"], note: "repete", rank: 1 }] });
    expect(parseDensityCandidates(raw)[0]!.rank).toBe(1);
  });

  it("converte rank que veio como string", () => {
    const raw = JSON.stringify({ candidates: [{ unit_ids: ["u007"], note: "", rank: "2" }] });
    expect(parseDensityCandidates(raw)[0]!.rank).toBe(2);
  });

  it("empurra candidato sem rank para o fim em vez de virar NaN", () => {
    const raw = JSON.stringify({ candidates: [{ unit_ids: ["u007"], note: "" }] });
    expect(parseDensityCandidates(raw)[0]!.rank).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("devolve lista vazia sem a chave candidates", () => {
    expect(parseDensityCandidates("{}")).toEqual([]);
  });
});
