// Locate, launch and health-check the 9remote agent.
//
// Electron ships its own Node, so ELECTRON_RUN_AS_NODE runs cli.cjs directly —
// no system Node hunt, no npm install, none of the PATH problems a Finder-launched
// GUI has with nvm/fnm/volta.

import { spawn } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { app } from "electron";
import {
  SERVER_PORT, NPM_PREFIX_DIR, NPM_PACKAGE, CLI_REL_PATH,
  HEALTH_TIMEOUT_MS, HEALTH_POLL_MS, GLOBAL_NODE_MODULES,
} from "./constants.js";

let agentChild = null;

// Bundled copy shipped inside the .app (extraResources), then any user install.
function cliCandidates() {
  const home = homedir();
  return [
    join(process.resourcesPath || "", "agent", "dist", "cli.cjs"),
    join(home, NPM_PREFIX_DIR, CLI_REL_PATH),
    ...GLOBAL_NODE_MODULES.map((root) => join(root, NPM_PACKAGE, "dist", "cli.cjs")),
    join(home, ".volta/tools/image/packages", NPM_PACKAGE, "lib/node_modules", NPM_PACKAGE, "dist", "cli.cjs"),
  ];
}

export function findCli() {
  return cliCandidates().find((p) => p && existsSync(p)) || null;
}

// Spawn the agent as a detached group so one signal takes down server + cloudflared.
export function startAgent(onLog) {
  const cli = findCli();
  if (!cli) return { error: "9remote agent not found in this build." };

  agentChild = spawn(process.execPath, [cli, "ui", "--start"], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  agentChild.stdout?.on("data", (b) => onLog?.(`[9remote] ${b.toString().trimEnd()}`));
  agentChild.stderr?.on("data", (b) => onLog?.(`[9remote.err] ${b.toString().trimEnd()}`));
  agentChild.on("error", (e) => onLog?.(`[9remote] spawn failed: ${e.message}`));

  return { cli };
}

// Kill the whole process group; the agent leaks cloudflared otherwise.
export function stopAgent() {
  if (!agentChild?.pid) return;
  const { pid } = agentChild;
  agentChild = null;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/F", "/T", "/PID", String(pid)]);
    else process.kill(-pid, "SIGTERM");
  } catch {
    // Already gone — nothing to clean up.
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resolves true once the URL answers, false on timeout.
export async function waitForUrl(url, onTick) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // Server not listening yet — keep polling until the deadline.
    }
    onTick?.(Date.now() - (deadline - HEALTH_TIMEOUT_MS));
    await sleep(HEALTH_POLL_MS);
  }
  return false;
}

export const waitForHealth = (onTick) =>
  waitForUrl(`http://localhost:${SERVER_PORT}/api/health`, onTick);

app.on("before-quit", stopAgent);
