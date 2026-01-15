import chalk from "chalk";
import { loadState } from "../utils/state.js";

export default function list() {
  const state = loadState();
  
  if (!state) {
    console.log(chalk.yellow("No active sessions"));
    return;
  }
  
  console.log(chalk.cyan("\n📋 Active Sessions:\n"));
  console.log(chalk.white(`  Tunnel ID: ${state.tunnelId}`));
  console.log(chalk.white(`  API Key:   ${state.apiKey}`));
  console.log(chalk.white(`  PID:       ${state.pid}`));
  console.log("");
}
