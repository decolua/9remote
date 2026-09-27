// Which terminal made this MCP call. The daemon stamps NINE_REMOTE_SESSION_ID into every
// PTY's env, so the answer is already sitting in the calling process — the job is only to
// read it back out. Two ways in, most reliable first.
import fs from "fs";
import { execFileSync } from "child_process";
import { createLogger } from "../../lib/logger.js";
import { CALLER_SESSION } from "./constants.js";

const logger = createLogger("artifact");
const ENV_RE = /(?:^|[\s\0])NINE_REMOTE_SESSION_ID=([^\s\0]+)/;

// One socket carries one CLI's whole session — resolving it per request would run lsof
// on every tool call. WeakMap so a closed connection drops its entry on its own.
const bySocket = new WeakMap();

const run = (cmd, args) =>
  execFileSync(cmd, args, { encoding: "utf8", timeout: CALLER_SESSION.PROBE_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] });

// The peer of a loopback TCP connection, found by its port. lsof -F prints one field per
// line: "p<pid>" opens a process block, "n<local>-><remote>" is the connection under it.
function pidFromPort(port, selfPid) {
  const out = run("lsof", ["-nP", `-iTCP:${port}`, "-Fpn"]);
  let pid = null;
  for (const line of out.split("\n")) {
    if (line[0] === "p") pid = parseInt(line.slice(1), 10);
    else if (line[0] === "n" && pid && pid !== selfPid) {
      const m = line.match(/^n(?:\[[^\]]+\]|[^:]+):(\d+)->/);
      if (m && Number(m[1]) === port) return pid;
    }
  }
  return null;
}

// Reading another process's environment: /proc on Linux, ps -E on macOS. Both only work
// for processes owned by this user, which is exactly the set we care about.
function envSessionOf(pid) {
  try {
    if (process.platform === "linux") {
      return fs.readFileSync(`/proc/${pid}/environ`, "utf8").match(ENV_RE)?.[1] || null;
    }
    return run("ps", ["-Eww", "-o", "command=", "-p", String(pid)]).match(ENV_RE)?.[1] || null;
  } catch { return null; }
}

function parentOf(pid) {
  try {
    if (process.platform === "linux") {
      // stat's comm field can hold spaces and parens — ppid is the field after the last ")"
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      return parseInt(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1], 10) || null;
    }
    return parseInt(run("ps", ["-o", "ppid=", "-p", String(pid)]).trim(), 10) || null;
  } catch { return null; }
}

// The CLI may call through a wrapper (npx, a shell, a sandbox), so walk up until the env
// var shows up — macOS hides the environment of system binaries like /usr/bin/curl, and a
// wrapper's own env is the next best answer. Bounded, or an unrelated caller would walk
// all the way to init. Stops at this process: the agent may itself be running inside a
// terminal, and its session id would be a confident wrong answer.
function walkToSession(pid) {
  for (let hop = 0; pid > 1 && pid !== process.pid && hop < CALLER_SESSION.MAX_PARENT_HOPS; hop++) {
    const found = envSessionOf(pid);
    if (found) return found;
    pid = parentOf(pid);
    if (!pid) return null;
  }
  return null;
}

// Header first: a CLI that expands env vars in its MCP config hands the id over directly,
// with no process probing at all. Codex supports this natively (env_http_headers); the
// others are best-effort, which is why the probe stays as the fallback.
export function resolveCallerSession(req) {
  const header = req?.headers?.[CALLER_SESSION.HEADER];
  // An unexpanded placeholder ("${VAR}", "{env:VAR}") means the CLI did not substitute it
  if (header && !/[${}]/.test(header)) return header;

  const socket = req?.socket;
  if (!socket) return null;
  if (bySocket.has(socket)) return bySocket.get(socket);

  let sessionId = null;
  try {
    const pid = pidFromPort(socket.remotePort, process.pid);
    if (pid) sessionId = walkToSession(pid);
  } catch (e) {
    logger.warn(`caller probe failed: ${e.message}`);
  }
  bySocket.set(socket, sessionId);
  return sessionId;
}
