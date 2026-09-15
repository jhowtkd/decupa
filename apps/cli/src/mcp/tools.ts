import { homedir } from "node:os";
import { resolve } from "node:path";
import type { DoctorLine } from "../doctor.ts";
import { writeCredentials, type Credentials } from "@decupa/triage";

type AppHandle = { port: number; close(): Promise<void> };

function isProviderName(value: string): value is Credentials["preset"] {
  return value === "zai" || value === "gemini" || value === "minimax" || value === "custom";
}

export type StartFn = (opts: {
  input?: string;
  projectDir?: string;
  port?: number;
  allowPaidModel?: boolean;
  allowPaidVisual?: boolean;
  autoStart?: boolean;
  providerConfigDir?: string;
}) => Promise<AppHandle>;

export type McpDeps = {
  doctor: () => Promise<DoctorLine[]>;
  startApp: StartFn;
  writeCredentials: typeof writeCredentials;
  cwd: () => string;
};

export type Running = {
  url: string;
  port: number;
  mode: "limpar" | "montar";
  projectDir?: string;
  close: () => Promise<void>;
};

const TOOLS = [
  {
    name: "doctor",
    description: "Checa o ambiente do Decupa (binários, motor, chaves) sem efeito colateral.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "configure_provider",
    description: "Grava preset/modelo/URL/chave em .decupa/credentials (gitignorado). Não dispara chamada paga.",
    inputSchema: {
      type: "object",
      properties: {
        preset: { type: "string", enum: ["zai", "gemini", "minimax", "custom"] },
        model: { type: "string" },
        baseUrl: { type: "string" },
        apiKey: { type: "string" },
        projectDir: { type: "string" },
      },
      required: ["preset"],
    },
  },
  {
    name: "start",
    description: "Sobe o app local e devolve a URL. Não abre o navegador.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["limpar", "montar"] },
        input: { type: "string" },
        project: { type: "string" },
        port: { type: "number" },
        allowPaidModel: { type: "boolean" },
        allowPaidVisual: { type: "boolean" },
      },
      required: ["mode"],
    },
  },
  {
    name: "status",
    description: "Diz se o servidor subido por start ainda está no ar.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "stop",
    description: "Encerra o servidor subido por start.",
    inputSchema: { type: "object", properties: {} },
  },
];

export function toolList(): typeof TOOLS {
  return TOOLS;
}

export function createMcpSession(deps: McpDeps) {
  let running: Running | null = null;

  async function startOnPort(opts: Parameters<StartFn>[0], preferred?: number): Promise<AppHandle> {
    const first = preferred ?? 7788;
    let last: Error | null = null;
    for (let port = first; port <= first + 10 && port <= 7798; port += 1) {
      try {
        return await deps.startApp({ ...opts, port, autoStart: false, providerConfigDir: homedir() });
      } catch (err) {
        last = err instanceof Error ? err : new Error(String(err));
        if (!/EADDRINUSE|em uso|ocupad/i.test(last.message)) throw last;
      }
    }
    throw last ?? new Error("nenhuma porta livre entre 7788 e 7798");
  }

  return {
    async call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
      if (name === "doctor") {
        const lines = await deps.doctor();
        return { ok: lines.every((l) => l.ok), lines };
      }
      if (name === "configure_provider") {
        const preset = String(args.preset ?? "");
        if (!isProviderName(preset)) {
          throw new Error(`preset inválido: ${preset || "(vazio)"}`);
        }
        const projectDir = resolve(String(args.projectDir ?? deps.cwd()));
        const creds: Credentials = { preset };
        if (typeof args.model === "string" && args.model) creds.model = args.model;
        if (typeof args.baseUrl === "string" && args.baseUrl) creds.baseUrl = args.baseUrl;
        if (typeof args.apiKey === "string" && args.apiKey) creds.apiKey = args.apiKey;
        const path = await deps.writeCredentials(projectDir, creds);
        return { preset, model: creds.model, baseUrl: creds.baseUrl, path, hasKey: Boolean(creds.apiKey) };
      }
      if (name === "status") {
        if (!running) return { running: false };
        return { running: true, url: running.url, port: running.port, mode: running.mode };
      }
      if (name === "stop") {
        if (running) {
          await running.close();
          running = null;
        }
        return { running: false };
      }
      if (name === "start") {
        if (running) {
          return { url: running.url, port: running.port, mode: running.mode, reused: true };
        }
        const mode = args.mode === "montar" ? "montar" : args.mode === "limpar" ? "limpar" : "";
        if (!mode) throw new Error("start precisa de mode limpar ou montar");
        const preferred = typeof args.port === "number" ? args.port : 7788;
        if (mode === "limpar") {
          const input = String(args.input ?? "");
          if (!input) throw new Error("limpar precisa de input");
          const app = await startOnPort({
            input,
            allowPaidModel: args.allowPaidModel === true,
            allowPaidVisual: args.allowPaidVisual === true,
          }, preferred);
          running = {
            url: `http://127.0.0.1:${app.port}`,
            port: app.port,
            mode,
            close: () => app.close(),
          };
        } else {
          const project = String(args.project ?? "");
          if (!project) throw new Error("montar precisa de project");
          const app = await startOnPort({
            projectDir: resolve(project),
            allowPaidModel: args.allowPaidModel === true,
            allowPaidVisual: args.allowPaidVisual === true,
          }, preferred);
          running = {
            url: `http://127.0.0.1:${app.port}`,
            port: app.port,
            mode,
            projectDir: resolve(project),
            close: () => app.close(),
          };
        }
        return { url: running.url, port: running.port, mode: running.mode, reused: false };
      }
      throw new Error(`ferramenta desconhecida: ${name}`);
    },
  };
}

export type McpSession = ReturnType<typeof createMcpSession>;
