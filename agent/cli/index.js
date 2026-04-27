#!/usr/bin/env node

import { initLogger } from "../lib/logger.js";
import { stopRunningInstances } from "./utils/updateChecker.js";
import { startUiMode } from "./modes/ui.js";
import { startTrayMode } from "./modes/tray.js";
import { autoStartDev } from "./modes/auto.js";
import { startupMenu } from "./modes/startup.js";

initLogger();

async function start() {
  const command = process.argv[2];

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
  } else {
    await startupMenu();
  }
}

start().catch(console.error);
