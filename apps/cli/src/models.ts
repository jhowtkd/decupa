import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Execute = (command: string, args: string[], cwd: string) => Promise<void>;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const SPEECH_DIR = join(REPO_ROOT, "services", "speech");

/** Executa um comando mostrando os logs do preparo sem poluir o stdout. */
function execute(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", shell: false });
    child.once("error", (error) => reject(error));
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command}: código ${code ?? "desconhecido"}`));
    });
  });
}

function modelFetchError(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(
    `não foi possível baixar os modelos de fala: ${detail}. ` +
    "Confira a rede e o espaço disponível no cache (HF_HOME/TORCH_HOME) e tente de novo.",
    { cause: error },
  );
}

export async function runModelsFetch(opts: { execute?: Execute } = {}): Promise<void> {
  console.log("Baixando e verificando modelos de fala (Whisper, VAD e alinhamento PT-BR)...");
  try {
    await (opts.execute ?? execute)(
      "uv",
      ["run", "--no-sync", "python", "transcribe.py", "--prepare-models"],
      SPEECH_DIR,
    );
  } catch (error) {
    throw modelFetchError(error);
  }
  console.log("Modelos de fala prontos no cache do usuário.");
}
