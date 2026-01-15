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

  console.log(chalk.cyan("\n🚀 Starting server..."));

  // Kill existing processes
  try {
    execSync("pkill -f 'node server.js' 2>/dev/null || true", { stdio: "ignore" });
    execSync("pkill -f cloudflared 2>/dev/null || true", { stdio: "ignore" });
  } catch {}

  // Start Next.js server
  const serverProcess = spawn("node", ["server.js"], {
    cwd: PROJECT_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false
  });

  serverProcess.stdout.on("data", (data) => {
    if (data.toString().includes("Ready")) {
      console.log(chalk.green("✅ Server ready on http://localhost:3000"));
    }
  });

  // Wait for server to start
  await new Promise((resolve) => setTimeout(resolve, 3000));

  console.log(chalk.cyan("🌐 Starting tunnel..."));

  // Ensure cloudflared binary is installed
  if (!fs.existsSync(bin)) {
    console.log(chalk.yellow("📥 Installing cloudflared..."));
    await install(bin);
  }

  // Start Quick Tunnel using spawn directly (more reliable)
  let tunnelUrl = null;
  const tunnelProcess = spawn(bin, ["tunnel", "--url", "http://localhost:3000"], {
    stdio: ["ignore", "pipe", "pipe"]
  });

  // Parse tunnel URL from stderr (cloudflared logs to stderr)
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
    await mainMenu();
    return;
  }

  if (!tunnelUrl) {
    console.log(chalk.red("❌ Failed to get tunnel URL"));
    serverProcess.kill();
    tunnelProcess.kill();
    await mainMenu();
    return;
  }

  console.log(chalk.green(`✅ Tunnel: ${tunnelUrl}`));

  // Create/update session on worker
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

  // Create encrypted token (expires in 5 minutes)
  const token = createToken(selectedKey, 5);
  const connectUrl = `${WORKER_URL}?t=${token}`;
  
  console.log(chalk.cyan("\n📱 Scan QR to connect:"));
  qrcode.generate(connectUrl, { small: true }, qr => {
    const lines = qr.trim().split('\n');
    console.log(lines.join('\n'));
  });

  console.log(chalk.white(`\nWorker URL: ${chalk.blue(WORKER_URL)}`));
  console.log(chalk.white(`Access Key: ${chalk.yellow(selectedKey)}`));
  console.log(chalk.gray("Token expires in 5 minutes"));
  console.log(chalk.gray("\nPress Ctrl+C to stop server\n"));

  // Handle exit
  process.on("SIGINT", () => {
    console.log(chalk.yellow("\n\n🛑 Stopping server..."));
    serverProcess.kill();
    tunnelProcess.kill();
    clearState();
    console.log(chalk.green("✅ Server stopped"));
    process.exit(0);
  });

  // Keep process alive
  await new Promise(() => {});
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
  console.log(chalk.cyan("\n📱 QR Code:"));
  qrcode.generate(connectUrl, { small: true }, qr => {
    const lines = qr.trim().split('\n');
    console.log(lines.join('\n'));
  });

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

  console.log(chalk.cyan("\n📱 QR Code:"));
  qrcode.generate(connectUrl, { small: true }, qr => {
    const lines = qr.trim().split('\n');
    console.log(lines.join('\n'));
  });

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
mainMenu().catch(console.error);
