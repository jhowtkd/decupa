import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { analysisClientOptions, payloadProfileKey, readCredentials, resolveProvider, resolveVisualProvider, visualClientOptions } from "@decupa/triage";
import { DEFAULT_ENGINE, enginePatchError, SPEECH_SCRIPT, SpawnExecutor } from "./app/pipeline.ts";
import { enginePython } from "./runtime.ts";

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
  /**
   * true = só prontidão local: dispensa provedor/IA (chave + nota ZAI), mas
   * ainda executa os imports reais de fala/visão e o Python do motor.
   */
  localOnly?: boolean;
  /** Onde fica `.decupa/credentials` do usuário; os testes não leem o real. */
  home?: string;
}

/** Mínimo de vite 8 e oxlint; o mesmo número de `engines` e do setup. */
const NODE_MIN = [22, 12] as const;

/**
 * Diagnóstico sem efeito colateral: não baixa, não chama rede, não escreve.
 * As checagens são as mesmas do preflight do app — a diferença é que o doctor
 * reporta tudo de uma vez, em vez de estourar na primeira que falta.
 * Com `localOnly`, o relatório omite chave de IA e nota de endpoint: prova a
 * máquina (imports nos venvs dos sidecars + Python do motor) sem credencial.
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

  const [major, minor] = process.versions.node.split(".").map(Number);
  lines.push(major > NODE_MIN[0] || (major === NODE_MIN[0] && minor >= NODE_MIN[1])
    ? { ok: true, name: "node", detail: process.versions.node }
    : {
        ok: false, name: "node", detail: process.versions.node,
        fix: `o decupa precisa de Node >= ${NODE_MIN.join(".")} — veja o guia em docs/setup/GUIA.md`,
      });

  // Pré-requisito de sistema aponta ao guia, não a um gerenciador de uma
  // plataforma só (brew não existe no Windows).
  for (const bin of ["ffmpeg", "ffprobe"]) {
    const { code } = await run(bin, ["-version"]);
    lines.push(code === 0
      ? { ok: true, name: bin, detail: "no PATH" }
      : { ok: false, name: bin, detail: "fora do PATH", fix: "veja o guia em docs/setup/GUIA.md" });
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

  // Existir no PATH não basta: o sidecar só funciona se o pacote importa no
  // venv dele. O import roda no Python do próprio venv, sem `uv run`: mesmo
  // com --no-sync, o uv criava um .venv vazio quando ele faltava, e o doctor
  // não pode instalar nada. Venv ausente é spawn que falha — ambiente
  // incompleto. O caminho é absoluto, derivado de SPEECH_SCRIPT.
  const speechDir = dirname(SPEECH_SCRIPT);
  const venvBin = process.platform === "win32" ? "Scripts/python.exe" : "bin/python";
  for (const [name, dir, code] of [
    ["pacote de fala", speechDir, "import whisperx"],
    ["pacote de visão", resolve(speechDir, "..", "vision"), "import mediapipe"],
  ]) {
    const result = await run(join(dir, ".venv", venvBin), ["-c", code]);
    lines.push({
      name,
      ok: result.code === 0,
      detail: result.code === 0 ? "import OK" : "ambiente incompleto",
      ...(result.code === 0 ? {} : { fix: "execute node scripts/setup.mjs" }),
    });
  }

  // Versão não basta: o motor importa cv2, numpy e scenedetect, e o python3
  // de uma máquina limpa passa na versão e quebra no primeiro condense.
  const enginePy = enginePython(env);
  const version = await run(enginePy, ["-c", "import sys; assert sys.version_info >= (3, 11)"]);
  const imports = version.code === 0 ? await run(enginePy, ["-c", "import cv2, numpy, scenedetect"]) : version;
  lines.push(imports.code === 0
    ? { ok: true, name: "Python do motor", detail: `${enginePy} com cv2, numpy e scenedetect` }
    : {
        ok: false, name: "Python do motor",
        detail: version.code === 0 ? `${enginePy} sem cv2, numpy ou scenedetect` : `${enginePy} indisponível ou abaixo de 3.11`,
        fix: "execute node scripts/setup.mjs (cria work/engine-venv com as dependências do motor)",
      });

  // Provedor/IA só entra no relatório completo: `--local` prova a máquina
  // sem exigir credencial (exit 0 quando apenas o provedor falta).
  if (!deps.localOnly) {
    // A mesma resolução do app: ~/.decupa/credentials (gravado pelo setup ou
    // pela primeira abertura) vence o ambiente. Credencial ilegível vale como
    // ausente, como no servidor.
    const stored = await readCredentials(deps.home ?? homedir()).catch(() => null);
    try {
      const provider = resolveProvider(undefined, env, stored);
      analysisClientOptions({ stored, env });
      const where = stored?.preset === provider && stored.apiKey ? "~/.decupa/credentials" : "ambiente";
      lines.push({ ok: true, name: "chave de análise", detail: `setada (provedor ${provider}, ${where})` });
      const text = analysisClientOptions({ stored, env });
      lines.push({ ok: true, name: "provedor de texto", detail: `${provider} · ${text.model} · origem: ${where} · chave presente` });
    } catch (error) {
      lines.push({
        ok: false, name: "chave de análise",
        detail: stored && error instanceof Error ? error.message : "nenhuma chave setada",
        fix: "exporte uma de ZAI_API_KEY, GEMINI_API_KEY, MINIMAX_API_KEY ou DECUPA_API_KEY no ambiente "
          + "(ou configure_provider para gravar a credencial em .decupa/) — sem ela a triagem não roda; "
          + "ou monte o keep-list na mão (SKILL)",
      });
    }

    try {
      const visual = resolveVisualProvider(env);
      if (visual && !env[visual.envKey]) throw new Error(`openai · ${visual.model} · perfil: ${visual.profile} · origem: DECUPA_VISUAL_PROVIDER (ambiente) · chave ausente: OPENAI_API_KEY`);
      const cfg = visualClientOptions({ stored, env });
      lines.push({ ok: true, name: "provedor de visão", detail:
        `${visual ? "openai" : "geral"} · ${cfg.model} · perfil: ${cfg.profile ?? "default"} (${payloadProfileKey(cfg).slice(0, 12)}) · origem: ${visual ? "DECUPA_VISUAL_PROVIDER (ambiente)" : "provedor de texto"} · chave presente` });
    } catch (error) {
      lines.push({ ok: false, name: "provedor de visão", detail: error instanceof Error ? error.message : String(error),
        fix: "para Luna, use DECUPA_VISUAL_PROVIDER=openai + OPENAI_API_KEY e reinicie; sem a variável, a visão segue o texto" });
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
  }

  return lines;
}

export function renderDoctor(lines: DoctorLine[]): string {
  return lines
    .map((l) => `${l.ok ? "OK" : "ERR"} ${l.name} — ${l.detail}${l.ok || !l.fix ? "" : ` (${l.fix})`}`)
    .join("\n");
}
