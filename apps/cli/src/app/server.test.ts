import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeExecutor, SpawnExecutor } from "./pipeline.ts";
import { startApp } from "./server.ts";

let stop: (() => Promise<void>) | null = null;
afterEach(async () => { await stop?.(); stop = null; });

async function boot() {
  const dir = await mkdtemp(join(tmpdir(), "decupa-app-"));
  const app = await startApp({ input: join(dir, "v.mp4"), port: 0, autoStart: false });
  stop = app.close;
  return { app, base: `http://127.0.0.1:${app.port}` };
}

/** Sobe com índice e plano já no disco, para exercitar o caminho de sucesso
 *  sem rodar WhisperX nem o motor. */
async function bootComPlano(
  exec: FakeExecutor = new FakeExecutor(),
  // A triagem agora é biblioteca: sem injeção ela exigiria provider e chave
  // de verdade, então quem testa a borda injeta o resultado dela.
  triageFn?: (opts: {
    indexPath: string;
    videoPath: string;
    outDir: string;
    provider?: string;
  }) => Promise<{ keepList: string }>,
) {
  const dir = await mkdtemp(join(tmpdir(), "decupa-app-"));
  await mkdir(join(dir, "out"), { recursive: true });
  const units = ["u001", "u002", "u003"].map((id, i) => ({ id, index: i, text: `t${i}` }));
  await writeFile(join(dir, "out", "speech_index.json"), JSON.stringify({ units }), "utf8");
  await writeFile(join(dir, "out", "condense_plan.json"), JSON.stringify({
    source_duration: 30, output_duration: 20,
    clips: [{ unit_ids: ["u002", "u003"], start: 10, end: 30 }],
    joins: [],
  }), "utf8");
  const app = await startApp({
    input: join(dir, "v.mp4"), port: 0, autoStart: false, executor: exec, workDir: dir,
    triageFn,
  });
  stop = app.close;
  return { app, exec, base: `http://127.0.0.1:${app.port}`, dir };
}

describe("startApp", () => {
  it("sobe numa porta e serve a página em /", async () => {
    const { base, app } = await boot();
    const res = await fetch(base);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain("<!doctype html>");
    // O token some; no lugar entra o id como literal JSON, que o script lê
    // em `... || window.__JOB__` — sem isso a página polla `/jobs/undefined`.
    expect(html).toContain(JSON.stringify(app.jobId));
    expect(html).not.toContain("window.__JOB__");
    expect(html).toContain("decupa · limpar fala");
  });

  it("serve o keeplist.js testado, não uma cópia", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/keeplist.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    const body = await res.text();
    expect(body).toContain("export function keepListFrom");
    expect(body).toContain("export function expandKeepList");
  });

  it("escuta só em 127.0.0.1", async () => {
    // O app processa material de cliente; não se expõe à rede.
    const { app } = await boot();
    expect(app.address).toBe("127.0.0.1");
  });

  it("404 com corpo curto para rota que não existe", async () => {
    const { base } = await boot();
    expect((await fetch(`${base}/nada`)).status).toBe(404);
  });

  it("devolve 404 para job inexistente", async () => {
    const { base } = await boot();
    expect((await fetch(`${base}/jobs/inexistente`)).status).toBe(404);
  });

  it("recusa keep-list que não é string", async () => {
    const { base, app } = await boot();
    const res = await fetch(`${base}/jobs/${app.jobId}/keep`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keepList: ["u001", "u002"] }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/string/);
  });

  it("cancelar leva o job a `cancelled`", async () => {
    const { base, app } = await boot();
    await fetch(`${base}/jobs/${app.jobId}/cancel`, { method: "POST" });
    const body = await (await fetch(`${base}/jobs/${app.jobId}`)).json() as { stage: string };
    expect(body.stage).toBe("cancelled");
  });

  it("keep devolve o review novo — o caminho que a tela usa a cada clique", async () => {
    // Sem este teste, as rotas provadas são só as de erro; o happy path que a
    // página exercita o tempo todo ficaria sem cobertura nenhuma.
    const { base, app } = await bootComPlano();
    const res = await fetch(`${base}/jobs/${app.jobId}/keep`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keepList: "u002-u003" }),
    });
    const body = await res.json() as { review: { units: { id: string; kept: boolean }[] } };
    expect(res.status).toBe(200);
    expect(body.review.units.find((u) => u.id === "u001")!.kept).toBe(false);
    expect(body.review.units.find((u) => u.id === "u002")!.kept).toBe(true);
  });

  it("dois keeps seguidos não rodam dois planos ao mesmo tempo", async () => {
    // condense_plan grava sempre no mesmo arquivo; dois processos em paralelo
    // fazem o último a gravar vencer, e o review pode voltar do keep-list
    // antigo — o aviso mentiroso que o debounce existia para evitar.
    // 25 ms por chamada: um plano de verdade custa ~174 ms, e um fake
    // instantâneo termina antes do segundo pedido chegar — nenhuma
    // concorrência seria observável, e o teste passaria por acidente.
    const { base, app, exec } = await bootComPlano(new FakeExecutor({}, 25));
    const post = (keepList: string) => fetch(`${base}/jobs/${app.jobId}/keep`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keepList }),
    });
    const [first, second] = await Promise.all([post("u001-u002"), post("u002-u003")]);

    // A invariante é serialização, não coalescing: dois planos podem rodar,
    // desde que nunca ao mesmo tempo. Exigir "exatamente um" obrigaria a
    // produção a dormir antes de cada plano só para o segundo pedido chegar
    // a tempo — latência real paga por uma otimização que o debounce de
    // 250 ms da página já entrega.
    expect(exec.maxConcurrent).toBe(1);

    // E o último pedido é o que fica: um plano obsoleto não pode ser o
    // vencedor, senão o aviso de junção descreveria um corte que já mudou.
    const planos = exec.calls.filter((c) => c.args.includes("plan"));
    expect(planos.at(-1)!.args).toContain("u002-u003");
    expect((await first!.json() as { review?: unknown }).review).toBeDefined();
    expect((await second!.json() as { review?: unknown }).review).toBeDefined();
  });

  it("keep que falha no motor deixa o job em error, não em planning", async () => {
    // GET /jobs/:id é o que a página polla. Sem store.fail, o POST devolve
    // 500 com a saída do motor mas o estágio fica em planning para sempre.
    const { base, app } = await bootComPlano(new FakeExecutor({
      code: 1,
      stderr: "condense.py: unidade u099 não existe",
    }));
    const res = await fetch(`${base}/jobs/${app.jobId}/keep`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keepList: "u002-u003" }),
    });
    expect(res.status).toBe(500);
    const body = await (await fetch(`${base}/jobs/${app.jobId}`)).json() as {
      stage: string; error?: string;
    };
    expect(body.stage).toBe("error");
    expect(body.error).toMatch(/unidade u099 não existe/);
  });

  it("keep que falha depois de um review restaura ready e preserva o review", async () => {
    // error é irreversível: fail depois do primeiro corte apagaria o poll.
    const exec = new FakeExecutor();
    let plans = 0;
    const original = exec.run.bind(exec);
    exec.run = async (call) => {
      if (call.args.includes("plan")) {
        plans += 1;
        if (plans > 1) {
          return { code: 1, stdout: "", stderr: "condense.py: unidade u099 não existe" };
        }
      }
      return original(call);
    };
    const { base, app } = await bootComPlano(exec);
    const first = await fetch(`${base}/jobs/${app.jobId}/keep`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keepList: "u002-u003" }),
    });
    expect(first.status).toBe(200);
    const failed = await fetch(`${base}/jobs/${app.jobId}/keep`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keepList: "u001-u002" }),
    });
    expect(failed.status).toBe(500);
    const body = await (await fetch(`${base}/jobs/${app.jobId}`)).json() as {
      stage: string; review?: unknown;
    };
    expect(body.stage).toBe("ready");
    expect(body.review).toBeDefined();
  });

  it("motivos da triagem vêm do Aplicado, não do Rejeitado", async () => {
    const { base, app, dir } = await bootComPlano(new FakeExecutor(), async () => ({
      keepList: "u002-u003",
    }));
    await writeFile(join(dir, "out", "triage.md"), [
      "# Triagem",
      "",
      "### Aplicado",
      "",
      "- **u001** — `preroll` — falando com o operador",
      "",
      "### Rejeitado (alegação não conferiu com o índice)",
      "",
      "- **u099** — `preroll` — chute inventado",
      "  - falhou: não confere",
      "",
      "## Passe 2 — densidade",
      "",
      "- **u005** (rank 1) — pausa longa",
      "- ~~u006~~ pulado: estoura orçamento",
      "",
    ].join("\n"), "utf8");
    const res = await fetch(`${base}/jobs/${app.jobId}/triage`, { method: "POST" });
    const body = await res.json() as { keepList: string; motivos: string[] };
    expect(res.status).toBe(200);
    expect(body.keepList).toBe("u002-u003");
    expect(body.motivos.some((m) => m.includes("falando com o operador"))).toBe(true);
    expect(body.motivos.join("\n")).not.toMatch(/u099/);
    expect(body.motivos.some((m) => m.includes("u005") && m.includes("rank"))).toBe(true);
    expect(body.motivos.join("\n")).not.toMatch(/u006/);
  });

  it("prefere drop e reviewFlags do triage.json ao parse do markdown", async () => {
    const { base, app, dir } = await bootComPlano(new FakeExecutor(), async () => ({
      keepList: "u002-u003",
    }));
    await writeFile(join(dir, "out", "triage.json"), JSON.stringify({
      keepList: "u002-u003",
      drop: [{ unit_ids: ["u001"], reason: "preroll", note: "pré-rolo", source: "mechanical", restated_by: null }],
      reviewFlags: [{ unitId: "u003", code: "looks_away", source: "visual", message: "sem substituto" }],
    }), "utf8");
    const res = await fetch(`${base}/jobs/${app.jobId}/triage`, { method: "POST" });
    const body = await res.json() as {
      drop: { unit_ids: string[] }[];
      reviewFlags: { unitId: string }[];
    };
    expect(body.drop[0]!.unit_ids).toEqual(["u001"]);
    expect(body.reviewFlags[0]!.unitId).toBe("u003");
  });

  it("triage devolve telemetria editorial somando drop × índice", async () => {
    // O fixture de bootComPlano não tem tempos; a telemetria soma end − start,
    // então o índice aqui usa o contrato real (start/end por unidade, ver
    // packages/triage/src/speech-index.ts).
    const { base, app, dir } = await bootComPlano(new FakeExecutor(), async () => ({
      keepList: "u002",
    }));
    await writeFile(join(dir, "out", "speech_index.json"), JSON.stringify({
      units: [
        { id: "u001", index: 0, text: "t0", start: 0, end: 10 },
        { id: "u002", index: 1, text: "t1", start: 10, end: 25 },
        { id: "u003", index: 2, text: "t2", start: 25, end: 30 },
      ],
    }), "utf8");
    await writeFile(join(dir, "out", "triage.json"), JSON.stringify({
      keepList: "u002",
      drop: [{ unit_ids: ["u001", "u003"], reason: "retake", note: "refeito", source: "llm", restated_by: null }],
      reviewFlags: [],
    }), "utf8");
    const res = await fetch(`${base}/jobs/${app.jobId}/triage`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      stats?: {
        sourceSeconds: number;
        removedSeconds: number;
        outputSeconds: number;
        unitsTotal: number;
        unitsRemoved: number;
        byReason: { reason: string; units: number; seconds: number }[];
        summary: string;
      };
    };
    expect(body.stats).toBeDefined();
    expect(body.stats!.sourceSeconds).toBe(30);
    expect(body.stats!.removedSeconds).toBe(15);
    expect(body.stats!.outputSeconds).toBe(15);
    expect(body.stats!.unitsTotal).toBe(3);
    expect(body.stats!.unitsRemoved).toBe(2);
    expect(body.stats!.byReason[0]).toMatchObject({ reason: "retake", units: 2, seconds: 15 });
    // O summary é o que a página pinta em #triage-stats — provar o texto
    // inteiro é o que garante que mmss e a ordenação chegaram juntos.
    expect(body.stats!.summary)
      .toBe("corta 0m15s de 0m30s · 2/3 unidades · mais: retake (0m15s)");
  });

  it("a página mostra aviso do job e separa vai cair de olhe isto", async () => {
    const { base } = await boot();
    const html = await (await fetch(base)).text();
    expect(html).toContain('id="aviso"');
    expect(html).toContain("j.warning");
    expect(html).toContain("j.progress");
    expect(html).toContain("vai cair (retake limpo)");
    expect(html).toContain("olhe isto (sem substituto)");
    expect(html).toContain("a transcrição leva alguns minutos");
    expect(html).toContain("ouvir junção");
    expect(html).not.toContain("confirm(");
    expect(html).not.toContain("alert(");
  });

  it("serve /media com Accept-Ranges no arquivo de entrada", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-app-"));
    const input = join(dir, "v.mp4");
    await writeFile(input, Buffer.from("abcdefghijklmnopqrstuvwxyz"));
    const app = await startApp({ input, port: 0, autoStart: false });
    stop = app.close;
    const base = `http://127.0.0.1:${app.port}`;
    const full = await fetch(`${base}/media`);
    expect(full.status).toBe(200);
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect((await full.arrayBuffer()).byteLength).toBe(26);
    const ranged = await fetch(`${base}/media`, { headers: { Range: "bytes=0-3" } });
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe("abcd");
  });

  it("keep anexa visual_in_point quando visual_index.json existe", async () => {
    const { base, app, dir } = await bootComPlano();
    await writeFile(join(dir, "out", "condense_plan.json"), JSON.stringify({
      source_duration: 30, output_duration: 20,
      clips: [{ unit_ids: ["u002", "u003"], start: 10, end: 30 }],
      joins: [{
        outgoing_unit: "u002", incoming_unit: "u003",
        removed_seconds: 2, outgoing_tail: "a", incoming_head: "b",
        source_out: 10, source_in: 12, flags: [],
      }],
    }), "utf8");
    await writeFile(join(dir, "out", "visual_index.json"), JSON.stringify({
      units: [{
        id: "u003",
        look_down_ratio: 0, look_side_ratio: 0, hand_on_face_ratio: 0.4, face_missing_ratio: 0,
        samples: [{ t: 12.0, look_down: false, look_side: false, hand_on_face: true, face: true }],
      }],
    }), "utf8");
    const res = await fetch(`${base}/jobs/${app.jobId}/keep`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keepList: "u002-u003" }),
    });
    const body = await res.json() as {
      review: { joins: { flags: { code: string; hint: string }[] }[] };
    };
    expect(body.review.joins[0]!.flags.some((f) => f.code === "visual_in_point")).toBe(true);
    expect(body.review.joins[0]!.flags.find((f) => f.code === "visual_in_point")!.hint).toMatch(/in-point/);
  });

  it("rejeita startApp se a porta já está ocupada", async () => {
    const { app } = await boot();
    const dir = await mkdtemp(join(tmpdir(), "decupa-app-"));
    await expect(startApp({
      input: join(dir, "v.mp4"), port: app.port, autoStart: false,
    })).rejects.toMatchObject({ code: "EADDRINUSE" });
  });

  it("close mata processos do SpawnExecutor", async () => {
    const exec = new SpawnExecutor();
    const dir = await mkdtemp(join(tmpdir(), "decupa-app-"));
    const app = await startApp({
      input: join(dir, "v.mp4"), port: 0, autoStart: false, executor: exec,
    });
    stop = app.close;
    const hung = exec.run({ command: "sleep", args: ["30"] });
    await new Promise((r) => setTimeout(r, 80));
    await app.close();
    stop = null;
    const result = await hung;
    expect(result.code).not.toBe(0);
  });

  it("grava keep.txt a cada replan, para a sessão sobreviver ao reinício", async () => {
    const { base, app, dir } = await bootComPlano();
    await fetch(`${base}/jobs/${app.jobId}/keep`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keepList: "u002-u003" }),
    });
    expect((await readFile(join(dir, "keep.txt"), "utf8")).trim()).toBe("u002-u003");
  });

  it("export srt achata o transcript do motor e remapeia na timeline de saída", async () => {
    const { base, app, dir } = await bootComPlano();
    await writeFile(join(dir, "out", "condense_plan.json"), JSON.stringify({
      source_duration: 30, output_duration: 3,
      clips: [{ unit_ids: ["u002"], start: 10, end: 12 }, { unit_ids: ["u003"], start: 13, end: 14 }],
      joins: [],
    }), "utf8");
    // Formato REAL do motor (ver condense/prepare.ts): segments[].words[] com
    // text/start/end em segundos — não o tokens[] em ms do tipo interno
    // Transcript. Entradas sem texto ou com tempo não-numérico têm de ser
    // filtradas aqui, no caminho vivo, e não virar cue quebrada.
    await writeFile(join(dir, "transcript.json"), JSON.stringify({
      segments: [
        {
          start: 10.0, end: 10.6, text: "o corte é",
          words: [
            { text: "o", start: 10.0, end: 10.1 },
            { text: "corte", start: 10.1, end: 10.4 },
            { text: "é", start: 10.5, end: 10.6 },
          ],
        },
        {
          start: 13.0, end: 13.6, text: "a prosa",
          words: [
            { text: "a", start: 13.0, end: 13.1 },
            { start: 13.2, end: 13.3 },
            { text: "lixo", start: "13.2", end: 13.3 },
            { text: "prosa", start: 13.1, end: 13.6 },
          ],
        },
      ],
    }), "utf8");
    const res = await fetch(`${base}/jobs/${app.jobId}/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "srt" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { downloadUrl: string };
    const srt = await readFile(join(dir, "corte.srt"), "utf8");
    // Clipe 1 (10–12s da fonte) ocupa 0–2s da saída: as palavras dele começam
    // em zero, não em 10 segundos.
    expect(srt).toContain("00:00:00,000 --> 00:00:00,600");
    expect(srt).toContain("o corte é");
    // O vão de 12–13s foi cortado: "a prosa" cai em 2s da saída, não em 13s.
    expect(srt).toContain("00:00:02,000 --> 00:00:02,600");
    expect(srt).toContain("a prosa");
    // As palavras sem texto ou com tempo não-numérico não vazaram para a cue.
    expect(srt).not.toContain("lixo");
    // O mapa de download serve exatamente o arquivo que o export gravou.
    const dl = await fetch(`${base}${body.downloadUrl}`);
    expect(dl.status).toBe(200);
    expect(await dl.text()).toBe(srt);
  });

  it("recusa POST de outra origem, e aceita o da própria página", async () => {
    const { base, app } = await boot();
    const alheio = await fetch(`${base}/jobs/${app.jobId}/cancel`, {
      method: "POST",
      headers: { origin: "https://exemplo.invalido" },
    });
    expect(alheio.status).toBe(403);

    const proprio = await fetch(`${base}/jobs/${app.jobId}/cancel`, {
      method: "POST",
      headers: { origin: `http://127.0.0.1:${app.port}` },
    });
    expect(proprio.status).toBe(200);
  });
});
