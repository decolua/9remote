#!/usr/bin/env node

import inquirer from "inquirer";
import chalk from "chalk";
import qrcode from "qrcode-terminal";
import { spawn, execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import dns from "dns/promises";
import { getConsistentMachineId } from "./utils/machineId.js";
import { generateApiKeyWithMachine } from "./utils/apiKey.js";
import { loadKey, saveKey, saveState, clearState } from "./utils/state.js";
import { createTempKey } from "./utils/token.js";
import { checkForUpdates } from "./utils/updateChecker.js";
import { ensureCloudflared, spawnCloudflared, killCloudflared, resetRestartCounter } from "./utils/cloudflared.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
// When running from dist/cli.cjs, server.cjs is in same folder
// When running from cli/index.js (dev), use server/index.js
const STANDALONE_SERVER = path.join(__dirname, "server.cjs");
const DEV_SERVER = path.join(PROJECT_ROOT, "server/index.js");
const WORKER_URL = "https://remote.9router.com";
const SERVER_PORT = 2208;
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_WINDOW_MS = 60000; // 1 minute

/**
 * Get current version from package.json
 */
function getVersion() {
  try {
    const packagePath = path.join(__dirname, "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
    return packageJson.version;
  } catch {
    return "unknown";
  }
}

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
  const tempKeyData = await createTempKey(selectedKey, WORKER_URL);
  
  if (!tempKeyData) {
    console.log(chalk.red("❌ Failed to create temp key"));
    return;
  }

  const connectUrl = `${WORKER_URL}/login?k=${tempKeyData.tempKey}`;

  showQRCode(connectUrl);

  console.log(chalk.gray(`\nQR will expire in 30 minutes (one-time use)`));
  console.log(chalk.gray(`Or enter key manually:\n`));
  console.log(chalk.gray(`┌──────────────┬────────────────────────────────────────┐`));
  console.log(chalk.gray(`│`) + chalk.white(` App URL      `) + chalk.gray(`│`) + chalk.blue(` ${WORKER_URL}/login`.padEnd(39)) + chalk.gray(`│`));
  console.log(chalk.gray(`├──────────────┼────────────────────────────────────────┤`));
  console.log(chalk.gray(`│`) + chalk.white(` One-Time Key `) + chalk.gray(`│`) + chalk.bold.yellow(` ${tempKeyData.tempKey}`.padEnd(39)) + chalk.gray(`│`));
  console.log(chalk.gray(`├──────────────┼────────────────────────────────────────┤`));
  console.log(chalk.gray(`│`) + chalk.white(` Key          `) + chalk.gray(`│`) + chalk.gray(` ${selectedKey}`.padEnd(39)) + chalk.gray(`│`));
  console.log(chalk.gray(`└──────────────┴────────────────────────────────────────┘`));
}

/**
 * Kill process on specific port
 */
function killProcessOnPort(port) {
  try {
    if (process.platform === "win32") {
      execSync(`for /f "tokens=5" %a in ('netstat -aon ^| findstr :${port}') do taskkill /F /PID %a`, { stdio: "ignore" });
    } else {
      const nullDevice = "/dev/null";
      execSync(`lsof -ti:${port} | xargs kill -9 2>${nullDevice} || true`, { stdio: "ignore" });
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
  let isFirstStart = true;

  const spawnServer = () => {
    // Only kill port on first start, not on restart
    if (isFirstStart) {
      killProcessOnPort(SERVER_PORT);
      isFirstStart = false;
    }

    // Use dev server if exists (development), otherwise use standalone (npm package)
    const useDevServer = fs.existsSync(DEV_SERVER);
    const serverPath = useDevServer ? DEV_SERVER : STANDALONE_SERVER;
    
    if (!fs.existsSync(serverPath)) {
      console.error(`❌ Server not found: ${serverPath}`);
      process.exit(1);
    }
    
    currentProcess = spawn("node", [serverPath], {
      cwd: path.dirname(serverPath),
      stdio: ["ignore", "inherit", "inherit"],
      detached: false,
      env: { ...process.env, PORT: String(SERVER_PORT) }
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
function setupExitHandler(serverManager, tunnelProcess, apiKey) {
  process.on("SIGINT", async () => {
    console.log(chalk.yellow("\n\n🛑 Stopping server..."));
    serverManager.shutdown();
    tunnelProcess.kill();
    resetRestartCounter();
    
    // Cleanup tunnel on worker
    try {
      await fetch(`${WORKER_URL}/api/tunnel/delete`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey })
      });
    } catch { }
    
    clearState();
    console.log(chalk.green("✅ Server stopped"));
    process.exit(0);
  });
}

/**
 * Helper: Create Named Tunnel via Worker API
 */
async function createNamedTunnel(apiKey) {
  const response = await fetch(`${WORKER_URL}/api/tunnel/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to create tunnel");
  }

  return response.json();
}

/**
 * Helper: Start server and tunnel
 */
async function startServerAndTunnel(selectedKey) {
  console.log(chalk.cyan("\n🚀 Starting server..."));

  // Kill existing cloudflared process
  try {
    killCloudflared();
  } catch { }

  // Create session first
  try {
    await fetch(`${WORKER_URL}/api/session/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: selectedKey })
    });
  } catch (error) {
    console.log(chalk.red(`❌ Failed to create session: ${error.message}`));
    return null;
  }

  // Start server with auto-restart
  const serverManager = startServerWithRestart();

  // Wait for server to start
  await new Promise((resolve) => setTimeout(resolve, 2000));

  console.log(chalk.cyan("✅ Creating tunnel..."));

  // Ensure cloudflared binary
  try {
    await ensureCloudflared();
  } catch (error) {
    console.log(chalk.red(`❌ Failed to install cloudflared: ${error.message}`));
    serverManager.shutdown();
    return null;
  }

  // Create Named Tunnel via Worker API
  let tunnelData;
  try {
    tunnelData = await createNamedTunnel(selectedKey);
    console.log(chalk.gray(`✅ Tunnel ID: ${tunnelData.tunnelId}`));
  } catch (error) {
    console.log(chalk.red(`❌ Failed to create tunnel: ${error.message}`));
    serverManager.shutdown();
    return null;
  }

  const { token, hostname: tunnelUrl } = tunnelData;

  // Spawn cloudflared with token and auto-restart callback
  console.log(chalk.cyan("✅ Starting tunnel..."));
  let tunnelProcess;
  
  const startTunnel = async (tunnelToken) => {
    try {
      tunnelProcess = await spawnCloudflared(tunnelToken, startTunnel);
      return tunnelProcess;
    } catch (error) {
      console.log(chalk.red(`❌ Failed to start cloudflared: ${error.message}`));
      return null;
    }
  };
  
  tunnelProcess = await startTunnel(token);
  if (!tunnelProcess) {
    serverManager.shutdown();
    return null;
  }

  // Wait for tunnel to be ready
  console.log(chalk.cyan(`✅ Tunnel URL: ${tunnelUrl}`));
  
  const maxWaitTime = 60000;
  const checkInterval = 2000;
  const maxRetries = Math.floor(maxWaitTime / checkInterval);
  let tunnelReady = false;
  
  // Resolve IP using Cloudflare DNS to bypass local cache
  const hostname = new URL(tunnelUrl).hostname;
  let resolvedIp = null;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      // Resolve DNS using Cloudflare DNS server (bypass local cache)
      if (!resolvedIp) {
        const resolver = new dns.Resolver();
        resolver.setServers(["1.1.1.1", "1.0.0.1"]);
        const addresses = await resolver.resolve4(hostname);
        if (addresses.length > 0) {
          resolvedIp = addresses[0];
        }
      }
      
      if (resolvedIp) {
        // Use curl with --resolve to bypass DNS cache and SSL issues
        const curlResult = execSync(
          `curl -s --max-time 5 --resolve "${hostname}:443:${resolvedIp}" "${tunnelUrl}/api/health"`,
          { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
        );
        if (curlResult.includes("ok")) {
          tunnelReady = true;
          break;
        }
      }
    } catch { }
    
    const spinners = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    process.stdout.write(`\r${chalk.cyan("   Waiting for tunnel")} ${chalk.yellow(spinners[i % spinners.length])} ${chalk.gray(`(${i * 2}s)`)}`);
    
    await new Promise(r => setTimeout(r, checkInterval));
  }
  
  process.stdout.write("\r" + " ".repeat(50) + "\r");
  
  if (!tunnelReady) {
    console.log(chalk.red("❌ Tunnel connection timeout"));
    serverManager.shutdown();
    tunnelProcess.kill();
    return null;
  }
  
  console.log(chalk.green(`✅ Connection established`));

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
  setupExitHandler(serverManager, tunnelProcess, keyData.key);

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
  console.log(chalk.gray(`Created: ${keyData.createdAt}\n`));

  const { action } = await inquirer.prompt([
    {
      type: "list",
      name: "action",
      message: "Action:",
      choices: [
        { name: "🔐 Create One-Time Key", value: "oneTime" },
        { name: "🔄 Regenerate Key", value: "regenerate" },
        { name: chalk.gray("← Back"), value: "back" }
      ]
    }
  ]);

  if (action === "oneTime") {
    console.log(chalk.gray("\nCreating one-time key..."));
    const tempKeyData = await createTempKey(keyData.key, WORKER_URL);
    
    if (tempKeyData) {
      const connectUrl = `${WORKER_URL}/login?k=${tempKeyData.tempKey}`;
      showQRCode(connectUrl);
      
      console.log(chalk.gray(`\nQR will expire in 30 minutes (one-time use)`));
      console.log(chalk.gray(`Or enter key manually:\n`));
      console.log(chalk.gray(`┌──────────────┬────────────────────────────────────────┐`));
      console.log(chalk.gray(`│`) + chalk.white(` App URL      `) + chalk.gray(`│`) + chalk.blue(` ${WORKER_URL}/login`.padEnd(39)) + chalk.gray(`│`));
      console.log(chalk.gray(`├──────────────┼────────────────────────────────────────┤`));
      console.log(chalk.gray(`│`) + chalk.white(` One-Time Key `) + chalk.gray(`│`) + chalk.bold.yellow(` ${tempKeyData.tempKey}`.padEnd(39)) + chalk.gray(`│`));
      console.log(chalk.gray(`└──────────────┴────────────────────────────────────────┘`));
    } else {
      console.log(chalk.red("❌ Failed to create one-time key"));
    }
    await inquirer.prompt([{ type: "input", name: "continue", message: "Press Enter to continue..." }]);
  }

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
  setupExitHandler(serverManager, tunnelProcess, keyData.key);

  // Keep process alive
  await new Promise(() => { });
}


// Start app
async function start() {
  const version = getVersion();
  console.log(chalk.cyan(`\n🚀 9Remote CLI v${version}\n`));
  
  checkForUpdates();
  
  const command = process.argv[2];
  
  if (command === "start" || process.argv.includes("--auto")) {
    // Direct start: 9remote start
    await autoStartDev();
  } else {
    // Menu mode: 9remote
    await mainMenu();
  }
}

start().catch(console.error);
