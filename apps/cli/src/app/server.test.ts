import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeExecutor } from "./pipeline.ts";
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
async function bootComPlano(exec: FakeExecutor = new FakeExecutor()) {
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
  });
  stop = app.close;
  return { app, exec, base: `http://127.0.0.1:${app.port}` };
}

describe("startApp", () => {
  it("sobe numa porta e serve a página em /", async () => {
    const { base } = await boot();
    const res = await fetch(base);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(await res.text()).toContain("<!doctype html>");
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
    const { base, app, exec } = await bootComPlano();
    const post = (keepList: string) => fetch(`${base}/jobs/${app.jobId}/keep`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keepList }),
    });
    const [first, second] = await Promise.all([post("u001-u002"), post("u002-u003")]);
    const planos = exec.calls.filter((c) => c.args.includes("plan"));
    expect(planos).toHaveLength(1);
    expect(planos[0]!.args).toContain("u002-u003");
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
});
