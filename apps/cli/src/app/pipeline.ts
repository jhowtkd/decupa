import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Import direto da biblioteca de triagem: mesmo repo, sem subprocesso — o
// contrato é a assinatura TypeScript, não uma regex sobre stdout.
import { runTriage as runTriageLibrary } from "../triage.ts";

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
}

export class SpawnExecutor implements Executor {
  /** Processos vivos, para que `cancel` cumpra o que promete. Sem isto o
   *  cancelamento só trocaria um enum e o WhisperX seguiria até o fim. */
  private readonly running = new Set<ReturnType<typeof spawn>>();

  run(call: ExecCall): Promise<ExecResult> {
    return new Promise((resolvePromise) => {
      // detached: o filho vira líder do grupo; killAll manda SIGTERM no grupo
      // inteiro (pnpm → WhisperX), não só no processo direto.
      const child = spawn(call.command, call.args, {
        env: { ...process.env, ...call.env },
        cwd: call.cwd,
        detached: true,
      });
      this.running.add(child);
      let stdout = "";
      let stderr = "";
      let settled = false;
      const settle = (result: ExecResult) => {
        if (settled) return;
        settled = true;
        this.running.delete(child);
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
    for (const child of this.running) {
      if (child.pid) {
        try { process.kill(-child.pid, "SIGTERM"); } catch { /* já saiu */ }
      }
      child.kill("SIGTERM");
    }
    this.running.clear();
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

export async function runIngest(
  job: PipelineJob,
  exec: Executor,
  onStage: (stage: "transcribing" | "indexing" | "visual") => void,
  onLine?: (line: string) => void,
): Promise<{ warning?: string }> {
  // transcript.json é o cache que a spec promete: re-rodar não re-transcreve.
  const hasTranscript = await access(transcriptPath(job)).then(() => true, () => false);
  if (!hasTranscript) {
    onStage("transcribing");
    await must(exec, {
      command: "pnpm",
      args: ["decupa", "condense-prep", "--input", job.videoPath, "--out", transcriptPath(job)],
      env: envFor(job),
      cwd: REPO_ROOT,
      onLine,
    }, "a transcrição");
  }

  onStage("indexing");
  await must(exec, {
    command: "python3",
    args: [CONDENSE, "index", job.videoPath, transcriptPath(job)],
    env: envFor(job),
    onLine,
  }, "a medição do índice");

  onStage("visual");
  const warning = await runVisualIndex(job, exec, onLine);
  return warning ? { warning } : {};
}

/**
 * Proxy 4 fps + sidecar MediaPipe. Falha não aborta o job: visual é opcional,
 * o keep-list mecânico segue sem as flags.
 */
async function runVisualIndex(
  job: PipelineJob,
  exec: Executor,
  onLine?: (line: string) => void,
): Promise<string | undefined> {
  const hasScript = await access(VISION_SCRIPT).then(() => true, () => false);
  if (!hasScript) return VISUAL_SKIP;

  const proxy = visualProxyPath(job);
  const hasProxy = await access(proxy).then(() => true, () => false);
  if (!hasProxy) {
    const made = await exec.run({
      command: "ffmpeg",
      args: [
        "-i", job.videoPath,
        "-vf", "fps=4,scale=540:960",
        "-c:v", "libx264", "-crf", "32", "-preset", "veryfast",
        "-an", "-y", proxy,
      ],
      env: envFor(job),
      onLine,
    });
    if (made.code !== 0) return VISUAL_SKIP;
  }

  const result = await exec.run({
    command: "uv",
    args: [
      "run", "python", "visual_index.py",
      "--video", proxy,
      "--index", indexPath(job),
      "--fps", "4",
    ],
    env: envFor(job),
    cwd: VISION_CWD,
    onLine,
  });
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

export async function runPlan(job: PipelineJob, keepList: string, exec: Executor): Promise<void> {
  const ranges = keepList.trim().split(/\s+/).filter(Boolean);
  if (ranges.length === 0) {
    throw new Error("keep-list vazio: nada sobraria no corte");
  }
  await must(exec, {
    command: "python3",
    args: [
      CONDENSE, "plan", job.videoPath,
      "--keep", ...ranges,
      "--drop-fillers", "hard",
    ],
    env: envFor(job),
  }, "o plano");
}

export async function makeTriageProxy(
  job: PipelineJob,
  exec: Executor,
  fs: { exists?: (p: string) => Promise<boolean> } = {},
): Promise<string> {
  const out = join(job.workDir, "triage-proxy.mp4");
  const exists = fs.exists ?? (async (p) => access(p).then(() => true, () => false));
  if (await exists(out)) return out;

  await must(exec, {
    command: "ffmpeg",
    args: [
      "-i", job.videoPath,
      "-vf", "fps=1,scale=270:480",
      "-c:v", "libx264", "-crf", "32", "-preset", "veryfast",
      "-c:a", "aac", "-b:a", "24k", "-ac", "1",
      "-y", out,
    ],
    env: envFor(job),
  }, "a geração do proxy de triagem");
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
    // Sem escolha explícita, quem resolve é a biblioteca, pela chave.
    ...(provider ? { provider } : {}),
  });
  return result.keepList;
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
    const { code } = await exec.run({ command: bin, args: ["-version"] });
    if (code !== 0) throw new Error(`${bin} não está no PATH — instale com \`brew install ffmpeg\``);
  }

  // Sidecar de fala = `uv run python transcribe.py` em services/speech — não é daemon.
  // Visão é opcional: o ingest avisa e segue sem visual_index.
  const { code: uvCode } = await exec.run({ command: "uv", args: ["--version"] });
  const hasSpeech = await access(SPEECH_SCRIPT).then(() => true, () => false);
  if (uvCode !== 0 || !hasSpeech) {
    throw new Error(
      "o sidecar de fala está fora do ar — precisa do `uv` no PATH e de " +
      "`services/speech/transcribe.py`. Veja `services/speech/README.md`.",
    );
  }

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
export async function probeFps(job: PipelineJob, exec: Executor): Promise<number> {
  const { code, stdout } = await exec.run({
    command: "ffprobe",
    args: [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=r_frame_rate", "-of", "default=nw=1:nk=1",
      job.videoPath,
    ],
  });
  if (code !== 0) throw new Error("ffprobe não conseguiu ler o frame rate do vídeo");

  const [num, den] = stdout.trim().split("/").map(Number);
  const fps = den ? num! / den! : num!;
  if (!Number.isInteger(fps)) {
    throw new Error(
      `o vídeo tem ${fps.toFixed(2)} fps, e o EDL do v1 só gera non-drop-frame com ` +
      "fps inteiro. Exporte MP4, ou converta a fonte para fps inteiro antes.",
    );
  }
  return fps;
}

export async function runRender(job: PipelineJob, outPath: string, exec: Executor): Promise<string> {
  await must(exec, {
    command: "python3",
    args: [CONDENSE, "render", job.videoPath, outPath],
    env: envFor(job),
  }, "o render");
  return outPath;
}
