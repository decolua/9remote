#!/usr/bin/env node

import "../lib/loadEnv.js";
import { getVersion } from "./session/key.js";
import { initLogger } from "../lib/logger.js";
import { stopRunningInstances } from "./utils/updateChecker.js";
import { startUiMode } from "./modes/ui.js";
import { startTrayMode } from "./modes/tray.js";
import { autoStartDev } from "./modes/auto.js";
import { startupMenu } from "./modes/startup.js";
import { runHeadlessCommand, printHelp } from "./modes/headless.js";

// Print version early and exit clean (no logger/TUI ANSI) so update scripts can parse it
const _vcmd = process.argv[2];
if (_vcmd === "version" || _vcmd === "--version" || _vcmd === "-v") {
  process.stdout.write(getVersion() + "\n");
  process.exit(0);
}

initLogger();

async function start() {
  const command = process.argv[2];

  // Headless commands (key/otk/devices/...) drive the running server via API; no TTY needed
  if (await runHeadlessCommand(process.argv)) return;

  // Skip self-kill when re-entering via --tray/--auto/--start (child of launchBackground),
  // otherwise the detached child reads its own PID from agent.pid and kills itself
  const isChildRespawn = process.argv.includes("--tray") || process.argv.includes("--auto") || process.argv.includes("--start");
  if (!isChildRespawn) stopRunningInstances();

  if (command === "ui") {
    await startUiMode();
  } else if (command === "start" || process.argv.includes("--auto")) {
    await autoStartDev();
  } else if (process.argv.includes("--tray") || process.argv.includes("--start")) {
    await startTrayMode();
  } else if (!process.stdin.isTTY) {
    // No interactive terminal (SSH/server): TUI menu would break, show help instead
    printHelp();
  } else {
    await startupMenu();
  }
}

start().catch(console.error);
