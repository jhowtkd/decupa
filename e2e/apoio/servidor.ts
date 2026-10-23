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

// Grupo de processos (POSIX): o servidor sobe como líder de grupo e o parar()
// varre o grupo inteiro. Os renders, que o próprio servidor põe em grupos
// deles, ele encerra no close(). Se o worker do Playwright cair antes do
// teardown, a saída do processo ainda derruba os grupos que sobraram.
const GRUPO = process.platform !== "win32";
const vivos = new Set<number>();
let saidaArmada = false;
function matarGrupo(pid: number, sinal: NodeJS.Signals): void {
  try { process.kill(GRUPO ? -pid : pid, sinal); } catch { /* grupo já vazio */ }
}

export class Servidor {
  url = "";
  private porta = 0;
  private filho: ChildProcess | null = null;
  private saida: string[] = [];
  private opcoes: OpcoesServidor;

  // Sem parameter property: os apoios também rodam sob --experimental-strip-types.
  constructor(opcoes: OpcoesServidor) {
    this.opcoes = opcoes;
  }

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
      "--projects-root", raiz, "--port", String(this.porta)], { cwd: base, env, stdio: ["ignore", "pipe", "pipe"], detached: GRUPO });
    this.filho = filho;
    const pid = filho.pid;
    if (pid) {
      vivos.add(pid);
      // Saiu sozinho: o PID pode ser reaproveitado, então não entra mais na varredura da saída.
      filho.once("exit", () => vivos.delete(pid));
    }
    if (!saidaArmada) {
      saidaArmada = true;
      process.once("exit", () => { for (const pid of vivos) matarGrupo(pid, "SIGKILL"); });
    }
    const guardar = (parte: Buffer) => {
      this.saida.push(parte.toString("utf8"));
      if (this.saida.length > 400) this.saida.splice(0, this.saida.length - 400);
    };
    filho.stderr!.on("data", guardar);
    this.url = await new Promise<string>((ok, falha) => {
      const prazo = setTimeout(() => falha(new Error(`servidor não subiu em 30 s:\n${this.log()}`)), 30_000);
      // Só a saída deste processo: depois de um reinício, o log ainda tem o "pronto" do anterior.
      let deste = "";
      filho.stdout!.on("data", (parte: Buffer) => {
        guardar(parte);
        deste += parte.toString("utf8");
        const achado = PRONTO.exec(deste);
        if (achado) { clearTimeout(prazo); ok(achado[1]!); }
      });
      filho.once("exit", (code) => { clearTimeout(prazo); falha(new Error(`servidor saiu (código ${code}):\n${this.log()}`)); });
    });
    this.porta = Number(new URL(this.url).port);
  }

  /** PID do processo do servidor no ar (líder do grupo no POSIX). */
  get pid(): number | undefined {
    return this.filho?.pid;
  }

  /**
   * SIGTERM ao servidor e espera o encerramento limpo (ele fecha os renders
   * dele); travado, SIGKILL no grupo depois do prazo. No fim, varre o grupo
   * para não deixar órfão.
   */
  async parar(prazoMs = 15_000): Promise<void> {
    const filho = this.filho;
    if (!filho) return;
    this.filho = null;
    const pid = filho.pid;
    if (filho.exitCode === null && filho.signalCode === null) {
      const saiu = new Promise<void>((ok) => filho.once("exit", () => ok()));
      filho.kill("SIGTERM");
      const prazo = setTimeout(() => { if (pid) matarGrupo(pid, "SIGKILL"); }, prazoMs);
      await saiu;
      clearTimeout(prazo);
    }
    if (pid) {
      matarGrupo(pid, "SIGKILL");
      vivos.delete(pid);
    }
  }

  /** Reinício de verdade: processo novo na mesma porta, opcionalmente com outra variante. */
  async reiniciar(mudanca: Partial<OpcoesServidor> = {}): Promise<void> {
    await this.parar();
    await this.subir(mudanca);
  }
}
