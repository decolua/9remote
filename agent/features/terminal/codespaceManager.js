// Codespaces heartbeat + devcontainer auto-start management
import fs from "fs";
import path from "path";

let activeConnections = 0;
let heartbeatInterval = null;
const HEARTBEAT_INTERVAL_MS = 60000;

const DEVCONTAINER_CONFIG = {
  name: "9Remote",
  postCreateCommand: "npm install -g 9remote@latest",
  postAttachCommand: "9remote start",
  forwardPorts: [2208],
  portsAttributes: {
    "2208": {
      label: "9Remote Server",
      onAutoForward: "notify"
    }
  }
};

export function isCodespaces() {
  return process.env.CODESPACES === "true";
}

export function getCodespaceInfo() {
  if (!isCodespaces()) return null;
  return {
    isCodespaces: true,
    codespaceName: process.env.CODESPACE_NAME || "unknown",
    workspacePath: process.env.CODESPACE_VSCODE_FOLDER || process.cwd()
  };
}

export function trackConnection() {
  activeConnections++;
  if (isCodespaces() && activeConnections === 1) startHeartbeat();
}

export function trackDisconnection() {
  activeConnections--;
  if (isCodespaces() && activeConnections === 0) stopHeartbeat();
}

function startHeartbeat() {
  if (heartbeatInterval) return;
  heartbeatInterval = setInterval(() => {
    process.memoryUsage();
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (!heartbeatInterval) return;
  console.log("⏸️ Stopping Codespaces heartbeat");
  clearInterval(heartbeatInterval);
  heartbeatInterval = null;
}

function getDevcontainerPath(workspacePath) {
  return path.join(workspacePath, ".devcontainer", "devcontainer.json");
}

export function getAutoStartStatus(workspacePath) {
  try {
    const devcontainerPath = getDevcontainerPath(workspacePath);
    if (!fs.existsSync(devcontainerPath)) return { enabled: false, exists: false };
    const config = JSON.parse(fs.readFileSync(devcontainerPath, "utf8"));
    const enabled = config.postAttachCommand === "9remote start" || config.postAttachCommand === "9remote";
    return { enabled, exists: true };
  } catch {
    return { enabled: false, exists: false, error: "Failed to read config" };
  }
}

export function setAutoStart(workspacePath, enabled) {
  try {
    const devcontainerDir = path.join(workspacePath, ".devcontainer");
    const devcontainerPath = getDevcontainerPath(workspacePath);

    if (!fs.existsSync(devcontainerDir)) fs.mkdirSync(devcontainerDir, { recursive: true });

    let config = { ...DEVCONTAINER_CONFIG };
    if (fs.existsSync(devcontainerPath)) {
      try { config = { ...JSON.parse(fs.readFileSync(devcontainerPath, "utf8")) }; } catch { /* use default */ }
    }

    if (enabled) {
      config.postAttachCommand = "9remote start";
      if (!config.postCreateCommand) config.postCreateCommand = "npm install -g 9remote@latest";
    } else {
      delete config.postAttachCommand;
    }

    fs.writeFileSync(devcontainerPath, JSON.stringify(config, null, 2));
    return { success: true, enabled };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
