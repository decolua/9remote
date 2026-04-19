import fs from "fs";
import path from "path";
import https from "https";
import os from "os";
import { execSync, spawn } from "child_process";
import { writePid, readPid, clearPid } from "./pids.js";

// Network change detection
let networkMonitorInterval = null;
let lastNetworkState = null;
let currentTunnelToken = null;

const BIN_DIR = path.join(os.homedir(), ".9remote", "bin");
const BINARY_NAME = "cloudflared";
const IS_WINDOWS = os.platform() === "win32";
const BIN_NAME = IS_WINDOWS ? `${BINARY_NAME}.exe` : BINARY_NAME;
const BIN_PATH = path.join(BIN_DIR, BIN_NAME);
// Legacy PID file — kept for one-time cleanup of installs from older versions
const LEGACY_PID_FILE = path.join(os.homedir(), ".9remote", "cloudflared.pid");

// Track intentional shutdown to suppress exit logs
let isIntentionalShutdown = false;

// Auto-restart configuration
const MAX_RESTART_ATTEMPTS = 5;
const RESTART_WINDOW_MS = 60000; // 1 minute
let restartTimes = [];
let restartCallback = null;

const GITHUB_BASE_URL = "https://github.com/cloudflare/cloudflared/releases/latest/download";

/**
 * Platform mappings for cloudflared
 */
const PLATFORM_MAPPINGS = {
  darwin: {
    x64: "cloudflared-darwin-amd64.tgz",
    arm64: "cloudflared-darwin-amd64.tgz"
  },
  win32: {
    x64: "cloudflared-windows-amd64.exe"
  },
  linux: {
    x64: "cloudflared-linux-amd64",
    arm64: "cloudflared-linux-arm64"
  }
};

/**
 * Get download URL
 */
function getDownloadUrl() {
  const platform = os.platform();
  const arch = os.arch();
  
  const platformMapping = PLATFORM_MAPPINGS[platform];
  if (!platformMapping) {
    throw new Error(`Unsupported platform: ${platform}`);
  }
  
  const binaryName = platformMapping[arch];
  if (!binaryName) {
    throw new Error(`Unsupported architecture: ${arch} for platform ${platform}`);
  }
  
  return `${GITHUB_BASE_URL}/${binaryName}`;
}

// Emit progress at most every N ms to avoid render thrash
const PROGRESS_THROTTLE_MS = 150;

/**
 * Download file from URL with progress tracking
 * @param {string} url
 * @param {string} dest
 * @param {(percent: number) => void} [onProgress]
 */
async function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);

    https.get(url, (response) => {
      if ([301, 302].includes(response.statusCode)) {
        file.close();
        fs.unlinkSync(dest);
        downloadFile(response.headers.location, dest, onProgress).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        reject(new Error(`Download failed with status ${response.statusCode}`));
        return;
      }

      const total = parseInt(response.headers["content-length"] || "0", 10);
      let received = 0;
      let lastEmit = 0;
      let lastPercent = -1;

      response.on("data", (chunk) => {
        received += chunk.length;
        if (!onProgress || !total) return;
        const now = Date.now();
        const percent = Math.min(100, Math.floor((received / total) * 100));
        if (percent !== lastPercent && now - lastEmit >= PROGRESS_THROTTLE_MS) {
          lastEmit = now;
          lastPercent = percent;
          onProgress(percent);
        }
      });

      response.pipe(file);

      file.on("finish", () => {
        if (onProgress && total) onProgress(100);
        file.close(() => resolve(dest));
      });

      file.on("error", (err) => {
        file.close();
        fs.unlinkSync(dest);
        reject(err);
      });
    }).on("error", (err) => {
      file.close();
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      reject(err);
    });
  });
}

/**
 * Ensure cloudflared binary exists
 * @param {(progress: { phase: "download" | "extract", percent?: number }) => void} [onProgress]
 */
export async function ensureCloudflared(onProgress) {
  if (!fs.existsSync(BIN_DIR)) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
  }

  if (fs.existsSync(BIN_PATH)) {
    if (!IS_WINDOWS) {
      fs.chmodSync(BIN_PATH, "755");
    }
    return BIN_PATH;
  }

  const url = getDownloadUrl();
  const isArchive = url.endsWith(".tgz");
  const downloadDest = isArchive ? path.join(BIN_DIR, "cloudflared.tgz") : BIN_PATH;

  try {
    onProgress?.({ phase: "download", percent: 0 });
    await downloadFile(url, downloadDest, (percent) => {
      onProgress?.({ phase: "download", percent });
    });

    if (isArchive) {
      onProgress?.({ phase: "extract" });
      execSync(`tar -xzf "${downloadDest}" -C "${BIN_DIR}"`, { stdio: "pipe", windowsHide: true });
      fs.unlinkSync(downloadDest);
    }

    if (!IS_WINDOWS) {
      fs.chmodSync(BIN_PATH, "755");
    }

    return BIN_PATH;
  } catch (error) {
    console.error("❌ Failed to download cloudflared:", error.message);
    throw error;
  }
}

// Log patterns to filter cloudflared output
const LOG_IGNORE = [
  "INF Starting tunnel",
  "INF Version",
  "GOOS:",
  "Settings:",
  "Autoupdate frequency",
  "Generated Connector",
  "Initial protocol",
  "ICMP proxy",
  "Created ICMP",
  "Starting metrics server",
  "curve preferences",
  "Updated to new configuration"
];

/**
 * Parse trycloudflare.com URL from cloudflared log output
 */
function parseQuickTunnelUrl(message) {
  const regex = /https:\/\/([a-z0-9-]+)\.trycloudflare\.com/gi;
  const candidates = [];
  for (const match of message.matchAll(regex)) {
    if (match[1] === "api") continue;
    candidates.push(`https://${match[1]}.trycloudflare.com`);
  }
  return candidates.length ? candidates[candidates.length - 1] : null;
}

/**
 * Spawn cloudflared quick tunnel (no account needed)
 * @param {number} localPort - Local port to tunnel
 * @param {Function} onUrlUpdate - Called when URL changes after initial connect
 * @returns {Promise<{child, tunnelUrl}>}
 */
export async function spawnQuickTunnel(localPort, onUrlUpdate = null) {
  const binaryPath = await ensureCloudflared();

  // Use temp config to avoid conflicting with ~/.cloudflared/config.yml
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "9remote-quick-"));
  const configPath = path.join(configDir, "config.yml");
  fs.writeFileSync(configPath, "# quick-tunnel\n", "utf8");

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { fs.rmSync(configDir, { recursive: true, force: true }); } catch { }
  };

  const child = spawn(
    binaryPath,
    ["tunnel", "--url", `http://localhost:${localPort}`, "--config", configPath, "--no-autoupdate", "--protocol", "http2"],
    { detached: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
  );

  writePid("cloudflared", child.pid);
  isIntentionalShutdown = false;

  return new Promise((resolve, reject) => {
    let resolved = false;
    let lastUrl = null;

    const timeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      cleanup();
      reject(new Error("Quick tunnel timed out after 90s"));
    }, 90000);

    const handleLog = (data) => {
      const msg = data.toString();
      const tunnelUrl = parseQuickTunnelUrl(msg);
      if (!tunnelUrl) return;

      if (!resolved) {
        resolved = true;
        lastUrl = tunnelUrl;
        clearTimeout(timeout);
        cleanup();
        resolve({ child, tunnelUrl });
        return;
      }

      // URL rotated after initial connect — notify caller
      if (tunnelUrl !== lastUrl) {
        lastUrl = tunnelUrl;
        onUrlUpdate?.(tunnelUrl);
      }
    };

    child.stdout.on("data", handleLog);
    child.stderr.on("data", handleLog);

    child.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      cleanup();
      reject(err);
    });

    child.on("exit", (code) => {
      cleanup();
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`cloudflared exited with code ${code}`));
        return;
      }
      if (!isIntentionalShutdown && restartCallback) {
        const now = Date.now();
        restartTimes.push(now);
        restartTimes = restartTimes.filter(t => t > now - RESTART_WINDOW_MS);
        if (restartTimes.length <= MAX_RESTART_ATTEMPTS) {
          setTimeout(() => restartCallback(localPort), 2000);
        }
      }
    });
  });
}

/**
 * Spawn cloudflared tunnel
 * @param {string} tunnelToken
 * @param {Function} onRestart - Callback when tunnel needs restart
 * @returns {ChildProcess}
 */
export async function spawnCloudflared(tunnelToken, onRestart = null) {
  const binaryPath = await ensureCloudflared();
  
  // Store restart callback and token for network change restart
  if (onRestart) {
    restartCallback = onRestart;
  }
  currentTunnelToken = tunnelToken;
  
  const child = spawn(binaryPath, ["tunnel", "run", "--token", tunnelToken], {
    detached: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  
  isIntentionalShutdown = false;
  console.log(`✅ Cloudflared spawned with PID: ${child.pid}`);
  
  // Wait for 4 connections before resolving (tunnel is truly ready)
  await new Promise((resolve, reject) => {
    let connectionCount = 0;
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) { resolved = true; resolve(child); }
    }, 90000);

    const handleLog = (data) => {
      const msg = data.toString().trim();
      if (LOG_IGNORE.some(pattern => msg.includes(pattern))) return;
      if (isIntentionalShutdown) return;
      if (msg.includes("Registered tunnel connection")) {
        connectionCount++;
        if (connectionCount <= 4) {
          process.stdout.write(`\r   ✔ Connection ${connectionCount}/4 established`);
          if (connectionCount === 4) {
            process.stdout.write("\n");
            if (!resolved) { resolved = true; clearTimeout(timeout); resolve(child); }
          }
        }
        return;
      }
    };

    child.stdout.on("data", handleLog);
    child.stderr.on("data", handleLog);
    child.on("error", (err) => { if (!resolved) { resolved = true; clearTimeout(timeout); reject(err); } });
    child.on("exit", (code) => { if (!resolved) { resolved = true; clearTimeout(timeout); reject(new Error(`cloudflared exited with code ${code}`)); } });
  });

  child.on("error", (error) => {
    console.error("❌ cloudflared error:", error);
  });
  
  child.on("exit", (code, signal) => {
    console.log(`⚠️  Cloudflared process exited (code: ${code}, signal: ${signal}, intentional: ${isIntentionalShutdown})`);
    
    // Restart on ANY unexpected exit (including code 0 if not intentional)
    if (!isIntentionalShutdown) {
      console.log(`⚠️  Cloudflared unexpected exit detected - will restart`);
      
      // Auto-restart logic
      if (restartCallback) {
        const now = Date.now();
        restartTimes.push(now);
        
        // Remove old restart times outside window
        restartTimes = restartTimes.filter(t => t > now - RESTART_WINDOW_MS);
        
        if (restartTimes.length <= MAX_RESTART_ATTEMPTS) {
          console.log(`🔄 Restarting tunnel... (attempt ${restartTimes.length}/${MAX_RESTART_ATTEMPTS})`);
          setTimeout(() => {
            console.log(`🔄 Executing tunnel restart...`);
            restartCallback(tunnelToken);
          }, 2000);
        } else {
          console.log(`❌ Too many tunnel restarts (${MAX_RESTART_ATTEMPTS} in ${RESTART_WINDOW_MS / 1000}s). Giving up.`);
        }
      } else {
        console.log(`⚠️  No restart callback registered`);
      }
    } else {
      console.log(`ℹ️  Cloudflared exit ignored (intentional shutdown)`);
    }
  });
  
  // Save PID
  writePid("cloudflared", child.pid);

  // Start network monitor
  startNetworkMonitor();
  
  return child;
}

/**
 * Kill cloudflared process
 */
export function killCloudflared() {
  // Clean up legacy PID file from older installs (one-time migration)
  try {
    if (fs.existsSync(LEGACY_PID_FILE)) {
      const legacyPid = parseInt(fs.readFileSync(LEGACY_PID_FILE, "utf8"));
      if (Number.isFinite(legacyPid)) {
        isIntentionalShutdown = true;
        try { process.kill(legacyPid); } catch {}
      }
      fs.unlinkSync(LEGACY_PID_FILE);
    }
  } catch {}

  const pid = readPid("cloudflared");
  if (!pid) return;
  isIntentionalShutdown = true;
  try {
    process.kill(pid);
    console.log(`✅ Cloudflared killed`);
  } catch {}
  clearPid("cloudflared");
}

/**
 * Reset restart counter and stop network monitor
 */
export function resetRestartCounter() {
  restartTimes = [];
  restartCallback = null;
  currentTunnelToken = null;
  stopNetworkMonitor();
}

/**
 * Get network state fingerprint (only active interfaces with IP)
 */
function getNetworkFingerprint() {
  const interfaces = os.networkInterfaces();
  const active = [];
  
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (!addr.internal && addr.family === "IPv4") {
        active.push(`${name}:${addr.address}`);
      }
    }
  }
  
  return active.sort().join("|");
}

/**
 * Start network change monitor
 */
function startNetworkMonitor() {
  if (networkMonitorInterval) return;
  
  lastNetworkState = getNetworkFingerprint();
  
  networkMonitorInterval = setInterval(() => {
    const current = getNetworkFingerprint();
    
    if (current !== lastNetworkState) {
      console.log("🔄 Network change detected - restarting tunnel...");
      lastNetworkState = current;
      
      // Kill cloudflared (sets isIntentionalShutdown = true)
      killCloudflared();
      
      // Directly trigger restart instead of relying on exit event
      // (exit event won't restart because isIntentionalShutdown = true)
      if (restartCallback && currentTunnelToken) {
        setTimeout(() => {
          console.log("🔄 Restarting tunnel after network change...");
          restartCallback(currentTunnelToken);
        }, 2000);
      }
    }
  }, 5000);
}

/**
 * Stop network monitor
 */
function stopNetworkMonitor() {
  if (networkMonitorInterval) {
    clearInterval(networkMonitorInterval);
    networkMonitorInterval = null;
  }
  lastNetworkState = null;
}
