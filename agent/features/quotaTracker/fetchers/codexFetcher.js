// Codex quota (ChatGPT plan): spawn `codex app-server` and read rate limits over
// newline-delimited JSON-RPC. Gated on ~/.codex/auth.json so users who never
// signed in never see a background codex process spawn.
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  CODEX_RPC_ARGS,
  CODEX_RPC_INIT_TIMEOUT_MS,
  CODEX_RPC_TIMEOUT_MS,
  CODEX_WINDOW_TOLERANCE_MINUTES,
  SESSION_WINDOW_MINUTES,
  WEEKLY_WINDOW_MINUTES
} from "../constants.js";
import { clampPercent, makeResult } from "../lib/quotaWindow.js";

function codexHome() {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

function mapWindow(raw, expectedMinutes) {
  if (!raw || typeof raw.usedPercent !== "number" || !Number.isFinite(raw.usedPercent)) return null;
  const resetsAt = typeof raw.resetsAt === "number" && raw.resetsAt > 0 ? raw.resetsAt * 1000 : null;
  return {
    usedPercent: clampPercent(raw.usedPercent),
    windowMinutes: expectedMinutes,
    resetsAt
  };
}

// Classify primary/secondary by window duration; fall back to the legacy
// primary=session / secondary=weekly mapping when the duration is unknown.
function classifyWindows(result) {
  const primary = result?.primary ?? null;
  const secondary = result?.secondary ?? null;
  const isSession = (w) => Math.abs((w?.windowDurationMins ?? -1) - SESSION_WINDOW_MINUTES)
    <= CODEX_WINDOW_TOLERANCE_MINUTES;
  const isWeekly = (w) => Math.abs((w?.windowDurationMins ?? -1) - WEEKLY_WINDOW_MINUTES)
    <= CODEX_WINDOW_TOLERANCE_MINUTES;

  let session = isSession(primary) ? primary : null;
  let weekly = isWeekly(secondary) ? secondary : null;
  if (!session && primary && !isWeekly(primary)) session = primary;
  if (!weekly && secondary && !isSession(secondary)) weekly = secondary;
  return { session, weekly };
}

async function fetchViaRpc() {
  return new Promise((resolve) => {
    let buffer = "";
    let resolved = false;
    let rateLimitsId = null;
    let timer = null;
    let child;

    const settle = (result, kill = true) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (kill && child && child.exitCode === null) {
        child.removeAllListeners();
        child.kill();
      }
      resolve(result);
    };
    const armDeadline = (ms) => {
      clearTimeout(timer);
      timer = setTimeout(() => settle(makeResult("codex", "error", "Codex RPC timeout")), ms);
    };

    try {
      child = spawn("codex", CODEX_RPC_ARGS, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, CODEX_HOME: codexHome() }
      });
    } catch (e) {
      return resolve(makeResult("codex", "error", e.message));
    }

    const sendRpc = (id, method, params = {}) =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    // EPIPE arrives on the stdin stream (not the child) when the server dies
    // mid-write — without a listener it's an uncaught exception.
    child.stdin.on("error", () => settle(makeResult("codex", "error", "Codex app-server closed unexpectedly")));

    child.stderr.on("data", () => {}); // drain orca-style diagnostics noise
    child.on("error", (e) => {
      const msg = e.code === "ENOENT" ? "codex CLI not found" : e.message;
      settle(makeResult("codex", "unavailable", msg), false);
    });
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id == null) continue; // server notification

        if (msg.id === 1) {
          // initialize answered — the boot budget ends here, arm the read deadline.
          armDeadline(CODEX_RPC_TIMEOUT_MS);
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
          rateLimitsId = 2;
          sendRpc(rateLimitsId, "account/rateLimits/read");
          continue;
        }
        if (msg.id === rateLimitsId) {
          if (msg.error) {
            settle(makeResult("codex", "error", msg.error.message));
            return;
          }
          const { session, weekly } = classifyWindows(msg.result?.rateLimits);
          settle(makeResult("codex", "ok", null, {
            session: mapWindow(session, SESSION_WINDOW_MINUTES),
            weekly: mapWindow(weekly, WEEKLY_WINDOW_MINUTES)
          }));
        }
      }
    });
    child.on("close", () => {
      if (!resolved) settle(makeResult("codex", "error", "Codex app-server exited unexpectedly"), false);
    });

    armDeadline(CODEX_RPC_INIT_TIMEOUT_MS);
    // clientInfo is required — an empty-params initialize gets rejected and every
    // later method fails with "Not initialized".
    sendRpc(1, "initialize", { clientInfo: { name: "9remote", version: "1.0.0" } });
  });
}

export async function fetchCodexQuota() {
  try {
    await access(join(codexHome(), "auth.json"));
  } catch {
    return makeResult("codex", "unavailable", "Not signed in to Codex");
  }
  return fetchViaRpc();
}
