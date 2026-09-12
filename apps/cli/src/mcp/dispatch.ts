import type { JsonRpc } from "./protocol.ts";
import { rpcError, rpcResult } from "./protocol.ts";
import { toolList, type McpSession } from "./tools.ts";

export async function dispatch(message: JsonRpc, session: McpSession): Promise<JsonRpc | null> {
  if (message.method === undefined) return null;
  if (message.id === undefined || message.id === null) return null;
  const id = message.id;
  try {
    if (message.method === "initialize") {
      return rpcResult(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "decupa", version: "1" },
      });
    }
    if (message.method === "tools/list") {
      return rpcResult(id, { tools: toolList() });
    }
    if (message.method === "tools/call") {
      const params = (message.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      const name = String(params.name ?? "");
      const result = await session.call(name, params.arguments ?? {});
      return rpcResult(id, {
        content: [{ type: "text", text: JSON.stringify(result) }],
      });
    }
    if (message.method === "ping") {
      return rpcResult(id, {});
    }
    return rpcError(id, `método desconhecido: ${message.method}`, -32601);
  } catch (err) {
    return rpcError(id, err instanceof Error ? err.message : String(err));
  }
}
