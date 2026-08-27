// MCP over the agent's own HTTP server — JSON-RPC on a single POST route, so the
// AI CLI talks to the already-running agent instead of spawning a child process.
// Surface is deliberately tiny: initialize / tools/list / tools/call / ping.
// Tools live in ./tools; this file knows the protocol, not what any tool does.
import { MCP } from "../lib/constants.js";
import { TOOL_BY_NAME, toolManifest } from "./tools/index.js";

const text = (message, isError = false) => ({ content: [{ type: "text", text: message }], isError });

function callTool(name, args, ctx) {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) return text(`Unknown tool: ${name}`, true);
  try {
    const result = tool.run(args || {}, ctx || {});
    return result?.error ? text(result.error, true) : text(String(result));
  } catch (e) {
    return text(e.message, true);
  }
}

// Returns the JSON-RPC response object, or null for a notification (no id → no reply).
// ctx carries who is calling (see callerSession.js) — tools that act on a terminal need it.
export function handleRpc(msg, ctx) {
  const { id, method, params } = msg || {};
  const reply = (result) => ({ jsonrpc: "2.0", id, result });

  if (method === "initialize") {
    return reply({
      protocolVersion: params?.protocolVersion || MCP.PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: MCP.SERVER_NAME, version: typeof __CLI_VERSION__ !== "undefined" ? __CLI_VERSION__ : "1.0.0" },
    });
  }
  if (method === "tools/list") return reply({ tools: toolManifest() });
  if (method === "tools/call") return reply(callTool(params?.name, params?.arguments, ctx));
  if (method === "ping") return reply({});
  if (id == null) return null;
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
}
