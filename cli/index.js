#!/usr/bin/env node

import inquirer from "inquirer";
import chalk from "chalk";
import qrcode from "qrcode-terminal";
import { spawn, execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import os from "os";
import { Resolver } from "dns/promises";
import { getConsistentMachineId } from "./utils/machineId.js";
import { generateApiKeyWithMachine } from "./utils/apiKey.js";
import { loadKey, saveKey, saveState, clearState } from "./utils/state.js";
import { createTempKey } from "./utils/token.js";
import { checkForUpdates } from "./utils/updateChecker.js";
import { ensureNativeDeps } from "./utils/installer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const STANDALONE_SERVER = path.join(__dirname, "../dist/server.cjs");
const WORKER_URL = "https://remote.9router.com";
const SERVER_PORT = 2208;
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

    // Use dev server if src/ exists (development), otherwise use standalone (npm package)
    const devServerPath = path.join(PROJECT_ROOT, "server.js");
    const srcExists = fs.existsSync(path.join(PROJECT_ROOT, "src"));
    const serverPath = srcExists ? devServerPath : STANDALONE_SERVER;
    
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
 * Helper: Start Quick Tunnel with error handling
 */
async function startQuickTunnel(bin) {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  let tunnelUrl = null;
  let tunnelErrors = [];
  
  const tunnelProcess = spawn(bin, ["tunnel", "--config", nullDevice, "--no-autoupdate", "--url", `http://localhost:${SERVER_PORT}`], {
    stdio: ["ignore", "pipe", "pipe"]
  });

  // Capture stderr for debugging
  tunnelProcess.stderr.on("data", (data) => {
    const output = data.toString();
    tunnelErrors.push(output);
    
    // Only log critical errors, skip normal operational messages
    const isCriticalError = (
      (output.includes("ERR") || output.includes("error") || output.includes("failed")) &&
      !output.includes("Configuration file") && // Skip config file warnings
      !output.includes("was empty") // Skip empty config warnings
    );
    
    if (isCriticalError) {
      console.log(chalk.yellow(`   [Tunnel] ${output.trim()}`));
    }
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
    // Show captured errors for debugging
    if (tunnelErrors.length > 0) {
      console.log(chalk.yellow("   📋 Tunnel error logs:"));
      tunnelErrors.slice(-3).forEach(err => {
        console.log(chalk.gray(`      ${err.trim()}`));
      });
    }
    
    tunnelProcess.kill();
    throw error;
  }

  if (!tunnelUrl) {
    tunnelProcess.kill();
    throw new Error("Failed to get tunnel URL");
  }

  return { tunnelUrl, tunnelProcess };
}

/**
 * Helper: Start server and tunnel
 */
async function startServerAndTunnel(selectedKey) {
  console.log(chalk.cyan("\n🚀 Starting server..."));

  // Kill existing processes
  try {
    if (process.platform === "win32") {
      execSync("taskkill /F /IM node.exe /FI \"WINDOWTITLE eq server.js*\" 2>nul || exit 0", { stdio: "ignore" });
      execSync("taskkill /F /IM cloudflared.exe 2>nul || exit 0", { stdio: "ignore" });
    } else {
      execSync("pkill -f 'node server.js' 2>/dev/null || true", { stdio: "ignore" });
      execSync("pkill -f cloudflared 2>/dev/null || true", { stdio: "ignore" });
    }
  } catch { }

  // Cleanup old cloudflared tunnels
  cleanupOldTunnels();

  // Start server with auto-restart
  const serverManager = startServerWithRestart();

  // Wait for server to start
  await new Promise((resolve) => setTimeout(resolve, 3000));

  console.log(chalk.cyan("✅ Starting tunnel..."));

  // Check for config file conflict
  const configPath = path.join(os.homedir(), ".cloudflared", "config.yml");
  if (fs.existsSync(configPath)) {
    console.log(chalk.yellow("⚠️  Warning: Found ~/.cloudflared/config.yml"));
    console.log(chalk.yellow("   This may conflict with Quick Tunnel. Consider renaming it temporarily."));
  }

  // Lazy load cloudflared
  const { bin, install } = await import("cloudflared");

  // Ensure cloudflared binary is installed
  if (!fs.existsSync(bin)) {
    console.log(chalk.yellow("📥 Installing cloudflared..."));
    await install(bin);
  }

  // Verify cloudflared binary
  try {
    const versionOutput = execSync(`"${bin}" --version`, { encoding: "utf-8" });
    console.log(chalk.gray(`   cloudflared version: ${versionOutput.trim()}`));
  } catch (error) {
    console.log(chalk.red(`❌ Failed to verify cloudflared binary: ${error.message}`));
    serverManager.shutdown();
    return null;
  }

  // Retry logic for Quick Tunnel
  const MAX_TUNNEL_RETRIES = 3;
  const RETRY_DELAY = 5000; // 5 seconds
  let tunnelUrl = null;
  let tunnelProcess = null;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_TUNNEL_RETRIES; attempt++) {
    if (attempt > 1) {
      console.log(chalk.yellow(`\n🔄 Retry attempt ${attempt}/${MAX_TUNNEL_RETRIES} (waiting 5s)...`));
      await new Promise(r => setTimeout(r, RETRY_DELAY));
    }

    try {
      const result = await startQuickTunnel(bin, serverManager);
      if (result && result.tunnelUrl) {
        tunnelUrl = result.tunnelUrl;
        tunnelProcess = result.tunnelProcess;
        break; // Success!
      }
    } catch (error) {
      lastError = error;
      console.log(chalk.yellow(`   Attempt ${attempt} failed: ${error.message}`));
    }
  }

  if (!tunnelUrl) {
    console.log(chalk.red(`\n❌ Failed to start tunnel after ${MAX_TUNNEL_RETRIES} attempts`));
    if (lastError) {
      console.log(chalk.red(`   Last error: ${lastError.message}`));
    }
    serverManager.shutdown();
    return null;
  }

  // Show tunnel URL immediately
  console.log(chalk.cyan(`✅ Tunnel URL: ${tunnelUrl}`));

  // Verify tunnel is connected to server
  const maxWaitTime = 120000; // 2 minutes
  const checkInterval = 1000; // 1 second
  const maxRetries = Math.floor(maxWaitTime / checkInterval);
  let tunnelReady = false;
  
  process.stdout.write(chalk.cyan("   Checking"));
  
  // Multiple DNS resolvers to increase success rate
  const dnsResolvers = [
    ["1.1.1.1", "1.0.0.1"],      // Cloudflare DNS
    ["8.8.8.8", "8.8.4.4"],      // Google DNS
    ["208.67.222.222", "208.67.220.220"], // OpenDNS
  ];
  
  const hostname = new URL(tunnelUrl).hostname;
  
  for (let i = 0; i < maxRetries; i++) {
    // Try each DNS resolver in rotation
    const resolverIndex = i % dnsResolvers.length;
    const dnsServers = dnsResolvers[resolverIndex];
    
    try {
      // Try DNS resolution with current resolver
      const resolver = new Resolver();
      resolver.setServers(dnsServers);
      await resolver.resolve4(hostname);

      // Try health check
      const healthRes = await fetch(`${tunnelUrl}/api/health`, { 
        signal: AbortSignal.timeout(5000) 
      });
      if (healthRes.ok) {
        tunnelReady = true;
        break;
      }
    } catch(error) {
      // Log error for debugging (only on first few attempts)
      // if (i < 3) {
      //   console.log(chalk.gray(`\n   [Debug] Attempt ${i + 1} failed: ${error.message}`));
      //   console.log(chalk.gray(`   [Debug] DNS: ${dnsServers.join(", ")}`));
      // }
      // Retry with next resolver
    }
    
    // Animated spinner
    const spinners = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    process.stdout.write(`\r${chalk.cyan("✅ Waiting for tunnel")} ${chalk.yellow(spinners[i % spinners.length])} ${chalk.gray(`(${i}s)`)}`);
    
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
  
  console.log(chalk.green(`✅ Connection established`));

  // Sync with
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
  setupExitHandler(serverManager, tunnelProcess);

  // Keep process alive
  await new Promise(() => { });
}


// Start app
async function start() {
  checkForUpdates();
  
  // Ensure native dependencies are installed (first time only)
  const depsReady = await ensureNativeDeps();
  if (!depsReady) {
    console.log(chalk.red("❌ Failed to install dependencies. Please try again."));
    process.exit(1);
  }
  
  // Wait a bit for symlinks to be fully created (filesystem sync)
  await new Promise(r => setTimeout(r, 1000));
  
  if (process.argv.includes("--auto")) {
    await autoStartDev();
  } else {
    await mainMenu();
  }
}

start().catch(console.error);
