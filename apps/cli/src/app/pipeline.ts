import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecCall {
  command: string;
  args: string[];
  env?: Record<string, string>;
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
      child.stdout?.on("data", (d) => { stdout += String(d); });
      child.stderr?.on("data", (d) => { stderr += String(d); });
      // ENOENT e afins viram code !== 0: o preflight mapeia para a mensagem
      // de PATH, em vez de rejeitar a Promise e cair como erro genérico.
      child.on("error", (err) => {
        settle({ code: 1, stdout: "", stderr: err.message });
      });
      child.on("close", (code) => {
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
  constructor(private readonly result: Partial<ExecResult> = {}) {}
  async run(call: ExecCall): Promise<ExecResult> {
    this.calls.push(call);
    return { code: 0, stdout: "", stderr: "", ...this.result };
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

export async function runIngest(
  job: PipelineJob,
  exec: Executor,
  onStage: (stage: "transcribing" | "indexing") => void,
): Promise<void> {
  // transcript.json é o cache que a spec promete: re-rodar não re-transcreve.
  const hasTranscript = await access(transcriptPath(job)).then(() => true, () => false);
  if (!hasTranscript) {
    onStage("transcribing");
    await must(exec, {
      command: "pnpm",
      args: ["decupa", "condense-prep", "--input", job.videoPath, "--out", transcriptPath(job)],
      env: envFor(job),
    }, "a transcrição");
  }

  onStage("indexing");
  await must(exec, {
    command: "python3",
    args: ["scripts/condense.py", "index", job.videoPath, transcriptPath(job)],
    env: envFor(job),
  }, "a medição do índice");
}

export async function runPlan(job: PipelineJob, keepList: string, exec: Executor): Promise<void> {
  const ranges = keepList.trim().split(/\s+/).filter(Boolean);
  if (ranges.length === 0) {
    throw new Error("keep-list vazio: nada sobraria no corte");
  }
  await must(exec, {
    command: "python3",
    args: [
      "scripts/condense.py", "plan", job.videoPath,
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

export async function runTriage(job: PipelineJob, exec: Executor, provider: string): Promise<string> {
  const proxy = await makeTriageProxy(job, exec);
  const result = await must(exec, {
    command: "pnpm",
    args: [
      "decupa", "triage",
      "--index", indexPath(job), "--video", proxy,
      "--out", join(job.workDir, "out"), "--provider", provider,
    ],
    env: envFor(job),
  }, "a triagem");

  const match = /keep-list:\s*(.+)/.exec(result.stdout);
  if (!match) throw new Error(`a triagem não devolveu keep-list: ${result.stdout.slice(0, 300)}`);
  return match[1]!.trim();
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
  const { code: uvCode } = await exec.run({ command: "uv", args: ["--version"] });
  const speechScript = join("services", "speech", "transcribe.py");
  const hasSpeech = await access(speechScript).then(() => true, () => false);
  if (uvCode !== 0 || !hasSpeech) {
    throw new Error(
      "o sidecar de fala está fora do ar — precisa do `uv` no PATH e de " +
      "`services/speech/transcribe.py`. Veja `services/speech/README.md`.",
    );
  }

  const engine = process.env.VE_PLUGIN_ROOT ?? "work/video-agent-kit-plugin";
  const hasEngine = await access(join(engine, "mcp", "ve_tools", "condense.py"))
    .then(() => true, () => false);
  if (!hasEngine) {
    throw new Error(
      `não achei o motor de condense em ${engine}. Clone jhowtkd/video-agent-kit-plugin ` +
      "lá, ou aponte VE_PLUGIN_ROOT.",
    );
  }
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
    args: ["scripts/condense.py", "render", job.videoPath, outPath],
    env: envFor(job),
  }, "o render");
  return outPath;
}
