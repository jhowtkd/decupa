import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeCredentials } from "@decupa/triage";
import { createMcpSession } from "./tools.ts";
import { dispatch } from "./dispatch.ts";
import { encodeFrame, FrameParser } from "./protocol.ts";

describe("protocol frames", () => {
  it("empacota e lê Content-Length", () => {
    const frame = encodeFrame({ jsonrpc: "2.0", id: 1, method: "ping" });
    const parser = new FrameParser();
    const messages = parser.push(frame);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.method).toBe("ping");
  });
});

describe("MCP tools", () => {
  function session() {
    let _closed = false;
    return createMcpSession({
      doctor: async () => [{ ok: true, name: "node", detail: "22" }],
      startApp: async (opts) => ({
        port: opts.port ?? 7788,
        close: async () => { _closed = true; },
      }),
      writeCredentials,
      cwd: () => process.cwd(),
    });
  }

  it("doctor devolve linhas", async () => {
    const result = await session().call("doctor") as { ok: boolean; lines: { name: string }[] };
    expect(result.ok).toBe(true);
    expect(result.lines[0]!.name).toBe("node");
  });

  it("start limpar devolve URL sem abrir navegador", async () => {
    const s = session();
    const started = await s.call("start", { mode: "limpar", input: "/tmp/a.mp4" }) as {
      url: string; port: number; mode: string; reused: boolean;
    };
    expect(started.url).toBe("http://127.0.0.1:7788");
    expect(started.mode).toBe("limpar");
    expect(started.reused).toBe(false);
    const again = await s.call("start", { mode: "limpar", input: "/tmp/b.mp4" }) as { reused: boolean };
    expect(again.reused).toBe(true);
    await s.call("stop");
    const status = await s.call("status") as { running: boolean };
    expect(status.running).toBe(false);
  });

  it("start montar exige project", async () => {
    await expect(session().call("start", { mode: "montar" })).rejects.toThrow(/project/);
  });

  it("configure_provider grava em .decupa e não devolve a chave", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-mcp-"));
    const result = await session().call("configure_provider", {
      preset: "gemini",
      apiKey: "segredo",
      projectDir: dir,
    }) as { preset: string; hasKey: boolean; path: string };
    expect(result.preset).toBe("gemini");
    expect(result.hasKey).toBe(true);
    expect(JSON.stringify(result)).not.toContain("segredo");
  });

  it("dispatch initialize e tools/list", async () => {
    const s = session();
    const init = await dispatch({ jsonrpc: "2.0", id: 1, method: "initialize" }, s);
    expect(init?.result).toMatchObject({ serverInfo: { name: "decupa" } });
    const list = await dispatch({ jsonrpc: "2.0", id: 2, method: "tools/list" }, s);
    const tools = (list!.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(tools).toEqual(["doctor", "configure_provider", "start", "status", "stop"]);
  });
});
