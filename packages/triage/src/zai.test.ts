import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isRetryable,
  parseDensityCandidates,
  parseInspectVerdict,
  parseStructureClaims,
  readChoice,
  ZaiTriageModel,
} from "./zai.ts";

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

describe("parseInspectVerdict", () => {
  it("lê decision e note", () => {
    const out = parseInspectVerdict(
      JSON.stringify({ unitId: "u020", decision: "drop", note: "olhou para o lado" }),
      "u020",
    );
    expect(out.decision).toBe("drop");
    expect(out.note).toMatch(/olhou/);
  });

  it("vira unsure se a decisão vier fora do enum", () => {
    expect(parseInspectVerdict('{"decision":"talvez"}', "u001").decision).toBe("unsure");
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

/** O adaptador lê o vídeo do disco antes de postar; um arquivo de 3 bytes basta. */
async function videoFalso(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "decupa-zai-"));
  const path = join(dir, "proxy.mp4");
  await writeFile(path, "abc");
  return path;
}

describe("isRetryable", () => {
  it("repete em 429 e em 5xx", () => {
    expect(isRetryable(new Error("HTTP 429 da Z.ai: rate limit"))).toBe(true);
    expect(isRetryable(new Error("HTTP 503 da Z.ai: upstream"))).toBe(true);
  });

  it("repete em timeout e em falha de rede", () => {
    expect(isRetryable(new Error("tempo esgotado depois de 120s esperando a Z.ai"))).toBe(true);
    expect(isRetryable(new Error("fetch failed"))).toBe(true);
  });

  it("não repete o que repetir não conserta", () => {
    // 400 é corpo malformado e 1113 é endpoint errado: tentar de novo só gasta
    // o dobro do tempo para chegar na mesma mensagem.
    expect(isRetryable(new Error("HTTP 400 da Z.ai: bad request"))).toBe(false);
    expect(isRetryable(new Error("a Z.ai recusou a chamada (1113): Insufficient balance"))).toBe(false);
  });
});

describe("auto-escalonar max_tokens", () => {
  it("dobra o orçamento e repete quando o thinking comeu tudo", async () => {
    // A resposta de verdade do modo de falha: HTTP 200, content vazio,
    // finish_reason "length". A segunda chamada tem de sair com max_tokens
    // dobrado e content de verdade.
    const bodies: Array<Record<string, any>> = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const sent = JSON.parse(String(init.body));
      bodies.push(sent);
      if (bodies.length === 1) {
        return new Response(JSON.stringify(body({ content: "", reasoning_content: "x".repeat(3000) }, "length")));
      }
      return new Response(JSON.stringify(body({ content: '{"claims":[]}' })));
    }) as typeof fetch;
    const model = new ZaiTriageModel({ apiKey: "k", fetchImpl });

    const dir = await mkdtemp(join(tmpdir(), "decupa-zai-"));
    const video = join(dir, "v.mp4");
    await writeFile(video, "x");
    const claims = await model.structure({ unitsBlock: "u001 texto", videoPath: video });

    expect(claims).toEqual([]);
    expect(bodies[1]!.max_tokens).toBe(32_000);
  });

  it("capa o orçamento no teto em vez de dobrar além dele", async () => {
    // Dobrar 50k daria 100k, acima do teto: a segunda chamada sai com 64k
    // exatos. E como 64k já é o teto, um segundo estouro sobe como erro em vez
    // de virar terceira chamada — dobrar para sempre seria loop de chamadas pagas.
    const bodies: Array<Record<string, any>> = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(body({ content: "", reasoning_content: "x".repeat(3000) }, "length")));
    }) as typeof fetch;
    const model = new ZaiTriageModel({ apiKey: "k", fetchImpl, maxTokens: 50_000, retries: 0 });

    const dir = await mkdtemp(join(tmpdir(), "decupa-zai-"));
    const video = join(dir, "v.mp4");
    await writeFile(video, "x");
    await expect(model.structure({ unitsBlock: "u001 texto", videoPath: video }))
      .rejects.toThrow(/max_tokens/);

    expect(bodies[0]!.max_tokens).toBe(50_000);
    expect(bodies[1]!.max_tokens).toBe(64_000);
    expect(bodies).toHaveLength(2);
  });

  it("não dobra para sempre: no teto, o erro de orçamento sobe", async () => {
    // Sem o stop no teto, um vídeo que o modelo não consegue responder viraria
    // loop infinito de chamadas pagas.
    const fetchImpl = (async () =>
      new Response(JSON.stringify(body({ content: "", reasoning_content: "x".repeat(3000) }, "length")))) as typeof fetch;
    const model = new ZaiTriageModel({ apiKey: "k", fetchImpl, maxTokens: 64_000, retries: 0 });

    const dir = await mkdtemp(join(tmpdir(), "decupa-zai-"));
    const video = join(dir, "v.mp4");
    await writeFile(video, "x");
    await expect(model.structure({ unitsBlock: "u001 texto", videoPath: video }))
      .rejects.toThrow(/max_tokens/);
  });
});

describe("medidor de uso", () => {
  it("acumula usage e raciocínio entre chamadas", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      ...body({ content: '{"claims":[]}', reasoning_content: "think" }),
      usage: { prompt_tokens: 1000, completion_tokens: 40 },
    }))) as typeof fetch;
    const model = new ZaiTriageModel({ apiKey: "k", fetchImpl });

    const dir = await mkdtemp(join(tmpdir(), "decupa-zai-"));
    const video = join(dir, "v.mp4");
    await writeFile(video, "x");
    await model.structure({ unitsBlock: "u001 texto", videoPath: video });
    await model.density({ unitsBlock: "u001 texto", videoPath: video, budgetSeconds: 10 });

    expect(model.usage()).toEqual({
      calls: 2, promptTokens: 2000, completionTokens: 80, reasoningChars: 10,
    });
  });
});

describe("ZaiTriageModel — rede", () => {
  it("tenta de novo depois de um 503 e devolve a segunda resposta", async () => {
    let chamadas = 0;
    const fetchImpl = (async () => {
      chamadas += 1;
      if (chamadas === 1) return new Response("{}", { status: 503 });
      return new Response(JSON.stringify(body({ content: '{"claims":[]}' })), { status: 200 });
    }) as unknown as typeof fetch;
    const model = new ZaiTriageModel({ apiKey: "k", fetchImpl });
    await expect(model.structure({ unitsBlock: "u001 oi", videoPath: await videoFalso() }))
      .resolves.toEqual([]);
    expect(chamadas).toBe(2);
  });

  it("estoura dizendo que o tempo esgotou, em vez de esperar para sempre", async () => {
    // Sem teto, uma conexão pendurada trava a triagem inteira — e no CLI não
    // existe o cancel que o app tem.
    const fetchImpl = ((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      })) as unknown as typeof fetch;
    const model = new ZaiTriageModel({ apiKey: "k", fetchImpl, timeoutMs: 20, retries: 0 });
    await expect(model.structure({ unitsBlock: "u001 oi", videoPath: await videoFalso() }))
      .rejects.toThrow(/tempo esgotado/);
  });
});

