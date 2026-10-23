// Sobe o CLI real (`decupa serve --projects-root`) como processo filho, do
// jeito que a pessoa usa, e o reinicia na mesma porta: mesma origem, mesmo
// localStorage, servidor novo lendo o Projeto do disco.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(REPO, "apps/cli/src/index.ts");
const PRONTO = /servidor na Raiz de Projetos em (http:\/\/[^/\s]+)\//;

export type OpcoesServidor = {
  /** Raiz de Projetos. */
  raiz: string;
  /** Pasta do teste: HOME e TMPDIR do servidor ficam dentro dela. */
  base: string;
  /** `null` sobe sem `DECUPA_EDITOR_UI` (legacy). */
  variante: "studio" | "legacy" | null;
  /** Senha de teste da autenticação; nunca a real. */
  senha?: string;
  /** Aponta o motor de render para lugar nenhum: a prévia falha rápido. */
  semMotor?: boolean;
};

export class Servidor {
  url = "";
  private porta = 0;
  private filho: ChildProcess | null = null;
  private saida: string[] = [];

  constructor(private opcoes: OpcoesServidor) {}

  /** Últimas linhas do servidor, anexadas ao relatório quando o teste falha. */
  log(): string {
    return this.saida.join("");
  }

  async subir(mudanca: Partial<OpcoesServidor> = {}): Promise<void> {
    if (this.filho) throw new Error("servidor já está no ar");
    this.opcoes = { ...this.opcoes, ...mudanca };
    const { raiz, base, variante, senha, semMotor } = this.opcoes;
    const home = join(base, "home");
    const tmp = join(base, "tmp");
    await mkdir(home, { recursive: true });
    await mkdir(tmp, { recursive: true });
    // Ambiente mínimo e explícito: nenhuma chave de IA nem configuração de quem roda.
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: tmp, LANG: "C.UTF-8", TZ: "UTC",
      PYTHONDONTWRITEBYTECODE: "1" };
    if (variante) env.DECUPA_EDITOR_UI = variante;
    if (senha) env.DECUPA_AUTH_PASSWORD = senha;
    // Plano B, desligado: DECUPA_E2E_MOTOR=sintetico troca só o compositor
    // por um MP4 liso do FFmpeg na duração da timeline (e2e/apoio/motor-sintetico).
    if (semMotor) env.VE_PLUGIN_ROOT = join(base, "sem-motor");
    else if (process.env.DECUPA_E2E_MOTOR === "sintetico") env.VE_PLUGIN_ROOT = join(REPO, "e2e/apoio/motor-sintetico");
    const filho = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, "serve",
      "--projects-root", raiz, "--port", String(this.porta)], { cwd: base, env, stdio: ["ignore", "pipe", "pipe"] });
    this.filho = filho;
    const guardar = (parte: Buffer) => {
      this.saida.push(parte.toString("utf8"));
      if (this.saida.length > 400) this.saida.splice(0, this.saida.length - 400);
    };
    filho.stderr!.on("data", guardar);
    this.url = await new Promise<string>((ok, falha) => {
      const prazo = setTimeout(() => falha(new Error(`servidor não subiu em 30 s:\n${this.log()}`)), 30_000);
      filho.stdout!.on("data", (parte: Buffer) => {
        guardar(parte);
        const achado = PRONTO.exec(this.log());
        if (achado) { clearTimeout(prazo); ok(achado[1]!); }
      });
      filho.once("exit", (code) => { clearTimeout(prazo); falha(new Error(`servidor saiu (código ${code}):\n${this.log()}`)); });
    });
    this.porta = Number(new URL(this.url).port);
  }

  /** SIGTERM e espera o encerramento limpo; SIGKILL se travar. */
  async parar(): Promise<void> {
    const filho = this.filho;
    if (!filho) return;
    this.filho = null;
    if (filho.exitCode !== null || filho.signalCode !== null) return;
    const saiu = new Promise<void>((ok) => filho.once("exit", () => ok()));
    filho.kill("SIGTERM");
    const prazo = setTimeout(() => filho.kill("SIGKILL"), 15_000);
    await saiu;
    clearTimeout(prazo);
  }

  /** Reinício de verdade: processo novo na mesma porta, opcionalmente com outra variante. */
  async reiniciar(mudanca: Partial<OpcoesServidor> = {}): Promise<void> {
    await this.parar();
    await this.subir(mudanca);
  }
}
