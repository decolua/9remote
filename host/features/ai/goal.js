// Codex keeps a thread's goal (the TUI's `/goal`) in its own state DB, reachable only
// through its app-server JSON-RPC. The process exits as soon as the response lands, so
// this is one short-lived spawn per read rather than a daemon held open.
import { spawn } from "node:child_process";
import { getExtendedEnv } from "./adapters/env.js";

const GOAL_TIMEOUT_MS = 5000;
const CLIENT_INFO = { name: "9remote", title: "9Remote", version: "1.0.0" };

/** The thread's active goal, or null when it has none. Never throws. */
export function readThreadGoal(threadId, cwd) {
  if (!threadId || typeof threadId !== "string") return Promise.resolve(null);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("codex", ["app-server"], { cwd, env: getExtendedEnv(), stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      return resolve(null);
    }

    let buffer = "";
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => done(null), GOAL_TIMEOUT_MS);

    const send = (msg) => {
      try { child.stdin.write(JSON.stringify(msg) + "\n"); } catch { done(null); }
    };

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          send({ jsonrpc: "2.0", method: "initialized", params: {} });
          send({ jsonrpc: "2.0", id: 2, method: "thread/goal/get", params: { threadId } });
        } else if (msg.id === 2) {
          done(msg.result?.goal || null);
        }
      }
    });

    child.on("error", () => done(null));
    child.on("close", () => done(null));
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: CLIENT_INFO } });
  });
}
