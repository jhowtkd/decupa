import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_VIDEO_PAYLOAD_BYTES, parseSpeechIndex, ZaiTriageModel, type StructureRequest } from "@decupa/triage";
import { runTriage } from "./triage.ts";
import { defaultCutWindow, planTriageWindows, prepareTriageWindows } from "./triage-windows.ts";

beforeEach(() => {
  vi.stubEnv("ZAI_API_KEY", "test");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function unidade(id: string, index: number, start: number, end: number) {
  return { id, index, start, end, duration: end - start, text: id };
}

async function videoGrande() {
  const dir = await mkdtemp(join(tmpdir(), "triage-janela-"));
  const indexPath = join(dir, "speech_index.json");
  await writeFile(indexPath, JSON.stringify({
    source_duration: 800,
    units: [unidade("u001", 0, 0, 10), unidade("u002", 1, 700, 710)],
  }), "utf8");
  const videoPath = join(dir, "v.mp4");
  // 4 MB viram mais de 5 MB em base64: a triagem deixa de ser uma chamada só.
  await writeFile(videoPath, Buffer.alloc(4 * 1024 * 1024));
  return { dir, indexPath, videoPath };
}

const recorta: NonNullable<Parameters<typeof runTriage>[0]["cutWindow"]> = async (_src, dst) => {
  await writeFile(dst, "janela");
};

describe("triagem de vídeo longo", () => {
  it("vídeo acima do teto chama structure uma vez por janela, com tempos rebaseados", async () => {
    const { dir, indexPath, videoPath } = await videoGrande();
    const chamadas: StructureRequest[] = [];
    await runTriage({
      indexPath,
      videoPath,
      outDir: dir,
      routeMode: "off",
      cutWindow: recorta,
      model: {
        async structure(req) {
          chamadas.push(req);
          return [];
        },
        async density() { return []; },
        async inspect(req) { return { unitId: req.unitId, decision: "unsure", note: "" }; },
      },
    });
    expect(chamadas).toHaveLength(2);
    // O silêncio de 11 a 699 s não é enviado: a janela vai da unidade até a folga.
    expect(chamadas[0]!.videoPath).toContain("0.0-11.0");
    expect(chamadas[0]!.unitsBlock).toContain("u001 | 0.0s +10.0s");
    expect(chamadas[0]!.unitsBlock).not.toContain("u002");
    expect(chamadas[1]!.videoPath).toContain("699.0-711.0");
    expect(chamadas[1]!.unitsBlock).toContain("Trecho 2 de 2");
    // Tempos contados do início da janela (699 s): a unidade começa 1 s depois.
    expect(chamadas[1]!.unitsBlock).toContain("u002 | 1.0s +10.0s");
    expect(chamadas[1]!.unitsBlock).not.toContain("u001");
  });

  it("vídeo pequeno continua numa chamada só, com o arquivo original", async () => {
    const dir = await mkdtemp(join(tmpdir(), "triage-curto-"));
    const indexPath = join(dir, "speech_index.json");
    await writeFile(indexPath, JSON.stringify({
      source_duration: 20,
      units: [unidade("u001", 0, 0, 10)],
    }), "utf8");
    const videoPath = join(dir, "v.mp4");
    await writeFile(videoPath, "curto");
    const chamadas: StructureRequest[] = [];
    await runTriage({
      indexPath,
      videoPath,
      outDir: dir,
      routeMode: "off",
      model: {
        async structure(req) {
          chamadas.push(req);
          return [];
        },
        async density() { return []; },
        async inspect(req) { return { unitId: req.unitId, decision: "unsure", note: "" }; },
      },
    });
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.videoPath).toBe(videoPath);
  });

  it("falha na segunda janela não cobra de novo a primeira", async () => {
    const { dir, indexPath, videoPath } = await videoGrande();
    const vistas: string[] = [];
    const model = {
      async structure(req: StructureRequest) {
        vistas.push(req.videoPath);
        if (req.videoPath.includes("699.0-711.0")) throw new Error("janela 2");
        return [];
      },
      async density() { return []; },
      async inspect(req: { unitId: string }) {
        return { unitId: req.unitId, decision: "unsure" as const, note: "" };
      },
    };
    const opts = { indexPath, videoPath, outDir: dir, routeMode: "off" as const, cutWindow: recorta, model };
    await expect(runTriage(opts)).rejects.toThrow(/janela 2/);
    expect(vistas).toHaveLength(2);
    vistas.length = 0;
    await expect(runTriage(opts)).rejects.toThrow(/janela 2/);
    expect(vistas).toEqual([expect.stringContaining("699.0-711.0")]);
  });

  it("resposta {} não fica em cache e a próxima execução chama o modelo de novo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "triage-vazio-"));
    const indexPath = join(dir, "speech_index.json");
    await writeFile(indexPath, JSON.stringify({
      source_duration: 10,
      units: [unidade("u001", 0, 0, 4)],
    }), "utf8");
    const videoPath = join(dir, "v.mp4");
    await writeFile(videoPath, "abc");
    let fetches = 0;
    const fetchImpl = (async () => {
      fetches += 1;
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "{}" } }],
      }));
    }) as typeof fetch;
    const model = new ZaiTriageModel({ apiKey: "k", fetchImpl, retries: 0 });
    const opts = { indexPath, videoPath, outDir: dir, routeMode: "off" as const, model };
    const rodar = () => runTriage(opts).then(() => "ok", (error: Error) => error.message);
    const primeira = await rodar();
    const segunda = await rodar();
    expect(fetches, `${primeira} | ${segunda}`).toBe(2);
    expect(primeira).toMatch(/claims/);
    expect(segunda).toMatch(/claims/);
  });
});

// ---- Janelas só cobrem as unidades, não o silêncio (P1 da revisão) ----

const UM_MB = 1024 * 1024;
const VIDEO_BYTES = 20 * UM_MB;
const DURACAO = 3600;
const BYTES_POR_SEGUNDO = VIDEO_BYTES / DURACAO;
const TETO_BRUTO = MAX_VIDEO_PAYLOAD_BYTES * 3 / 4;
/** Folga tolerada em volta das unidades; não depende do valor exato do pad. */
const TOLERANCIA = 2;

/** Unidades de ~10 s espaçadas de 15 s dentro de [de, ate]. */
function fala(de: number, ate: number) {
  const units = [];
  for (let t = de, i = 0; t + 10 <= ate; t += 15, i += 1) units.push(unidade(`u${de}-${i}`, i, t, t + 10));
  return units;
}

function indice1h(units: ReturnType<typeof fala>) {
  return parseSpeechIndex({ source_duration: DURACAO, units });
}

const cenarios = {
  "silêncio no fim": fala(0, 2700),
  "silêncio no começo": fala(1200, 3600),
  "silêncio no meio": [...fala(0, 900), ...fala(2100, 3600)],
};

describe("planTriageWindows: janelas não cobrem o silêncio", () => {
  it("silêncio no fim: nenhuma janela termina muito depois da última unidade", () => {
    // Hoje a última janela vai até `duration` e leva os 15 min calados junto.
    const units = cenarios["silêncio no fim"];
    const ultimoFim = Math.max(...units.map((u) => u.end));
    const janelas = planTriageWindows(indice1h(units), VIDEO_BYTES)!;
    expect(janelas).not.toBeNull();
    for (const w of janelas) expect(w.end).toBeLessThanOrEqual(ultimoFim + TOLERANCIA);
  });

  it("silêncio no começo: a primeira janela começa perto da primeira unidade, não em 0", () => {
    const janelas = planTriageWindows(indice1h(cenarios["silêncio no começo"]), VIDEO_BYTES)!;
    expect(janelas[0]!.start).toBeGreaterThanOrEqual(1200 - TOLERANCIA);
    expect(janelas[0]!.start).toBeLessThanOrEqual(1200);
  });

  it("silêncio no meio: nenhuma janela cobre o intervalo calado", () => {
    const janelas = planTriageWindows(indice1h(cenarios["silêncio no meio"]), VIDEO_BYTES)!;
    expect(janelas.filter((w) => w.start < 1000 && w.end > 2000)).toEqual([]);
  });

  it.each(Object.entries(cenarios))("%s: toda janela cabe no teto em bytes brutos", (_nome, units) => {
    // O encode do trecho é proporcional à duração; acima disso o zai recusa.
    const janelas = planTriageWindows(indice1h(units), VIDEO_BYTES)!;
    for (const w of janelas) expect((w.end - w.start) * BYTES_POR_SEGUNDO).toBeLessThanOrEqual(TETO_BRUTO);
  });

  it("controle: fala contínua cobre todas as unidades, cada uma em uma janela só", () => {
    const units = fala(0, 3600);
    const janelas = planTriageWindows(indice1h(units), VIDEO_BYTES)!;
    for (const u of units) {
      const donas = janelas.filter((w) => w.unitIds.includes(u.id));
      expect(donas, u.id).toHaveLength(1);
      expect(donas[0]!.start).toBeLessThanOrEqual(u.start);
      expect(donas[0]!.end).toBeGreaterThanOrEqual(u.end);
    }
  });
});

describe("triagem ponta a ponta com silêncio longo", () => {
  const RESPOSTA = { choices: [{ finish_reason: "stop", message: { content: '{"claims":[]}' } }] };

  async function gravacao(units: ReturnType<typeof fala>) {
    const dir = await mkdtemp(join(tmpdir(), "triage-silencio-"));
    const indexPath = join(dir, "speech_index.json");
    await writeFile(indexPath, JSON.stringify({ source_duration: DURACAO, units }), "utf8");
    // Nome do proxy do app: o `ensureLightVideo` não re-transcodifica.
    const videoPath = join(dir, "triage-proxy.mp4");
    await writeFile(videoPath, Buffer.alloc(VIDEO_BYTES));
    return { dir, indexPath, videoPath };
  }

  /** Grava bytes proporcionais à duração pedida, como o encode real. */
  const recortaProporcional: NonNullable<Parameters<typeof runTriage>[0]["cutWindow"]> =
    async (_src, dst, _inicio, duracao) => {
      await writeFile(dst, Buffer.alloc(Math.round(duracao * BYTES_POR_SEGUNDO)));
    };

  function stubFetch() {
    const fetchFake = vi.fn(async () => new Response(JSON.stringify(RESPOSTA)));
    vi.stubGlobal("fetch", fetchFake);
    return fetchFake;
  }

  it.each([
    ["gravação calada de 2700 a 3600 s", fala(0, 2700)],
    ["20 min de silêncio no início", fala(1200, 3600)],
  ])("%s termina sem estourar o teto", async (_nome, units) => {
    // Hoje lança "o vídeo da triagem virou … MB em base64, acima do teto".
    const { dir, indexPath, videoPath } = await gravacao(units);
    stubFetch();
    await expect(runTriage({
      indexPath, videoPath, outDir: dir, routeMode: "off", cutWindow: recortaProporcional,
    })).resolves.toBeDefined();
  });

  it("recorta todas as janelas antes de pagar a primeira chamada", async () => {
    // O trecho da 2ª janela sai grande demais, e repartir não resolve (o
    // excesso persiste em todo recorte que começa ali): a triagem tem de
    // recusar sem gastar nada, depois de recortar todas as outras.
    const { dir, indexPath, videoPath } = await gravacao(fala(0, 3600));
    const fetchFake = stubFetch();
    let corte = 0;
    let inicioGrande: number | undefined;
    const recortaGrande: typeof recortaProporcional = async (_s, dst, inicio, duracao) => {
      corte += 1;
      if (corte === 2) inicioGrande = inicio;
      const bytes = inicio === inicioGrande ? 6 * UM_MB : Math.round(duracao * BYTES_POR_SEGUNDO);
      await writeFile(dst, Buffer.alloc(bytes));
    };
    const erro = await runTriage({
      indexPath, videoPath, outDir: dir, routeMode: "off", cutWindow: recortaGrande,
    }).then(() => null, (e: Error) => e);
    expect(erro?.message).toContain("acima do teto de 5 MB");
    expect(erro?.message).toContain("nenhuma chamada foi feita");
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it("uma unidade única maior que o teto recusa com mensagem clara e sem chamada paga", async () => {
    // Uma fala contínua de 40 min não cabe em janela nenhuma, e as janelas
    // vizinhas (que cabem) não podem ter sido cobradas antes da recusa.
    const units = [
      unidade("u001", 0, 0, 10),
      unidade("u002", 1, 20, 2420),
      unidade("u003", 2, 3500, 3510),
    ];
    const { dir, indexPath, videoPath } = await gravacao(units);
    const fetchFake = stubFetch();
    const erro = await runTriage({
      indexPath, videoPath, outDir: dir, routeMode: "off", cutWindow: recortaProporcional,
    }).then(() => null, (e: Error) => e);
    expect(erro?.message).toContain("acima do teto de 5 MB");
    expect(erro?.message).toContain("nenhuma chamada foi feita");
    // Nomeia a janela problemática e o que fazer, em vez de um erro genérico do provedor.
    expect(erro?.message).toMatch(/janela 2 de 3/);
    expect(erro?.message).toMatch(/unidade de fala muito longa/);
    expect(fetchFake).not.toHaveBeenCalled();
  });
});

describe("janela acima do teto por bitrate variável", () => {
  const RESPOSTA = { choices: [{ finish_reason: "stop", message: { content: '{"claims":[]}' } }] };
  /** Taxa do trecho denso: 2× a do resto; o total do vídeo continua 20 MiB. */
  const R1 = VIDEO_BYTES / 5400;

  async function gravacao(units: ReturnType<typeof fala>) {
    const dir = await mkdtemp(join(tmpdir(), "triage-bitrate-"));
    const indexPath = join(dir, "speech_index.json");
    await writeFile(indexPath, JSON.stringify({ source_duration: DURACAO, units }), "utf8");
    const videoPath = join(dir, "triage-proxy.mp4");
    await writeFile(videoPath, Buffer.alloc(VIDEO_BYTES));
    return { dir, indexPath, videoPath };
  }

  /** ∫ taxa(t) dt em [de, ate]: R1 até 1800 s e 2·R1 depois. */
  function bytesEntre(de: number, ate: number): number {
    const baixo = Math.max(0, Math.min(ate, 1800) - Math.min(de, 1800));
    const alto = Math.max(0, Math.max(ate, 1800) - Math.max(de, 1800));
    return Math.round(baixo * R1 + alto * 2 * R1);
  }

  function preparaCenario(eventos: string[], cortes: number[]) {
    const recorta: NonNullable<Parameters<typeof runTriage>[0]["cutWindow"]> =
      async (_src, dst, inicio, duracao) => {
        eventos.push("corte");
        cortes.push(inicio);
        await writeFile(dst, Buffer.alloc(bytesEntre(inicio, inicio + duracao)));
      };
    const fetchFake = vi.fn(async (_url: unknown, _init?: unknown) => {
      eventos.push("fetch");
      return new Response(JSON.stringify(RESPOSTA));
    });
    vi.stubGlobal("fetch", fetchFake);
    return { recorta, fetchFake };
  }

  async function rodaBitrateDobrado() {
    const { dir, indexPath, videoPath } = await gravacao(fala(0, 3600));
    const eventos: string[] = [];
    const cortes: number[] = [];
    const { recorta, fetchFake } = preparaCenario(eventos, cortes);
    const model = new ZaiTriageModel({ apiKey: "k", retries: 0 });
    await runTriage({ indexPath, videoPath, outDir: dir, routeMode: "off", cutWindow: recorta, model });
    return { eventos, cortes, fetchFake };
  }

  it("bitrate 2× na segunda metade: replaneja o trecho e paga só depois de cortar tudo", async () => {
    // Hoje recusa antes de qualquer chamada com "unidade de fala muito longa",
    // conselho errado para uma janela de várias unidades.
    const { eventos, fetchFake } = await rodaBitrateDobrado();
    const corpos = fetchFake.mock.calls.map((c) => String((c[1] as { body: string }).body));
    expect(corpos.length).toBeGreaterThan(0);
    // Uma chamada por janela final: todas dizem "Trecho k de N" com o mesmo N.
    const totais = corpos.map((b) => Number(/Trecho \d+ de (\d+)/.exec(b)?.[1]));
    expect(totais.every((n) => n === corpos.length)).toBe(true);
    for (const corpo of corpos) {
      const url = (JSON.parse(corpo) as { messages: { content: unknown }[] }).messages
        .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .map((c) => (c as { video_url?: { url: string } }).video_url?.url)
        .find((u): u is string => typeof u === "string")!;
      expect(url.length).toBeLessThanOrEqual(MAX_VIDEO_PAYLOAD_BYTES);
    }
    expect(eventos.lastIndexOf("corte")).toBeLessThan(eventos.indexOf("fetch"));
  }, 30_000);

  it("replaneja só o trecho que estourou: a primeira metade é recortada uma vez", async () => {
    const { cortes } = await rodaBitrateDobrado();
    const contagem = new Map<number, number>();
    for (const inicio of cortes) contagem.set(inicio, (contagem.get(inicio) ?? 0) + 1);
    const plano = planTriageWindows(indice1h(fala(0, 3600)), VIDEO_BYTES)!;
    const primeiraMetade = plano.filter((w) => w.end <= 1800);
    const segundaMetade = plano.filter((w) => w.start >= 1800);
    expect(primeiraMetade.length).toBeGreaterThan(0);
    for (const w of primeiraMetade) expect(contagem.get(w.start), `janela em ${w.start}s`).toBe(1);
    expect(segundaMetade.some((w) => (contagem.get(w.start) ?? 0) >= 2)).toBe(true);
  }, 30_000);

  it("tentativas esgotadas: diz 3 tentativas e o tamanho, sem culpar a unidade longa", async () => {
    // O tamanho não cai com a duração (6 MB fixos acima de 30 s): nem
    // replanejar resolve, e a causa não é uma unidade de fala longa.
    const { dir, indexPath, videoPath } = await gravacao(fala(0, 3600));
    const cortes: number[] = [];
    const recorta: NonNullable<Parameters<typeof runTriage>[0]["cutWindow"]> =
      async (_src, dst, inicio, duracao) => {
        cortes.push(inicio);
        await writeFile(dst, Buffer.alloc(duracao > 30 ? 6 * UM_MB : 100));
      };
    const fetchFake = vi.fn(async () => new Response(JSON.stringify(RESPOSTA)));
    vi.stubGlobal("fetch", fetchFake);
    const model = new ZaiTriageModel({ apiKey: "k", retries: 0 });
    const erro = await runTriage({
      indexPath, videoPath, outDir: dir, routeMode: "off", cutWindow: recorta, model,
    }).then(() => null, (e: Error) => e);
    expect(erro, "runTriage devia rejeitar").not.toBeNull();
    expect(erro!.message).toContain("depois de 3 tentativas");
    expect(erro!.message).toContain("nenhuma chamada foi feita");
    expect(erro!.message).not.toContain("unidade de fala muito longa");
    expect(erro!.message).toMatch(/\d+(\.\d+)? MB/);
    expect(fetchFake).not.toHaveBeenCalled();
    // Corte inicial + 3 tentativas, no máximo, por início de trecho.
    const contagem = new Map<number, number>();
    for (const inicio of cortes) contagem.set(inicio, (contagem.get(inicio) ?? 0) + 1);
    for (const [inicio, n] of contagem) expect(n, `trecho em ${inicio}s`).toBeLessThanOrEqual(4);
  }, 30_000);
});

describe("cancelamento no recorte de janela", () => {
  it("defaultCutWindow com signal já abortado rejeita com CancelledError", async () => {
    const dir = await mkdtemp(join(tmpdir(), "triage-cancela-"));
    const ac = new AbortController();
    ac.abort();
    await expect(defaultCutWindow("/nao/existe.mp4", join(dir, "j.mp4"), 0, 1, ac.signal))
      .rejects.toMatchObject({ name: "CancelledError" });
  });

  it("prepareTriageWindows: erro genérico depois do abort vira CancelledError", async () => {
    const dir = await mkdtemp(join(tmpdir(), "triage-cancela-prep-"));
    const videoPath = join(dir, "v.mp4");
    await writeFile(videoPath, Buffer.alloc(VIDEO_BYTES));
    const ac = new AbortController();
    const cutWindow = async () => {
      ac.abort();
      throw new Error("ffmpeg morreu");
    };
    await expect(prepareTriageWindows({
      index: indice1h(fala(0, 3600)), videoPath, videoSha: "a".repeat(64), outDir: dir, cutWindow, signal: ac.signal,
    })).rejects.toMatchObject({ name: "CancelledError" });
  });
});
