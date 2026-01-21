#!/usr/bin/env node

import inquirer from "inquirer";
import chalk from "chalk";
import qrcode from "qrcode-terminal";
import { spawn, execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { bin, install } from "cloudflared";
import fs from "fs";
import { Resolver } from "dns/promises";
import { getConsistentMachineId } from "./utils/machineId.js";
import { generateApiKeyWithMachine } from "./utils/apiKey.js";
import { loadKey, saveKey, saveState, clearState } from "./utils/state.js";
import { createTempKey } from "./utils/token.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const WORKER_URL = "https://9remote-worker.decoluadt.workers.dev";
const SERVER_PORT = 3000;
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_WINDOW_MS = 60000; // 1 minute

/**
 * Helper: Show QR code for connect URL
 */
function showQRCode(url, title = "📱 Scan QR to connect:") {
  console.log(chalk.cyan(`\n${title}`));
  qrcode.generate(url, {
    small: true,
    type: 'terminal',
    margin: 0,
  }, qr => {
    const lines = qr.trim().split('\n');
    console.log(lines.join('\n'));
  });
}

/**
 * Helper: Show connection info
 */
async function showConnectionInfo(selectedKey, tunnelUrl) {
  console.log(chalk.cyan("🔑 Creating temp key..."));
  
  const tempKeyData = await createTempKey(selectedKey, WORKER_URL);
  
  if (!tempKeyData) {
    console.log(chalk.red("❌ Failed to create temp key"));
    return;
  }

  const connectUrl = `${WORKER_URL}/login?k=${tempKeyData.tempKey}`;

  showQRCode(connectUrl);

  console.log(chalk.white(`\nApp URL: ${chalk.blue(WORKER_URL)}`));
  console.log(chalk.white(`Temp Key: ${chalk.yellow(tempKeyData.tempKey)}`));
  console.log(chalk.gray(`Expires in 30 minutes (one-time use)`));
  console.log(chalk.gray("\nPress Ctrl+C to stop server\n"));
}

/**
 * Kill process on specific port
 */
function killProcessOnPort(port) {
  try {
    if (process.platform === "win32") {
      execSync(`for /f "tokens=5" %a in ('netstat -aon ^| findstr :${port}') do taskkill /F /PID %a`, { stdio: "ignore" });
    } else {
      execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, { stdio: "ignore" });
    }
  } catch { }
}

/**
 * Start server with auto-restart on crash
 */
function startServerWithRestart(onReady) {
  const restartTimes = [];
  let currentProcess = null;
  let isShuttingDown = false;

  const spawnServer = () => {
    // Kill any existing process on port
    killProcessOnPort(SERVER_PORT);

    currentProcess = spawn("node", ["server.js"], {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "inherit", "inherit"],
      detached: false
    });

    currentProcess.on("exit", (code, signal) => {
      if (isShuttingDown) return;

      // Check if it's a crash (non-zero exit code or unexpected signal)
      if (code !== 0 || signal) {
        console.log(chalk.red(`\n💥 Server crashed (code: ${code}, signal: ${signal})`));

        // Check restart limit
        const now = Date.now();
        restartTimes.push(now);
        
        // Remove old restart times outside window
        while (restartTimes.length > 0 && restartTimes[0] < now - RESTART_WINDOW_MS) {
          restartTimes.shift();
        }

        if (restartTimes.length > MAX_RESTART_ATTEMPTS) {
          console.log(chalk.red(`❌ Too many restarts (${MAX_RESTART_ATTEMPTS} in ${RESTART_WINDOW_MS / 1000}s). Giving up.`));
          process.exit(1);
        }

        console.log(chalk.yellow(`🔄 Restarting server... (attempt ${restartTimes.length}/${MAX_RESTART_ATTEMPTS})`));
        
        // Wait a bit before restart
        setTimeout(() => {
          spawnServer();
        }, 1000);
      }
    });

    currentProcess.on("error", (err) => {
      console.log(chalk.red(`❌ Server error: ${err.message}`));
    });

    if (onReady) {
      onReady(currentProcess);
    }
  };

  spawnServer();

  return {
    getProcess: () => currentProcess,
    shutdown: () => {
      isShuttingDown = true;
      if (currentProcess) {
        currentProcess.kill();
      }
    }
  };
}

/**
 * Helper: Setup exit handler for server processes
 */
function setupExitHandler(serverManager, tunnelProcess) {
  process.on("SIGINT", () => {
    console.log(chalk.yellow("\n\n🛑 Stopping server..."));
    serverManager.shutdown();
    tunnelProcess.kill();
    clearState();
    console.log(chalk.green("✅ Server stopped"));
    process.exit(0);
  });
}

/**
 * Helper: Start server and tunnel
 */
async function startServerAndTunnel(selectedKey) {
  console.log(chalk.cyan("\n🚀 Starting server..."));

  // Kill existing processes
  try {
    execSync("pkill -f 'node server.js' 2>/dev/null || true", { stdio: "ignore" });
    execSync("pkill -f cloudflared 2>/dev/null || true", { stdio: "ignore" });
  } catch { }

  // Cleanup old cloudflared tunnels
  cleanupOldTunnels();

  // Start server with auto-restart
  const serverManager = startServerWithRestart();

  // Wait for server to start
  await new Promise((resolve) => setTimeout(resolve, 3000));

  console.log(chalk.cyan("🌐 Starting tunnel..."));

  // Ensure cloudflared binary is installed
  if (!fs.existsSync(bin)) {
    console.log(chalk.yellow("📥 Installing cloudflared..."));
    await install(bin);
  }

  // Start Quick Tunnel
  let tunnelUrl = null;
  const tunnelProcess = spawn(bin, ["tunnel", "--url", "http://localhost:3000"], {
    stdio: ["ignore", "pipe", "pipe"]
  });

  // Parse tunnel URL from stderr
  try {
    tunnelUrl = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timeout waiting for tunnel URL")), 30000);

      tunnelProcess.stderr.on("data", (data) => {
        const output = data.toString();
        const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match) {
          clearTimeout(timeout);
          resolve(match[0]);
        }
      });

      tunnelProcess.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      tunnelProcess.on("close", (code) => {
        if (code !== 0 && !tunnelUrl) {
          clearTimeout(timeout);
          reject(new Error(`Tunnel exited with code ${code}`));
        }
      });
    });
  } catch (error) {
    console.log(chalk.red(`❌ Failed to start tunnel: ${error.message}`));
    serverManager.shutdown();
    tunnelProcess.kill();
    return null;
  }

  if (!tunnelUrl) {
    console.log(chalk.red("❌ Failed to get tunnel URL"));
    serverManager.shutdown();
    tunnelProcess.kill();
    return null;
  }

  console.log(chalk.green(`✅ Tunnel URL: ${tunnelUrl}`));

  // Verify tunnel is connected to server
  const maxWaitTime = 120000; // 1 minute
  const checkInterval = 1000; // 2 seconds
  const maxRetries = Math.floor(maxWaitTime / checkInterval);
  let tunnelReady = false;
  
  console.log(chalk.cyan("🔗 Verifying tunnel connection..."));
  process.stdout.write(chalk.cyan("   Checking"));
  
  // Use Cloudflare DNS resolver to avoid system DNS cache issues
  const resolver = new Resolver();
  resolver.setServers(["1.1.1.1", "1.0.0.1"]);
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      // Force DNS lookup with Cloudflare DNS
      const hostname = new URL(tunnelUrl).hostname;
      await resolver.resolve4(hostname);

      const healthRes = await fetch(`${tunnelUrl}/api/health`, { 
        signal: AbortSignal.timeout(5000) 
      });
      if (healthRes.ok) {
        tunnelReady = true;
        break;
      }
    } catch(error) {
      // Retry
    }
    
    // Animated spinner
    const spinners = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    process.stdout.write(`\r${chalk.cyan("🔗 Waiting for tunnel")} ${chalk.yellow(spinners[i % spinners.length])} ${chalk.gray(`(${i}s)`)}`);
    
    await new Promise(r => setTimeout(r, checkInterval));
  }
  
  // Clear line and show result
  process.stdout.write("\r" + " ".repeat(50) + "\r");
  
  if (!tunnelReady) {
    console.log(chalk.red("❌ Tunnel connection timeout (60s)"));
    serverManager.shutdown();
    tunnelProcess.kill();
    return null;
  }
  
  console.log(chalk.green(`✅ Tunnel ready: ${tunnelUrl}`));

  // Sync with worker
  console.log(chalk.cyan("🔄 Syncing with worker..."));
  try {
    await fetch(`${WORKER_URL}/api/session/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: selectedKey })
    });

    await fetch(`${WORKER_URL}/api/session/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: selectedKey, tunnelUrl })
    });
    
    console.log(chalk.green("✅ Session synced!"));
  } catch (error) {
    console.log(chalk.yellow(`⚠️  Worker sync failed: ${error.message}`));
  }

  // Save state
  saveState({
    apiKey: selectedKey,
    tunnelUrl,
    serverPid: serverManager.getProcess()?.pid,
    tunnelPid: tunnelProcess.pid
  });

  return { serverManager, tunnelProcess, tunnelUrl };
}

/**
 * Cleanup old 9remote tunnels
 */
function cleanupOldTunnels() {
  try {
    if (!fs.existsSync(bin)) return;

    const result = execSync(`"${bin}" tunnel list`, { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] });
    const lines = result.split("\n");

    const oldTunnels = [];
    for (const line of lines) {
      const match = line.match(/([a-f0-9-]{36})\s+(9remote-\d+)/);
      if (match) {
        oldTunnels.push(match[1]);
      }
    }

    if (oldTunnels.length > 0) {
      for (const tunnelId of oldTunnels) {
        try {
          execSync(`"${bin}" tunnel delete -f ${tunnelId}`, { stdio: "ignore" });
        } catch (e) { }
      }
    }
  } catch (e) { }
}

/**
 * Show main menu
 */
async function mainMenu() {
  console.clear();
  console.log(chalk.cyan.bold("\n🖥️  9Remote Terminal"));
  console.log(chalk.gray("━".repeat(30)));

  const { action } = await inquirer.prompt([
    {
      type: "list",
      name: "action",
      message: "Select action:",
      choices: [
        { name: "🚀 Start Server", value: "start" },
        { name: "🔑 Manage Key", value: "key" },
        { name: "❌ Exit", value: "exit" }
      ]
    }
  ]);

  switch (action) {
    case "start":
      await startServer();
      break;
    case "key":
      await manageKey();
      break;
    case "exit":
      console.log(chalk.gray("Goodbye!"));
      process.exit(0);
  }
}

/**
 * Start server with single key
 */
async function startServer() {
  const machineId = await getConsistentMachineId();
  let keyData = loadKey();

  // Auto create key if none exists
  if (!keyData.key) {
    console.log(chalk.yellow("\n⚠️  No key found. Creating default key..."));
    const { key } = generateApiKeyWithMachine(machineId);
    keyData = saveKey(machineId, key, "Default");
    console.log(chalk.green("✅ Default key created!"));
  }

  const result = await startServerAndTunnel(keyData.key);
  if (!result) {
    await mainMenu();
    return;
  }

  const { serverManager, tunnelProcess, tunnelUrl } = result;

  await showConnectionInfo(keyData.key, tunnelUrl);
  setupExitHandler(serverManager, tunnelProcess);

  // Keep process alive
  await new Promise(() => { });
}

/**
 * Manage single key menu
 */
async function manageKey() {
  const machineId = await getConsistentMachineId();
  let keyData = loadKey();

  // Auto create key if none exists
  if (!keyData.key) {
    console.log(chalk.yellow("\n⚠️  No key found. Creating default key..."));
    const { key } = generateApiKeyWithMachine(machineId);
    keyData = saveKey(machineId, key, "Default");
    console.log(chalk.green("✅ Default key created!"));
  }

  console.log(chalk.cyan("\n🔑 Manage Key"));
  console.log(chalk.gray("━".repeat(30)));
  console.log(chalk.white(`Key: ${keyData.key}`));
  console.log(chalk.gray(`Created: ${keyData.createdAt}`));

  console.log(chalk.cyan("\n🔑 Creating temp key..."));
  const tempKeyData = await createTempKey(keyData.key, WORKER_URL);
  
  if (tempKeyData) {
    const connectUrl = `${WORKER_URL}/login?k=${tempKeyData.tempKey}`;
    showQRCode(connectUrl, "📱 QR Code:");
    console.log(chalk.gray(`Temp key: ${tempKeyData.tempKey} (expires in 30 minutes)`));
  } else {
    console.log(chalk.red("❌ Failed to create temp key"));
  }

  const { action } = await inquirer.prompt([
    {
      type: "list",
      name: "action",
      message: "Action:",
      choices: [
        { name: "🔄 Regenerate Key", value: "regenerate" },
        { name: chalk.gray("← Back"), value: "back" }
      ]
    }
  ]);

  if (action === "regenerate") {
    const { confirm } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirm",
        message: chalk.yellow("⚠️  This will replace your current key. Continue?"),
        default: false
      }
    ]);

    if (confirm) {
      const { key } = generateApiKeyWithMachine(machineId);
      keyData = saveKey(machineId, key, keyData.name);
      
      console.log(chalk.green(`\n✅ Key regenerated: ${keyData.key}`));
      
      console.log(chalk.cyan("🔑 Creating temp key..."));
      const newTempKeyData = await createTempKey(keyData.key, WORKER_URL);
      
      if (newTempKeyData) {
        const newConnectUrl = `${WORKER_URL}/login?k=${newTempKeyData.tempKey}`;
        showQRCode(newConnectUrl, "📱 New QR Code:");
        console.log(chalk.gray(`Temp key: ${newTempKeyData.tempKey} (expires in 30 minutes)`));
      } else {
        console.log(chalk.red("❌ Failed to create temp key"));
      }

      await inquirer.prompt([{ type: "input", name: "continue", message: "Press Enter to continue..." }]);
    }
  }

  await mainMenu();
}

/**
 * Auto start dev server (--auto flag)
 */
async function autoStartDev() {
  console.log(chalk.cyan.bold("\n🖥️  9Remote Dev Mode"));
  console.log(chalk.gray("━".repeat(30)));

  const machineId = await getConsistentMachineId();
  let keyData = loadKey();

  // Auto create key if none exists
  if (!keyData.key) {
    console.log(chalk.yellow("⚠️  No key found. Creating default key..."));
    const { key } = generateApiKeyWithMachine(machineId);
    keyData = saveKey(machineId, key, "Default");
    console.log(chalk.green("✅ Default key created!"));
  }

  console.log(chalk.gray(`Using key: ${keyData.key.slice(0, 20)}... (${keyData.name})`));

  const result = await startServerAndTunnel(keyData.key);
  if (!result) {
    process.exit(1);
  }

  const { serverManager, tunnelProcess, tunnelUrl } = result;

  await showConnectionInfo(keyData.key, tunnelUrl);
  setupExitHandler(serverManager, tunnelProcess);

  // Keep process alive
  await new Promise(() => { });
}


// Start app
if (process.argv.includes("--auto")) {
  autoStartDev().catch(console.error);
} else {
  mainMenu().catch(console.error);
}
