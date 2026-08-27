/**
 * MCP endpoint (localhost-only, bearer-authed) — JSON-RPC in, JSON-RPC out.
 * The router's own guards already refuse tunnel/non-loopback/rebound-host callers;
 * the token stops any other local process from driving the user's panel.
 */

import { jsonErr, parseJsonBody } from "../lib/router.js";
import { verifyMcpToken } from "../lib/mcpToken.js";
import { isMcpEnabled } from "../mcp/mcpConfig.js";
import { handleRpc } from "../mcp/mcpServer.js";
import { resolveCallerSession } from "../features/artifact/callerSession.js";

export async function handleMcpPost(req, res) {
  if (!verifyMcpToken(req.headers.authorization)) return jsonErr(res, 401, "Unauthorized");
  // The switch has to hold here, not only in the CLI config files it rewrites: a CLI
  // that was already running loaded its tools at launch and would keep calling them.
  if (!isMcpEnabled()) return jsonErr(res, 403, "MCP is turned off in 9Remote settings");

  // parseJsonBody has already answered on malformed JSON; a body that parses to a
  // non-object ("null", "3") has not, and returning here would hang the request.
  const msg = await parseJsonBody(req, res);
  if (msg === null && !res.writableEnded) return jsonErr(res, 400, "Invalid request");
  if (res.writableEnded) return;

  let response;
  try {
    response = handleRpc(msg, { sessionId: resolveCallerSession(req) });
  } catch (e) {
    // An MCP client reads a JSON-RPC error; a bare 500 just reads as the server dying
    response = { jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32603, message: e.message } };
  }
  // A notification gets no body, only an ack
  if (!response) { res.writeHead(202); return res.end(); }
  res.setHeader("Content-Type", "application/json");
  res.writeHead(200);
  res.end(JSON.stringify(response));
}
