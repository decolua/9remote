import chalk from "chalk";
import { loadState, clearState } from "../utils/state.js";
import { killCloudflared } from "../cloudflared.js";

const WORKER_URL = process.env.WORKER_URL || "https://9remote-worker.YOUR_SUBDOMAIN.workers.dev";

export default async function stop() {
  const state = loadState();
  
  if (!state) {
    console.log(chalk.yellow("No active session found"));
    return;
  }
  
  try {
    console.log(chalk.cyan("Stopping session..."));
    
    // 1. Delete session via Worker
    await fetch(`${WORKER_URL}/api/session/delete`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: state.apiKey })
    });
    
    // 2. Kill cloudflared
    killCloudflared();
    
    // 3. Clear state
    clearState();
    
    console.log(chalk.green("✅ Session stopped"));
    
  } catch (error) {
    console.error(chalk.red("Error stopping session:"), error.message);
  }
}
