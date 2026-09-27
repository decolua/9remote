/**
 * PTY session list/delete handlers (localhost-only)
 */

import * as daemonClient from "../features/terminal/ptyDaemonClient.js";
import { jsonOk, jsonErr, parseJsonBody } from "../lib/router.js";

export async function handleSessionsList(req, res) {
  try {
    const sessions = await daemonClient.listSessions();
    jsonOk(res, { sessions });
  } catch (e) {
    jsonErr(res, 500, e.message);
  }
}

export async function handleSessionDelete(req, res) {
  const data = await parseJsonBody(req, res);
  if (!data) return;
  if (!data.sessionId) return jsonErr(res, 400, "sessionId required");
  try {
    await daemonClient.deleteSession(data.sessionId);
    jsonOk(res);
  } catch (e) {
    jsonErr(res, 500, e.message);
  }
}
