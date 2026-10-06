import { spawn } from "node:child_process";
import { access, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectSilence } from "@decupa/acoustics";
import type { FileCoordinator } from "@decupa/coordinator";
import { readTimecode, selectFrameRate } from "@decupa/media";
import { CancelledError } from "@decupa/queue";
import { createTracer, type Tracer } from "@decupa/trace";
import { DEFAULT_LANGUAGE, DEFAULT_MODEL, transcribe, type TranscribeDeps } from "@decupa/transcript";

// Import direto da biblioteca de triagem: mesmo repo, sem subprocesso — o
// contrato é a assinatura TypeScript, não uma regex sobre stdout.
import { runTriage as runTriageLibrary } from "../triage.ts";
import { runCondensePrep } from "../condense/run.ts";
import { enginePython, killTreeNow, terminateTree, terminateTreeAndWait } from "../runtime.ts";
import { parseSourceTimecode, sourceMediaStartSeconds } from "./assembly/timecode.ts";
import type { FillerSpan } from "../condense/fillers.ts";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecCall {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  signal?: AbortSignal;
  /** Chamada a cada linha de stdout/stderr, enquanto o processo roda. É o
   *  único sinal de vida que WhisperX e ffmpeg dão de uma etapa de minutos. */
  onLine?: (line: string) => void;
}

export interface Executor {
  run(call: ExecCall): Promise<ExecResult>;
}

export interface PipelineJob {
  id: string;
  videoPath: string;
  workDir: string;
  signal?: AbortSignal;
}

export interface IngestOptions {
  /**
   * Proxy a 4 fps + índice MediaPipe. Ligado por padrão porque a revisão da
   * limpeza marca olhar desviado, mão no rosto e sem rosto a partir desse
   * índice. A montagem desliga: ela nunca lê `visual_index.json`, e os dois
   * passos custam ~113 s até a transcrição aparecer na tela.
   */
  visual?: boolean;
  /**
   * Decodifica a fonte com VideoToolbox ao gerar o proxy a 4 fps. Padrão:
   * ligado no macOS. Se a decodificação por hardware falhar, refaz em software.
   */
  hwDecode?: boolean;
  /**
   * Transcrição sem nenhuma palavra vira erro e não fica em cache (nem no
   * `transcript.json`, nem no coordenador). A limpeza liga: sem fala não há o
   * que limpar, e um vazio guardado se repetiria a cada abertura. A montagem
   * deixa desligado, porque fonte de apoio sem fala é válida lá.
   */
  requireSpeech?: boolean;
}

/** Fim da chave da transcrição da limpeza (`requireSpeech`); a montagem não leva. */
export const TASK_ID_SPEECH_SUFFIX = "#fala";

/** Vídeo sem fala na limpeza: a causa, e o que acontece se abrir de novo. */
export const NO_SPEECH_MESSAGE =
  "a transcrição não encontrou fala neste vídeo. Confira se o áudio tem voz em português; " +
  "o resultado vazio não foi guardado, então abrir o vídeo de novo transcreve outra vez.";

/** Cancelado entre etapas: a próxima não começa. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new CancelledError();
}

/** Um sinal só a partir dos que existirem (o do job e o do chamador). */
function eitherSignal(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  if (present.length <= 1) return present[0];
  return AbortSignal.any(present);
}

/**
 * Publica um derivado gravado em `.partial`: o destino só existe completo.
 * Um encode interrompido deixava um MP4 válido e curto no nome final, e ele
 * era reusado para sempre. Encoder que diz ok sem gravar nada não publica nada.
 */
async function publishPartial(partial: string, out: string): Promise<void> {
  try {
    await rename(partial, out);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Chave da transcrição no coordenador: caminho, tamanho, mtime, modelo e
 * idioma. Só o caminho devolveria a transcrição antiga de um arquivo trocado
 * no mesmo lugar. Sem hash: a fonte tem dezenas de GB.
 */
export function transcriptTaskId(
  input: string,
  source: { size: number; mtimeMs: number },
  model: string = DEFAULT_MODEL,
  language: string = DEFAULT_LANGUAGE,
): string {
  return `${input}#${source.size}-${source.mtimeMs}#${model}#${language}`;
}

/**
 * Argumentos do proxy visual a 4 fps. Só a DECODIFICAÇÃO vai para o hardware:
 * codificar com h264_videotoolbox mudava as marcações do MediaPipe (8 de 43
 * unidades no DJI de 293 s), enquanto decodificar em hardware e codificar com
 * libx264 dá o mesmo índice visual (0 de 577 amostras diferentes), 40% mais rápido.
 */
export function visualProxyArgs(input: string, output: string, hwDecode: boolean): string[] {
  return [
    ...(hwDecode ? ["-hwaccel", "videotoolbox"] : []),
    "-i", input,
    "-vf", "fps=4,scale='min(540,iw)':'min(960,ih)':force_original_aspect_ratio=decrease",
    "-c:v", "libx264", "-crf", "32", "-preset", "veryfast",
    "-an", "-y", output,
  ];
}

/** Worker residente no serviço HTTP; sem ele o ingest cai no CLI `condense-prep`. */
export type IngestSpeech = {
  worker: NonNullable<TranscribeDeps["worker"]>;
  coordinator?: FileCoordinator;
  extract?: TranscribeDeps["extract"];
  detectSilence?: typeof detectSilence;
};

export class SpawnExecutor implements Executor {
  /** Processos vivos, para que `cancel` cumpra o que promete. Sem isto o
   *  cancelamento só trocaria um enum e o WhisperX seguiria até o fim. */
  private readonly running = new Set<ReturnType<typeof spawn>>();
  /** Grupos já sinalizados por `terminateAll` e ainda não confirmados como
   *  mortos: o `killNow` do `exit` também precisa deles. */
  private readonly terminating = new Set<number>();

  run(call: ExecCall): Promise<ExecResult> {
    return new Promise((resolvePromise) => {
      // O motor Python é resolvido aqui, num lugar só: quem chama declara
      // "python3" como intenção e o runtime decide (DECUPA_ENGINE_PYTHON ou o
      // binário da plataforma). detached só no POSIX: lá o filho vira líder do
      // grupo e terminateTree manda SIGTERM no grupo inteiro (wrapper →
      // WhisperX); no Windows o taskkill /T cuida da árvore.
      const command = call.command === "python3" ? enginePython() : call.command;
      const child = spawn(command, call.args, {
        env: { ...process.env, ...call.env },
        cwd: call.cwd,
        detached: process.platform !== "win32",
      });
      this.running.add(child);
      const onAbort = (): void => {
        if (child.pid) terminateTree(child.pid);
      };
      if (call.signal?.aborted) onAbort();
      else call.signal?.addEventListener("abort", onAbort, { once: true });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const settle = (result: ExecResult) => {
        if (settled) return;
        settled = true;
        this.running.delete(child);
        call.signal?.removeEventListener("abort", onAbort);
        resolvePromise(result);
      };
      // Buffer por stream: uma linha pode chegar partida em dois chunks, e
      // metade de uma barra de progresso na tela é pior que nenhuma.
      let outRest = "";
      let errRest = "";
      const feed = (chunk: string, rest: string): string => {
        const parts = (rest + chunk).split(/\r?\n|\r/);
        const tail = parts.pop() ?? "";
        for (const line of parts) {
          const clean = line.trim();
          if (clean) call.onLine?.(clean);
        }
        return tail;
      };
      child.stdout?.on("data", (d) => { stdout += String(d); outRest = feed(String(d), outRest); });
      child.stderr?.on("data", (d) => { stderr += String(d); errRest = feed(String(d), errRest); });
      // ENOENT e afins viram code !== 0: o preflight mapeia para a mensagem
      // de PATH, em vez de rejeitar a Promise e cair como erro genérico.
      child.on("error", (err) => {
        settle({ code: 1, stdout: "", stderr: err.message });
      });
      child.on("close", (code) => {
        const remainingOut = outRest.trim();
        if (remainingOut) call.onLine?.(remainingOut);
        const remainingErr = errRest.trim();
        if (remainingErr) call.onLine?.(remainingErr);
        settle({ code: code ?? 1, stdout, stderr });
      });
    });
  }

  killAll(): void {
    // Mesma contabilidade do shutdown: um /cancel seguido de saída em menos
    // de 2 s deixava vivo o filho que ignora SIGTERM, porque o SIGKILL do
    // terminateTree era um timer solto que o process.exit matava, e o
    // `running` já estava vazio para o terminateAll/killNow do shutdown.
    // Em terminateAll o SIGTERM sai sincronamente, como antes.
    void this.terminateAll();
  }

  /**
   * SIGTERM em todos os filhos vivos (sincronamente, antes do primeiro
   * `await`) e espera os grupos saírem, com SIGKILL depois de `graceMs`. É o
   * que o shutdown usa: `killAll` sozinho deixava o SIGKILL num timer que o
   * `process.exit` seguinte matava, e o filho que ignora SIGTERM ficava vivo.
   */
  async terminateAll(graceMs = 2000): Promise<void> {
    // Inclui os grupos que um terminateAll/killAll anterior ainda espera:
    // o líder pode ter saído com um neto que ignora SIGTERM.
    const pids = new Set<number>(this.terminating);
    for (const child of this.running) if (child.pid) pids.add(child.pid);
    for (const pid of pids) this.terminating.add(pid);
    await Promise.all([...pids].map((pid) =>
      terminateTreeAndWait(pid, graceMs).finally(() => this.terminating.delete(pid))));
  }

  /** SIGKILL síncrono no que restar: o handler de `exit` não espera timer. */
  killNow(): void {
    const pids = new Set<number>(this.terminating);
    for (const child of this.running) if (child.pid) pids.add(child.pid);
    for (const pid of pids) killTreeNow(pid);
  }
}

/** Roteiriza a saída para testar o pipeline sem rodar WhisperX. */
export class FakeExecutor implements Executor {
  readonly calls: ExecCall[] = [];
  /** Linhas roteirizadas, emitidas em `onLine` antes de a chamada terminar. */
  lines: string[] = [];
  /** Maior número de chamadas simultâneas observado. É o que prova que a fila
   *  do replan segura — um plano de verdade leva ~174 ms, e dois em paralelo
   *  sobrescreveriam o mesmo condense_plan.json. */
  maxConcurrent = 0;
  private inFlight = 0;

  private readonly result: Partial<ExecResult>;
  /** Sem atraso o fake termina antes do próximo pedido chegar, e nenhuma
   *  concorrência é observável. Com atraso ele modela o motor real. */
  private readonly delayMs: number;

  // Campos explícitos, não parameter properties: `node
  // --experimental-strip-types` é strip-only e recusa `constructor(private x)`
  // com "TypeScript parameter property is not supported". O vitest transpila
  // de verdade e não reclama, então a suíte inteira fica verde enquanto
  // `decupa limpar` morre no import.
  constructor(result: Partial<ExecResult> = {}, delayMs = 0) {
    this.result = result;
    this.delayMs = delayMs;
  }

  async run(call: ExecCall): Promise<ExecResult> {
    this.calls.push(call);
    for (const line of this.lines) call.onLine?.(line);
    this.inFlight += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.inFlight);
    try {
      if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
      return { code: 0, stdout: "", stderr: "", ...this.result };
    } finally {
      this.inFlight -= 1;
    }
  }
}

function envFor(job: PipelineJob): Record<string, string> {
  // O motor grava out/ e .video_agent/ no cwd ou em CLAUDE_PROJECT_DIR. Sem um
  // diretório por job, dois vídeos se sobrescrevem.
  return { CLAUDE_PROJECT_DIR: job.workDir };
}

async function must(exec: Executor, call: ExecCall, what: string): Promise<ExecResult> {
  const result = await exec.run(call);
  if (result.code !== 0) {
    // Processo morto pelo cancelar não é falha da etapa.
    throwIfAborted(call.signal);
    const detail = (result.stdout + result.stderr).trim().slice(0, 500);
    throw new Error(`${what} falhou (código ${result.code}): ${detail || "sem saída"}`);
  }
  return result;
}

export const transcriptPath = (job: PipelineJob) => join(job.workDir, "transcript.json");
export const planPath = (job: PipelineJob) => join(job.workDir, "out", "condense_plan.json");
export const indexPath = (job: PipelineJob) => join(job.workDir, "out", "speech_index.json");
export const visualIndexPath = (job: PipelineJob) => join(job.workDir, "out", "visual_index.json");
export const visualProxyPath = (job: PipelineJob) => join(job.workDir, "visual-proxy.mp4");
export const audioProxyPath = (job: PipelineJob) => join(job.workDir, "playback.m4a");

/**
 * Proxy só de áudio para os botões "ouvir" da revisão. O player da página é
 * invisível: tocar o original obrigava o navegador a baixar e decodificar o
 * vídeo inteiro (no DJI, 2,7 GB de HEVC 10-bit) só para ouvir um trecho. AAC
 * de 128 kb/s começando no mesmo zero da fonte: ~1–2 s e poucos MB. Publicação
 * atômica; fonte sem áudio (ou falha) devolve false e a página segue no original.
 */
export async function ensureAudioProxy(job: PipelineJob, exec: Executor): Promise<boolean> {
  const out = audioProxyPath(job);
  if (await stat(out).then((s) => s.size > 0, () => false)) return true;
  const tmp = join(job.workDir, `playback.${process.pid}.tmp.m4a`);
  const made = await exec.run({
    command: "ffmpeg",
    args: [
      "-v", "error", "-y", "-i", job.videoPath,
      "-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart", tmp,
    ],
    signal: job.signal,
  });
  if (made.code !== 0 || !(await stat(tmp).then((s) => s.size > 0, () => false))) {
    await unlink(tmp).catch(() => {});
    return false;
  }
  await rename(tmp, out);
  return true;
}

async function transcriptHasNoSegments(job: PipelineJob): Promise<boolean> {
  try {
    const raw = JSON.parse(await readFile(transcriptPath(job), "utf8")) as { segments?: unknown };
    return Array.isArray(raw.segments) && raw.segments.length === 0;
  } catch {
    return false;
  }
}

async function writeEmptySpeechIndex(job: PipelineJob): Promise<void> {
  await mkdir(join(job.workDir, "out"), { recursive: true });
  await writeFile(indexPath(job), `${JSON.stringify({
    units: [],
    topic_runs: [],
    trim_candidates: [],
    budget: { lossless_floor_seconds: 0 },
    source_duration: 0,
  })}\n`, "utf8");
}

/**
 * apps/cli/src/app -> raiz do repo. O motor, o wrapper e os sidecars são
 * invocados por caminho absoluto porque o cwd do processo não é nosso: o SKILL
 * manda rodar de dentro de work/<trabalho>, e o motor grava onde
 * CLAUDE_PROJECT_DIR aponta. Mesmo padrão de packages/transcript.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export const DEFAULT_ENGINE = join(REPO_ROOT, "work", "video-agent-kit-plugin");
const CONDENSE = join(REPO_ROOT, "scripts", "condense.py");
const VISION_CWD = join(REPO_ROOT, "services", "vision");
const VISION_SCRIPT = join(VISION_CWD, "visual_index.py");
// Exportada para o `decupa doctor` conferir o sidecar sem duplicar o caminho.
export const SPEECH_SCRIPT = join(REPO_ROOT, "services", "speech", "transcribe.py");
const VISUAL_SKIP = "sidecar de visão não instalado, segue sem visual";
const SPEECH_DIR = dirname(SPEECH_SCRIPT);

/**
 * O venv do sidecar bate com o uv.lock? Os sidecars rodam com
 * `uv run --no-sync`, que não instala nada: com o venv ausente ele cria um
 * vazio em silêncio e a etapa só cai depois, num ModuleNotFoundError que
 * ninguém liga ao setup. `sync --check` compara sem criar nem alterar nada.
 */
export async function assertSidecarSynced(
  exec: Executor,
  dir: string,
  name: string,
  signal?: AbortSignal,
): Promise<void> {
  const { code } = await exec.run({
    command: "uv",
    args: ["sync", "--locked", "--check", "--offline"],
    cwd: dir,
    ...(signal ? { signal } : {}),
  });
  if (code !== 0) {
    throw new Error(
      `o ambiente Python de ${name} está ausente ou incompleto em ${join(dir, ".venv")}. ` +
      "Execute primeiro: node scripts/setup.mjs",
    );
  }
}

export async function runIngest(
  job: PipelineJob,
  exec: Executor,
  onStage: (stage: "transcribing" | "indexing" | "visual") => void,
  onLine?: (line: string) => void,
  tracer?: Tracer,
  speech?: IngestSpeech,
  signal?: AbortSignal,
  opts: IngestOptions = {},
): Promise<{ warning?: string }> {
  const wantsVisual = opts.visual ?? true;
  const activeTracer = tracer ?? createTracer();
  // Os dois cancelam: o do job (cancelar na tela) e o de quem chamou.
  const abort = eitherSignal(signal, job.signal);
  throwIfAborted(abort);
  // transcript.json é o cache que a spec promete: re-rodar não re-transcreve.
  const hasTranscript = await access(transcriptPath(job)).then(() => true, () => false);
  if (!hasTranscript) {
    await activeTracer.run("transcribing", async () => {
      onStage("transcribing");
      if (speech?.worker) {
        const worker = speech.worker;
        await runCondensePrep(
          { input: job.videoPath, out: transcriptPath(job) },
          {
            transcribe: async (o) => transcribe({
              ...o,
              signal: abort,
              onProgress: onLine,
              // Sempre pelo conteúdo: pelo caminho, o coordenador devolveria a
              // transcrição antiga de um arquivo trocado no mesmo lugar. Com
              // `requireSpeech`, o sufixo separa a chave da limpeza: um vazio
              // já registrado como concluído (versão anterior) venceria a
              // exigência de fala e o worker nunca seria chamado de novo.
              taskId: transcriptTaskId(o.input, await stat(o.input), o.model, o.language)
                + (opts.requireSpeech ? TASK_ID_SPEECH_SUFFIX : ""),
            }, {
              // O vazio estoura dentro do build: o coordenador não marca a
              // tarefa como concluída, e a próxima abertura transcreve de novo.
              worker: opts.requireSpeech
                ? async (req) => {
                  const out = await worker(req);
                  if (out.words.length === 0) throw new Error(NO_SPEECH_MESSAGE);
                  return out;
                }
                : worker,
              coordinator: speech.coordinator,
              extract: speech.extract,
            }),
            detectSilence: speech.detectSilence ?? detectSilence,
          },
        );
        return;
      }
      // Pelo próprio Node, sem subprocesso pnpm: um binário a menos no PATH, um
      // processo a menos na árvore para o cancelamento alcançar. Alternativa
      // de processo único: `decupa condense-prep` → transcribe.py.
      await must(exec, {
        command: process.execPath,
        args: [
          "--experimental-strip-types",
          join(REPO_ROOT, "apps", "cli", "src", "index.ts"),
          "condense-prep",
          "--input", job.videoPath,
          "--out", transcriptPath(job),
        ],
        env: envFor(job),
        cwd: REPO_ROOT,
        signal: abort,
        onLine,
      }, "a transcrição");
    });
  }
  throwIfAborted(abort);

  const emptySpeech = await activeTracer.run("indexing", async () => {
    onStage("indexing");
    if (await transcriptHasNoSegments(job)) {
      if (opts.requireSpeech) {
        // Vazio que já estava no disco (CLI de processo único ou sessão
        // antiga) também sai do cache, pela mesma razão do worker.
        await unlink(transcriptPath(job)).catch(() => {});
        throw new Error(NO_SPEECH_MESSAGE);
      }
      // Fonte de apoio sem fala é válida: o índice vazio permite que a montagem
      // continue usando apenas os trechos de fala de outras fontes.
      await writeEmptySpeechIndex(job);
      return true;
    }
    await must(exec, {
      command: "python3",
      args: [CONDENSE, "index", job.videoPath, transcriptPath(job), "--no-visual-survey"],
      env: envFor(job),
      // Sem o sinal, o filho sobrevive quando outra operação toma o lugar
      // desta: o begin() da montagem só aborta, não mata mais tudo.
      signal: abort,
      onLine,
    }, "a medição do índice");
    return false;
  });
  throwIfAborted(abort);

  // Visual desligado sai antes da etapa: sem span no tracer, sem onStage
  // ("visual" nunca chega a quem mostra progresso) e sem aviso de visão.
  if (!wantsVisual) return {};

  const warning = await activeTracer.run("visual", async () => {
    onStage("visual");
    if (emptySpeech) return undefined;
    return runVisualIndex(job, exec, onLine, opts.hwDecode ?? process.platform === "darwin", abort);
  });
  return warning ? { warning } : {};
}

/**
 * Proxy 4 fps + sidecar MediaPipe. Falha não aborta o job: visual é opcional,
 * o keep-list mecânico segue sem as flags. Cancelamento aborta: o processo
 * morto pelo cancelar não é falha do visual e não pode seguir para a próxima.
 */
async function runVisualIndex(
  job: PipelineJob,
  exec: Executor,
  onLine?: (line: string) => void,
  hwDecode = false,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const hasScript = await access(VISION_SCRIPT).then(() => true, () => false);
  if (!hasScript) return VISUAL_SKIP;
  // Visual é opcional: venv da visão sem sincronizar vira aviso, e nenhum
  // proxy é gerado nem `.venv` vazio criado pelo uv.
  try {
    await assertSidecarSynced(exec, VISION_CWD, "visão", signal);
  } catch (error) {
    // A checagem morta pelo cancelar é cancelamento, não venv faltando.
    throwIfAborted(signal);
    return `${error instanceof Error ? error.message : String(error)} — segue sem visual`;
  }

  const proxy = visualProxyPath(job);
  const hasProxy = await access(proxy).then(() => true, () => false);
  if (!hasProxy) {
    // O ffmpeg escolhe o formato pela extensão: o parcial termina em .mp4.
    const partial = join(job.workDir, "visual-proxy.partial.mp4");
    const encode = (hw: boolean) => exec.run({
      command: "ffmpeg",
      args: visualProxyArgs(job.videoPath, partial, hw),
      env: envFor(job),
      signal,
      onLine,
    });
    let made = await encode(hwDecode);
    // O ffmpeg morto pelo cancelamento também sai com código != 0; relançar
    // em software desfaria o cancelar e seguiria por minutos.
    if (made.code !== 0 && hwDecode && !signal?.aborted) made = await encode(false);
    if (made.code !== 0) {
      await unlink(partial).catch(() => {});
      throwIfAborted(signal);
      return VISUAL_SKIP;
    }
    await publishPartial(partial, proxy);
  }
  throwIfAborted(signal);

  const result = await exec.run({
    command: "uv",
    args: [
      "run", "--no-sync", "python", "visual_index.py",
      "--video", proxy,
      "--index", indexPath(job),
      "--fps", "4",
    ],
    env: envFor(job),
    cwd: VISION_CWD,
    signal,
    onLine,
  });
  throwIfAborted(signal);
  if (result.code !== 0) return VISUAL_SKIP;

  const stdout = result.stdout.trim();
  if (!stdout) return undefined;
  try {
    await mkdir(join(job.workDir, "out"), { recursive: true });
    await writeFile(visualIndexPath(job), stdout, "utf8");
  } catch {
    return VISUAL_SKIP;
  }
  return undefined;
}

/** Uma faixa do keep-list: `u001` ou `u001-u003`. */
const KEEP_RANGE = /^u\d+(-u\d+)?$/;

/**
 * Confere o keep-list antes de ele virar argumento do `condense.py`. Cada
 * faixa entra como um argumento próprio depois de `--keep`; sem o formato,
 * `--drop-fillers` ou qualquer outra opção passaria direto para o motor.
 * Devolve a mensagem do problema, ou `null` se o keep-list serve.
 */
export function keepListError(keepList: string): string | null {
  const bad = keepList.trim().split(/\s+/).filter(Boolean).find((range) => !KEEP_RANGE.test(range));
  if (bad === undefined) return null;
  return `faixa inválida no keep-list: "${bad.slice(0, 40)}". Use o formato "u001-u003 u005".`;
}

export async function runPlan(
  job: PipelineJob,
  keepList: string,
  exec: Executor,
  tracer: Tracer = createTracer(),
  fillers?: { spans: FillerSpan[]; generation: number; supported: boolean; engine?: string },
): Promise<void> {
  const invalid = keepListError(keepList);
  if (invalid) throw new Error(invalid);
  const ranges = keepList.trim().split(/\s+/).filter(Boolean);
  if (ranges.length === 0) {
    throw new Error("keep-list vazio: nada sobraria no corte");
  }
  const dropArgs = ["--drop-fillers", "hard"];
  if (fillers?.supported) {
    const path = join(job.workDir, `fillers-spans-${fillers.generation}.json`);
    await writeFile(path, `${JSON.stringify(fillers.spans)}\n`, "utf8");
    dropArgs.splice(0, dropArgs.length, "--drop-filler-spans", path);
  }
  await tracer.run("planning", async () => {
    await must(exec, {
      command: "python3",
      args: [
        CONDENSE, "plan", job.videoPath,
        "--keep", ...ranges,
        ...dropArgs,
      ],
      env: { ...envFor(job), ...(fillers?.engine ? { VE_PLUGIN_ROOT: fillers.engine } : {}) },
      signal: job.signal,
    }, "o plano");
  });
}

export async function makeTriageProxy(
  job: PipelineJob,
  exec: Executor,
  fs: { exists?: (p: string) => Promise<boolean> } = {},
): Promise<string> {
  const out = join(job.workDir, "triage-proxy.mp4");
  const exists = fs.exists ?? (async (p) => access(p).then(() => true, () => false));
  if (await exists(out)) return out;

  // Parcial e rename, como o proxy visual: um ffmpeg morto no meio deixaria
  // um MP4 curto que a triagem paga leria para sempre.
  const partial = join(job.workDir, "triage-proxy.partial.mp4");
  try {
    await must(exec, {
      command: "ffmpeg",
      args: [
        "-i", job.videoPath,
        "-vf", "fps=1,scale='min(270,iw)':'min(480,ih)':force_original_aspect_ratio=decrease",
        "-c:v", "libx264", "-crf", "32", "-preset", "veryfast",
        "-c:a", "aac", "-b:a", "24k", "-ac", "1",
        "-y", partial,
      ],
      env: envFor(job),
      signal: job.signal,
    }, "a geração do proxy de triagem");
  } catch (error) {
    await unlink(partial).catch(() => {});
    throwIfAborted(job.signal);
    throw error;
  }
  await publishPartial(partial, out);
  return out;
}

export async function runTriage(
  job: PipelineJob,
  exec: Executor,
  provider?: string,
  triageFn: (opts: {
    indexPath: string;
    videoPath: string;
    outDir: string;
    provider?: string;
    projectDir?: string;
    signal?: AbortSignal;
  }) => Promise<{ keepList: string }> = runTriageLibrary,
): Promise<string> {
  // O proxy continua sendo do pipeline: é Executor (testável) e o trabalho
  // de gerar não pode ficar escondido dentro da biblioteca que o teste
  // injeta. A biblioteca decide o resto — inclusive se o vídeo precisa de
  // proxy próprio (ensureLightVideo, que passa o nosso direto).
  const proxy = await makeTriageProxy(job, exec);
  const result = await triageFn({
    indexPath: indexPath(job),
    videoPath: proxy,
    outDir: join(job.workDir, "out"),
    projectDir: process.cwd(),
    // Sem escolha explícita, quem resolve é a biblioteca, pela chave.
    ...(provider ? { provider } : {}),
    ...(job.signal ? { signal: job.signal } : {}),
  });
  return result.keepList;
}

/** Só detecção: a migração e a exigência do patch pertencem ao setup do T3b. */
export async function engineSupportsFillerSpans(engine: string): Promise<boolean> {
  const source = await readFile(join(engine, "mcp", "ve_tools", "condense.py"), "utf8").catch(() => null);
  return source !== null && /["']drop_filler_spans["']/.test(source);
}

const TERMINAL_PUNCT_RE = /_TERMINAL_PUNCT\s*=\s*"([^"]*)"/;

/**
 * O motor upstream só traz pontuação CJK mais `!?…` em `_TERMINAL_PUNCT` — sem
 * o ponto ASCII, 37 das 42 unidades do ritmo entram como frase inacabada:
 * `splitTakes` para de fechar take, a penalidade de "sem pontuação" cai em
 * quase todo mundo, e a escolha de retake vira ruído. Medido no material do
 * ritmo, o corte muda em quatro unidades — um fragmento, um retake repetido e
 * um aparte que deviam sair, ficam.
 *
 * A checagem mora aqui, e não num teste, porque o gold roda sobre índice
 * congelado: a suíte fica verde enquanto a saída de produção degrada. Um clone
 * novo do motor passa no teste de existência e falha exatamente assim.
 *
 * Devolve a mensagem do problema, ou `null` se o motor está bom.
 */
export async function enginePatchError(engine: string): Promise<string | null> {
  const lang = join(engine, "mcp", "ve_tools", "condense_lang.py");
  const src = await readFile(lang, "utf8").catch(() => null);
  if (src === null) return `não consegui ler ${lang} para conferir o patch de pontuação`;

  const match = TERMINAL_PUNCT_RE.exec(src);
  if (!match) return `não achei \`_TERMINAL_PUNCT\` em ${lang} — motor em versão inesperada`;
  if (!match[1]!.includes(".")) {
    return (
      `o motor em ${engine} está sem o patch de pontuação PT-BR: falta o ponto ASCII ` +
      "em `_TERMINAL_PUNCT` (mcp/ve_tools/condense_lang.py). Sem ele o índice marca " +
      "frase inacabada demais e o corte degrada em silêncio. Rode " +
      "`bash scripts/setup-engine.sh` para reinstalar o motor."
    );
  }

  // Segunda metade do patch: sem os léxicos, o motor roda o caminho inglês
  // mesmo com a pontuação certa, e a diferença não aparece em nenhum erro —
  // só num corte pior.
  if (!src.includes("FILLERS_SOFT_PT")) {
    return (
      `o motor em ${engine} está sem o léxico PT-BR: falta \`FILLERS_SOFT_PT\` em ` +
      "`mcp/ve_tools/condense_lang.py`. Rode `bash scripts/setup-engine.sh` para " +
      "reinstalar o motor no commit pinado com o patch aplicado."
    );
  }
  return null;
}

/**
 * Confere o que a tabela de erros da spec promete, antes de começar o job.
 * Sem isto a falta de um binário chega como stdout truncado de uma etapa que
 * já rodou por minutos.
 */
export async function preflight(job: PipelineJob, exec: Executor): Promise<void> {
  const readable = await access(job.videoPath).then(() => true, () => false);
  if (!readable) throw new Error(`não consegui ler o vídeo em ${job.videoPath}`);

  for (const bin of ["ffmpeg", "ffprobe"]) {
    const { code } = await exec.run({ command: bin, args: ["-version"], signal: job.signal });
    if (code !== 0) throw new Error(`${bin} não está no PATH — instale com \`brew install ffmpeg\``);
  }

  // CLI de processo único: `uv run python transcribe.py`. Serviço residente:
  // `worker.py --serve` no app HTTP. Preflight confirma o CLI; o worker
  // mora no mesmo diretório.
  const { code: uvCode } = await exec.run({ command: "uv", args: ["--version"], signal: job.signal });
  const hasSpeech = await access(SPEECH_SCRIPT).then(() => true, () => false);
  if (uvCode !== 0 || !hasSpeech) {
    throw new Error(
      "o sidecar de fala está fora do ar — precisa do `uv` no PATH e de " +
      "`services/speech/transcribe.py`. Veja `services/speech/README.md`.",
    );
  }
  await assertSidecarSynced(exec, SPEECH_DIR, "fala");

  const engine = process.env.VE_PLUGIN_ROOT ?? DEFAULT_ENGINE;
  const hasEngine = await access(join(engine, "mcp", "ve_tools", "condense.py"))
    .then(() => true, () => false);
  if (!hasEngine) {
    throw new Error(
      `não achei o motor de condense em ${engine}. Clone jhowtkd/video-agent-kit-plugin ` +
      "lá, ou aponte VE_PLUGIN_ROOT.",
    );
  }

  const patchError = await enginePatchError(engine);
  if (patchError) throw new Error(patchError);
}

/**
 * Frame rate da fonte, para o EDL. Fracionário estoura aqui em vez de virar
 * timecode errado em silêncio — material a 29,97 sai com deriva crescente, e
 * ninguém percebe até a timeline dessincronizar no fim.
 */
export async function probeFps(
  job: PipelineJob,
  exec: Executor,
  opts?: { allowDropFrame?: boolean },
): Promise<number> {
  const { code, stdout } = await exec.run({
    command: "ffprobe",
    args: [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=r_frame_rate,avg_frame_rate", "-of", "json",
      job.videoPath,
    ],
    signal: job.signal,
  });
  if (code !== 0) throw new Error("ffprobe não conseguiu ler o frame rate do vídeo");

  // A mesma checagem do probe da montagem: `r_frame_rate` absurdo (celular
  // com VFR devolve 90000/1) cai para `avg_frame_rate`, e 0/0 não vira NaN.
  let stream: { r_frame_rate?: string; avg_frame_rate?: string } | undefined;
  try {
    stream = (JSON.parse(stdout) as { streams?: typeof stream[] }).streams?.[0];
  } catch {
    stream = undefined;
  }
  const rate = selectFrameRate(stream?.r_frame_rate, stream?.avg_frame_rate);
  if (!rate) throw new Error("ffprobe não achou um frame rate válido no vídeo");
  const fps = rate.num / rate.den;
  if (!Number.isInteger(fps)) {
    if (opts?.allowDropFrame && Math.abs(fps - 29.97) < 0.01) {
      return fps;
    }
    throw new Error(
      `o vídeo tem ${fps.toFixed(2)} fps, e o EDL só gera non-drop-frame com fps inteiro ou 29,97 drop-frame. ` +
      `Para este fps, exporte OTIO (kind "otio"), MP4, ou converta a fonte para fps inteiro antes.`,
    );
  }
  return fps;
}

/**
 * Início da fonte pelo timecode embutido, em segundos (0 sem etiqueta), com
 * a mesma leitura da montagem. Sem isto o EDL da limpeza marcava in-points a
 * partir de 00:00:00:00, e material de câmera em 01:00:00:00 ficava offline.
 * Etiqueta ilegível estoura: assumir 0 deslocaria os cortes em silêncio.
 */
export async function probeSourceStartSeconds(job: PipelineJob, exec: Executor): Promise<number> {
  const { code, stdout } = await exec.run({
    command: "ffprobe",
    args: [
      "-v", "error",
      "-show_entries", "stream=codec_type,r_frame_rate,avg_frame_rate:stream_tags=timecode:format_tags=timecode",
      "-of", "json",
      job.videoPath,
    ],
    signal: job.signal,
  });
  if (code !== 0) throw new Error("ffprobe não conseguiu ler o timecode do vídeo");
  type Stream = { codec_type?: string; r_frame_rate?: string; avg_frame_rate?: string; tags?: Record<string, string | undefined> };
  let parsed: { streams?: Stream[]; format?: { tags?: Record<string, string | undefined> } };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    throw new Error("ffprobe devolveu uma saída ilegível ao ler o timecode do vídeo");
  }
  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const raw = readTimecode(video, parsed.format?.tags, streams);
  if (!raw) return 0;
  const rate = selectFrameRate(video?.r_frame_rate, video?.avg_frame_rate);
  const tc = parseSourceTimecode(raw, rate);
  if (tc.frames == null) {
    throw new Error(
      `o vídeo tem timecode ilegível "${raw}" — corrija a etiqueta na mídia (ex.: ffmpeg -timecode) ` +
      "ou grave a mídia sem timecode",
    );
  }
  return sourceMediaStartSeconds({ fps: rate, timecode: tc }) ?? 0;
}

export async function runRender(job: PipelineJob, outPath: string, exec: Executor): Promise<string> {
  await must(exec, {
    command: "python3",
    args: [CONDENSE, "render", job.videoPath, outPath],
    env: envFor(job),
    signal: job.signal,
  }, "o render");
  return outPath;
}
