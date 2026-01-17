#!/usr/bin/env node

import inquirer from "inquirer";
import chalk from "chalk";
import qrcode from "qrcode-terminal";
import { spawn, execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { bin, install } from "cloudflared";
import fs from "fs";
import { getConsistentMachineId } from "./utils/machineId.js";
import { generateApiKeyWithMachine } from "./utils/apiKey.js";
import { loadKeys, addKey, deleteKey, saveState, clearState } from "./utils/state.js";
import { createToken } from "./utils/token.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const WORKER_URL = "https://9remote-worker.decoluadt.workers.dev";

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
function showConnectionInfo(selectedKey, tunnelUrl) {
  const token = createToken(selectedKey, 5);
  const connectUrl = `${WORKER_URL}?t=${token}`;

  showQRCode(connectUrl);

  console.log(chalk.white(`\nWorker URL: ${chalk.blue(WORKER_URL)}`));
  console.log(chalk.white(`Access Key: ${chalk.yellow(selectedKey)}`));
  console.log(chalk.gray("Token expires in 5 minutes"));
  console.log(chalk.gray("\nPress Ctrl+C to stop server\n"));
}

/**
 * Helper: Setup exit handler for server processes
 */
function setupExitHandler(serverProcess, tunnelProcess) {
  process.on("SIGINT", () => {
    console.log(chalk.yellow("\n\n🛑 Stopping server..."));
    serverProcess.kill();
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

  // Start Next.js server
  const serverProcess = spawn("node", ["server.js"], {
    cwd: PROJECT_ROOT,
    stdio: ["ignore", "inherit", "inherit"],
    detached: false
  });

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
    serverProcess.kill();
    tunnelProcess.kill();
    return null;
  }

  if (!tunnelUrl) {
    console.log(chalk.red("❌ Failed to get tunnel URL"));
    serverProcess.kill();
    tunnelProcess.kill();
    return null;
  }

  console.log(chalk.green(`✅ Tunnel: ${tunnelUrl}`));

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
    serverPid: serverProcess.pid,
    tunnelPid: tunnelProcess.pid
  });

  return { serverProcess, tunnelProcess, tunnelUrl };
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
        { name: "🔑 Manage Keys", value: "keys" },
        { name: "❌ Exit", value: "exit" }
      ]
    }
  ]);

  switch (action) {
    case "start":
      await startServer();
      break;
    case "keys":
      await manageKeys();
      break;
    case "exit":
      console.log(chalk.gray("Goodbye!"));
      process.exit(0);
  }
}

/**
 * Start server with selected key
 */
async function startServer() {
  const machineId = await getConsistentMachineId();
  let keysData = loadKeys();

  // Auto create key if none exists
  if (keysData.keys.length === 0) {
    console.log(chalk.yellow("\n⚠️  No keys found. Creating default key..."));
    const { key } = generateApiKeyWithMachine(machineId);
    keysData = addKey(machineId, key, "Default");
    console.log(chalk.green("✅ Default key created!"));
  }

  // Select key
  let selectedKey;
  if (keysData.keys.length === 1) {
    selectedKey = keysData.keys[0].key;
  } else {
    const { keyIndex } = await inquirer.prompt([
      {
        type: "list",
        name: "keyIndex",
        message: "Select key:",
        choices: keysData.keys.map((k, i) => ({
          name: `${k.key.slice(0, 20)}... (${k.name})`,
          value: i
        }))
      }
    ]);
    selectedKey = keysData.keys[keyIndex].key;
  }

  const result = await startServerAndTunnel(selectedKey);
  if (!result) {
    await mainMenu();
    return;
  }

  const { serverProcess, tunnelProcess, tunnelUrl } = result;

  showConnectionInfo(selectedKey, tunnelUrl);
  setupExitHandler(serverProcess, tunnelProcess);

  // Keep process alive
  await new Promise(() => { });
}

/**
 * Manage keys menu
 */
async function manageKeys() {
  const machineId = await getConsistentMachineId();
  const keysData = loadKeys();

  console.log(chalk.cyan("\n🔑 Manage Keys"));
  console.log(chalk.gray("━".repeat(30)));

  const choices = [
    ...keysData.keys.map((k, i) => ({
      name: `${k.key.slice(0, 25)}... (${k.name})`,
      value: { action: "show", index: i }
    })),
    { name: chalk.green("➕ Create new key"), value: { action: "create" } },
    { name: chalk.gray("← Back"), value: { action: "back" } }
  ];

  const { selected } = await inquirer.prompt([
    {
      type: "list",
      name: "selected",
      message: "Select:",
      choices
    }
  ]);

  switch (selected.action) {
    case "create":
      await createKey(machineId);
      break;
    case "show":
      await showKey(selected.index);
      break;
    case "back":
      await mainMenu();
      return;
  }

  await manageKeys();
}

/**
 * Auto start dev server (--auto flag)
 */
async function autoStartDev() {
  console.log(chalk.cyan.bold("\n🖥️  9Remote Dev Mode"));
  console.log(chalk.gray("━".repeat(30)));

  const machineId = await getConsistentMachineId();
  let keysData = loadKeys();

  // Auto create key if none exists
  if (keysData.keys.length === 0) {
    console.log(chalk.yellow("⚠️  No keys found. Creating default key..."));
    const { key } = generateApiKeyWithMachine(machineId);
    keysData = addKey(machineId, key, "Default");
    console.log(chalk.green("✅ Default key created!"));
  }

  // Auto select first key
  const selectedKey = keysData.keys[0].key;
  console.log(chalk.gray(`Using key: ${selectedKey.slice(0, 20)}... (${keysData.keys[0].name})`));

  const result = await startServerAndTunnel(selectedKey);
  if (!result) {
    process.exit(1);
  }

  const { serverProcess, tunnelProcess, tunnelUrl } = result;

  showConnectionInfo(selectedKey, tunnelUrl);
  setupExitHandler(serverProcess, tunnelProcess);

  // Keep process alive
  await new Promise(() => { });
}

/**
 * Create new key
 */
async function createKey(machineId) {
  const { name } = await inquirer.prompt([
    {
      type: "input",
      name: "name",
      message: "Key name:",
      default: `Key ${loadKeys().keys.length + 1}`
    }
  ]);

  const { key } = generateApiKeyWithMachine(machineId);
  addKey(machineId, key, name);

  const token = createToken(key, 5);
  const connectUrl = `${WORKER_URL}?t=${token}`;

  console.log(chalk.green(`\n✅ Key created: ${key}`));
  showQRCode(connectUrl, "📱 QR Code:");

  await inquirer.prompt([{ type: "input", name: "continue", message: "Press Enter to continue..." }]);
}

/**
 * Show key details with options
 */
async function showKey(index) {
  const keysData = loadKeys();
  const keyData = keysData.keys[index];

  console.log(chalk.cyan(`\n🔑 ${keyData.name}`));
  console.log(chalk.gray("━".repeat(30)));
  console.log(chalk.white(`Key: ${keyData.key}`));
  console.log(chalk.gray(`Created: ${keyData.createdAt}`));

  const token = createToken(keyData.key, 5);
  const connectUrl = `${WORKER_URL}?t=${token}`;

  showQRCode(connectUrl, "📱 QR Code:");

  const { action } = await inquirer.prompt([
    {
      type: "list",
      name: "action",
      message: "Action:",
      choices: [
        { name: chalk.red("🗑️  Delete this key"), value: "delete" },
        { name: chalk.gray("← Back"), value: "back" }
      ]
    }
  ]);

  if (action === "delete") {
    const { confirm } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirm",
        message: "Are you sure?",
        default: false
      }
    ]);

    if (confirm) {
      deleteKey(index);
      console.log(chalk.green("✅ Key deleted"));
    }
  }
}

// Start app
if (process.argv.includes("--auto")) {
  autoStartDev().catch(console.error);
} else {
  mainMenu().catch(console.error);
}
