import { access } from "node:fs/promises";
import { join } from "node:path";
import { resolveProvider } from "@decupa/triage";
import { DEFAULT_ENGINE, enginePatchError, SPEECH_SCRIPT, SpawnExecutor } from "./app/pipeline.ts";

export interface DoctorLine {
  ok: boolean;
  name: string;
  detail: string;
  /** O que fazer quando não passa. */
  fix?: string;
}

export interface DoctorDeps {
  /** Injetável: testes não dependem do PATH da máquina. */
  run?: (command: string, args: string[]) => Promise<{ code: number }>;
  env?: Record<string, string | undefined>;
  engine?: string;
}

/**
 * Diagnóstico sem efeito colateral: não baixa, não chama rede, não escreve.
 * As checagens são as mesmas do preflight do app — a diferença é que o doctor
 * reporta tudo de uma vez, em vez de estourar na primeira que falta.
 */
export async function runDoctor(deps: DoctorDeps = {}): Promise<DoctorLine[]> {
  // O Executor do pipeline devolve {code, stdout, stderr}; o doctor só precisa
  // do código — o adaptador mantém a injeção de teste com essa forma enxuta.
  const run = deps.run
    ?? (async (command: string, args: string[]) => {
      const { code } = await new SpawnExecutor().run({ command, args });
      return { code };
    });
  const env = deps.env ?? process.env;
  const engine = deps.engine ?? env.VE_PLUGIN_ROOT ?? DEFAULT_ENGINE;
  const lines: DoctorLine[] = [];

  const major = Number(process.versions.node.split(".")[0]);
  lines.push(major >= 22
    ? { ok: true, name: "node", detail: process.versions.node }
    : { ok: false, name: "node", detail: process.versions.node, fix: "o decupa precisa de Node >= 22" });

  for (const bin of ["ffmpeg", "ffprobe"]) {
    const { code } = await run(bin, ["-version"]);
    lines.push(code === 0
      ? { ok: true, name: bin, detail: "no PATH" }
      : { ok: false, name: bin, detail: "fora do PATH", fix: "brew install ffmpeg" });
  }

  // Sidecar de fala = `uv run python transcribe.py` em services/speech — a
  // mesma dupla que o preflight exige; faltar qualquer uma das duas quebra a
  // transcrição do mesmo jeito, então a linha é uma só.
  const uv = await run("uv", ["--version"]);
  const hasSpeech = await access(SPEECH_SCRIPT).then(() => true, () => false);
  lines.push(uv.code === 0 && hasSpeech
    ? { ok: true, name: "sidecar de fala", detail: "uv + services/speech" }
    : {
        ok: false, name: "sidecar de fala",
        detail: uv.code === 0 ? "transcribe.py não encontrado" : "uv fora do PATH",
        fix: "veja services/speech/README.md",
      });

  const hasEngine = await access(join(engine, "mcp", "ve_tools", "condense.py"))
    .then(() => true, () => false);
  lines.push(hasEngine
    ? { ok: true, name: "motor de condense", detail: engine }
    : {
        ok: false, name: "motor de condense", detail: `não achei em ${engine}`,
        fix: "bash scripts/setup-engine.sh (ou aponte VE_PLUGIN_ROOT)",
      });

  if (hasEngine) {
    const patchError = await enginePatchError(engine);
    lines.push(patchError === null
      ? { ok: true, name: "patch PT-BR do motor", detail: "aplicado" }
      : { ok: false, name: "patch PT-BR do motor", detail: patchError, fix: "bash scripts/setup-engine.sh" });
  }

  try {
    const provider = resolveProvider(undefined, env);
    lines.push({ ok: true, name: "chave de análise", detail: `setada (provedor ${provider})` });
  } catch {
    lines.push({
      ok: false, name: "chave de análise", detail: "nenhuma chave setada",
      fix: "exporte uma de ZAI_API_KEY, GEMINI_API_KEY, MINIMAX_API_KEY ou DECUPA_API_KEY no ambiente "
        + "(ou configure_provider para gravar a credencial em .decupa/) — sem ela a triagem não roda; "
        + "ou monte o keep-list na mão (SKILL)",
    });
  }

  // Reportar, não testar: chamada de rede em doctor quebraria a promessa de
  // efeito colateral zero. O que dá sem rede é avisar qual endpoint seria
  // usado — a armadilha 1113 é erro de endereço que parece erro de conta.
  const base = env.ZAI_BASE_URL ?? "https://api.z.ai/api/coding/paas/v4 (default)";
  lines.push({
    ok: true,
    name: "ZAI_BASE_URL",
    detail: base.includes("coding")
      ? `${base} — assinatura Coding Plan; o endpoint paas cobrado devolve 1113 e parece conta vazia`
      : base,
  });

  return lines;
}

export function renderDoctor(lines: DoctorLine[]): string {
  return lines
    .map((l) => `${l.ok ? "OK" : "ERR"} ${l.name} — ${l.detail}${l.ok || !l.fix ? "" : ` (${l.fix})`}`)
    .join("\n");
}
