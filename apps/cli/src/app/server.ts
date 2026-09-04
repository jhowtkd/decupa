import { createReadStream } from "node:fs";
import { readFile, mkdir, stat, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { buildEdl } from "./edl.ts";
import { JobStore } from "./jobs.ts";
import {
  indexPath, planPath, preflight, probeFps, runIngest, runPlan, runRender,
  runTriage, SpawnExecutor, type Executor, type PipelineJob,
} from "./pipeline.ts";
import { buildReview } from "./review.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readBody(req: NodeJS.ReadableStream): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

export interface AppHandle {
  port: number;
  address: string;
  jobId: string;
  close(): Promise<void>;
}

export async function startApp(opts: {
  input: string;
  port?: number;
  provider?: string;
  executor?: Executor;
  /** false nos testes: não dispara o pipeline de verdade. */
  autoStart?: boolean;
  /** só nos testes; em produção é derivado do caminho do vídeo. */
  workDir?: string;
}): Promise<AppHandle> {
  const input = resolve(opts.input);
  const exec = opts.executor ?? new SpawnExecutor();
  const provider = opts.provider ?? "gemini";
  const page = await readFile(join(HERE, "page.html"), "utf8");

  const workDir = opts.workDir
    ?? join(dirname(input), `.decupa-${basename(input).replace(/\.[^.]+$/, "")}`);
  await mkdir(join(workDir, "out"), { recursive: true });

  const store = new JobStore();
  const job = store.create({ videoPath: input, workDir });
  const pipelineJob: PipelineJob = { id: job.id, videoPath: input, workDir };

  // Fila de um: `condense_plan` grava sempre no mesmo condense_plan.json, e o
  // debounce de 250 ms não impede que um segundo re-plano comece com o
  // primeiro ainda rodando. Dois processos escrevendo o mesmo arquivo fazem o
  // último a gravar vencer — e o review devolvido pode ser o do keep-list
  // antigo, que é exatamente o aviso mentiroso que o debounce existia para
  // evitar.
  let planning: Promise<void> = Promise.resolve();
  let pendingKeepList: string | null = null;

  async function replan(keepList: string): Promise<void> {
    pendingKeepList = keepList;
    const mine = planning.then(async () => {
      // Janela curta para que dois POSTs concorrentes (Promise.all no teste,
      // dois cliques mais rápidos que o debounce na página) registrem o
      // keep-list mais novo antes de este processo começar. `setImmediate`
      // não chega: o segundo TCP chega ~1 ms depois, e o FakeExecutor já
      // teria gravado o plano velho.
      await new Promise<void>((r) => setTimeout(r, 50));
      // Se outro pedido chegou enquanto este esperava, aquele é o atual:
      // rodar este seria gastar processo para produzir um plano obsoleto.
      if (pendingKeepList !== keepList) return;
      try {
        store.setStage(job.id, "planning");
        await runPlan(pipelineJob, keepList, exec);
        const review = buildReview(
          await readJson(planPath(pipelineJob)),
          await readJson(indexPath(pipelineJob)),
        );
        store.setReview(job.id, review, keepList);
      } catch (error) {
        // GET /jobs/:id é o poll da página: sem `fail`, o POST devolve 500
        // mas o estágio fica em planning para sempre. `fail` depois de
        // cancel é no-op — quem pediu para parar não vê "erro: SIGTERM".
        store.fail(job.id, error instanceof Error ? error.message : String(error));
        throw error;
      }
    });
    planning = mine.catch(() => {});
    await mine;
    // Keep supersedido não pode responder antes do vencedor gravar o review:
    // a página faz `if (r.review) { review = r.review; render(); }` e um
    // `{review: undefined}` rebobinaria a tela para o corte antigo.
    if (pendingKeepList !== keepList) await planning;
  }

  async function ingest(): Promise<void> {
    try {
      await preflight(pipelineJob, exec);
      await runIngest(pipelineJob, exec, (stage) => store.setStage(job.id, stage));
      if (store.get(job.id)?.stage === "cancelled") return;
      const index = await readJson(indexPath(pipelineJob)) as { units: { id: string }[] };
      const all = `${index.units[0]!.id}-${index.units[index.units.length - 1]!.id}`;
      await replan(all);
    } catch (error) {
      // `fail` não sobrescreve `cancelled`: matar o processo faz a etapa
      // falhar, e esse erro não é notícia para quem pediu para parar.
      store.fail(job.id, error instanceof Error ? error.message : String(error));
    }
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);

    const handle = async (): Promise<void> => {
      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page);
        return;
      }

      if (url.pathname === "/keeplist.js") {
        // O mesmo arquivo que o teste importa. Servir verbatim é o que garante
        // que a página e o servidor concordam sobre o que é uma faixa.
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        res.end(await readFile(join(HERE, "keeplist.js"), "utf8"));
        return;
      }

      if (parts[0] === "jobs" && parts[1]) {
        const current = store.get(parts[1]);
        if (!current) { sendJson(res, { error: "job não existe" }, 404); return; }

        if (parts.length === 2 && req.method === "GET") {
          sendJson(res, {
            stage: current.stage, error: current.error,
            keepList: current.keepList, review: current.review,
          });
          return;
        }

        if (parts[2] === "cancel" && req.method === "POST") {
          store.cancel(current.id);
          // Trocar o enum não para o WhisperX. Sem matar o processo, quem
          // cancelou espera do mesmo jeito — que é o motivo de cancel existir.
          if (exec instanceof SpawnExecutor) exec.killAll();
          sendJson(res, { ok: true });
          return;
        }

        if (parts[2] === "keep" && req.method === "POST") {
          const body = await readBody(req);
          // A borda aceita um formato só: a mesma string que o --keep consome.
          if (typeof body.keepList !== "string") {
            sendJson(res, { error: "keepList precisa ser string, no formato \"u001-u003 u005\"" }, 400);
            return;
          }
          await replan(body.keepList);
          sendJson(res, { review: store.get(current.id)!.review });
          return;
        }

        if (parts[2] === "triage" && req.method === "POST") {
          const suggested = await runTriage(pipelineJob, exec, provider);
          const report = await readFile(join(workDir, "out", "triage.md"), "utf8")
            .catch(() => "");
          // Prévia com motivo: a spec pede "quais, com o motivo que o modelo
          // deu". As linhas de alegação aplicada do relatório trazem os ids e
          // a justificativa; a página mostra isso antes de mexer na tela.
          const motivos = report.split("\n")
            .filter((l) => l.startsWith("- **"))
            .map((l) => l.replace(/^-\s*/, "").replace(/\*\*/g, ""));
          sendJson(res, { keepList: suggested, motivos, report });
          return;
        }

        if (parts[2] === "export" && req.method === "POST") {
          const body = await readBody(req);
          const kind = String(body.kind ?? "");
          // Export sempre re-planeja: nenhum arquivo sai de um plano velho.
          if (typeof body.keepList === "string") await replan(body.keepList);
          const plan = await readJson(planPath(pipelineJob)) as Record<string, any>;

          if (kind === "edl") {
            // Do arquivo, nunca assumido: `probeFps` recusa fracionário com
            // instrução, em vez de arredondar 29,97 para 30 e produzir
            // timecode com deriva crescente que ninguém nota até o fim.
            const fps = await probeFps(pipelineJob, exec);
            const out = join(workDir, "corte.edl");
            await writeFile(out, buildEdl({
              clips: plan.clips, fps, title: basename(input),
            }), "utf8");
            sendJson(res, { path: out, downloadUrl: `/jobs/${current.id}/download/edl` });
            return;
          }
          if (kind === "mp4") {
            const out = join(workDir, "corte.mp4");
            await runRender(pipelineJob, out, exec);
            sendJson(res, { path: out, downloadUrl: `/jobs/${current.id}/download/mp4` });
            return;
          }
          if (kind === "transcript") {
            sendJson(res, {
              path: join(workDir, "out", "condensed_transcript.json"),
              downloadUrl: `/jobs/${current.id}/download/transcript`,
            });
            return;
          }
          sendJson(res, { error: `kind desconhecido: ${kind}` }, 400);
          return;
        }

        if (parts[2] === "download" && parts[3]) {
          const files: Record<string, string> = {
            edl: join(workDir, "corte.edl"),
            mp4: join(workDir, "corte.mp4"),
            transcript: join(workDir, "out", "condensed_transcript.json"),
          };
          const path = files[parts[3]];
          if (!path) { sendJson(res, { error: "arquivo desconhecido" }, 404); return; }
          // Stream, não readFile: o MP4 de um talking-head de 4 minutos já
          // passa de 300 MB, e carregá-lo inteiro na RAM para servir derruba o
          // processo justamente no caminho secundário.
          const { size } = await stat(path);
          res.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-disposition": `attachment; filename="${basename(path)}"`,
            "content-length": size,
          });
          await pipeline(createReadStream(path), res);
          return;
        }
      }

      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("não encontrado");
    };

    handle().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) sendJson(res, { error: message }, 500);
      else res.end();
    });
  });

  await new Promise<void>((r) => server.listen(opts.port ?? 7788, "127.0.0.1", r));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 7788);

  if (opts.autoStart !== false) void ingest();

  return {
    port, address: "127.0.0.1", jobId: job.id,
    close: async () => {
      await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
    },
  };
}
