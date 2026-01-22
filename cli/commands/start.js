import chalk from "chalk";
import ora from "ora";
import { spawn } from "child_process";
import { getConsistentMachineId } from "../utils/machineId.js";
import { generateApiKeyWithMachine } from "../utils/apiKey.js";
import { saveState } from "../utils/state.js";
import { spawnCloudflared } from "../cloudflared.js";

const WORKER_URL = process.env.WORKER_URL || "https://remote.9router.com";

export default async function start(options) {
  const spinner = ora("Starting 9Remote Terminal...").start();
  
  try {
    // 1. Get or use API key
    let apiKey = options.key;
    let machineId;
    
    if (!apiKey) {
      spinner.text = "Generating machine ID...";
      machineId = await getConsistentMachineId();
      
      spinner.text = "Generating API key...";
      const keyData = generateApiKeyWithMachine(machineId);
      apiKey = keyData.key;
    }
    
    // 2. Create session via Worker
    spinner.text = "Creating tunnel...";
    const response = await fetch(`${WORKER_URL}/api/session/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ machineId, apiKey })
    });
    
    if (!response.ok) {
      throw new Error(`Failed to create session: ${response.statusText}`);
    }
    
    const { tunnelId, tunnelToken } = await response.json();
    
    // 3. Start cloudflared
    spinner.text = "Starting cloudflared...";
    const cloudflaredProcess = await spawnCloudflared(tunnelToken);
    
    // 4. Start Next.js server
    spinner.text = "Starting server...";
    const serverProcess = spawn("npm", ["run", "dev"], {
      cwd: process.cwd(),
      stdio: "inherit",
      detached: false
    });
    
    // 5. Save state
    saveState({
      apiKey,
      tunnelId,
      pid: cloudflaredProcess.pid
    });
    
    spinner.succeed("9Remote Terminal Started!");
    
    console.log("");
    console.log(chalk.green("✨ 9Remote Terminal Started!"));
    console.log("");
    console.log(chalk.cyan("🔑 Access Key:"), chalk.bold(apiKey));
    console.log("");
    console.log(chalk.cyan("📱 Access from anywhere:"));
    console.log(chalk.white("   1. Go to: https://9remote.com"));
    console.log(chalk.white("   2. Enter your access key"));
    console.log(chalk.white("   3. Start coding!"));
    console.log("");
    console.log(chalk.yellow("⏱️  Auto-cleanup in 4 hours"));
    console.log(chalk.gray("Press Ctrl+C to stop"));
    console.log("");
    
    // Handle Ctrl+C
    process.on("SIGINT", async () => {
      console.log("\n\nStopping...");
      cloudflaredProcess.kill();
      serverProcess.kill();
      process.exit(0);
    });
    
  } catch (error) {
    spinner.fail("Failed to start");
    console.error(chalk.red(error.message));
    process.exit(1);
  }
}
