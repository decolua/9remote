// MCP over the agent's own HTTP server — JSON-RPC on a single POST route, so the
// AI CLI talks to the already-running agent instead of spawning a child process.
// Surface is deliberately tiny: initialize / tools/list / tools/call / ping.
// Tools live in ./tools; this file knows the protocol, not what any tool does.
// Handlers are async because the Jarvis tools ride the daemon's IPC.
import { MCP } from "../lib/constants.js";
import { TOOL_BY_NAME, toolManifest } from "./tools/index.js";

const text = (message, isError = false) => ({ content: [{ type: "text", text: message }], isError });

async function callTool(name, args, ctx) {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) return text(`Unknown tool: ${name}`, true);
  try {
    const result = await tool.run(args || {}, ctx || {});
    if (result?.error) return text(result.error, true);
    // Tools return strings (JSON/text) or plain objects — an object stringified
    // with String() is "[object Object]", and the model loses the sessionId it
    // just created. Objects go over as JSON.
    return text(typeof result === "string" ? result : JSON.stringify(result));
  } catch (e) {
    return text(e.message, true);
  }
}

// Returns the JSON-RPC response object, or null for a notification (no id → no reply).
// ctx carries who is calling (see callerSession.js) — tools that act on a terminal need it.
export async function handleRpc(msg, ctx) {
  const { id, method, params } = msg || {};
  const reply = (result) => ({ jsonrpc: "2.0", id, result });

  if (method === "initialize") {
    return reply({
      protocolVersion: params?.protocolVersion || MCP.PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: MCP.SERVER_NAME, version: typeof __CLI_VERSION__ !== "undefined" ? __CLI_VERSION__ : "1.0.0" },
    });
  }
  if (method === "tools/list") {
    return reply({ tools: toolManifest() });
  }
  if (method === "tools/call") return reply(await callTool(params?.name, params?.arguments, ctx));
  if (method === "ping") return reply({});
  if (id == null) return null;
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
}
