import fs from "fs";
import path from "path";
import https from "https";
import os from "os";
import { execSync, spawn } from "child_process";

const BIN_DIR = path.join(os.homedir(), ".9remote", "bin");
const BINARY_NAME = "cloudflared";
const IS_WINDOWS = os.platform() === "win32";
const BIN_NAME = IS_WINDOWS ? `${BINARY_NAME}.exe` : BINARY_NAME;
const BIN_PATH = path.join(BIN_DIR, BIN_NAME);
const PID_FILE = path.join(os.homedir(), ".9remote", "cloudflared.pid");

// Track intentional shutdown to suppress exit logs
let isIntentionalShutdown = false;

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

/**
 * Download file from URL
 */
async function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    
    https.get(url, (response) => {
      if ([301, 302].includes(response.statusCode)) {
        file.close();
        fs.unlinkSync(dest);
        downloadFile(response.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      
      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        reject(new Error(`Download failed with status ${response.statusCode}`));
        return;
      }
      
      response.pipe(file);
      
      file.on("finish", () => {
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
 */
export async function ensureCloudflared() {
  if (!fs.existsSync(BIN_DIR)) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
  }
  
  if (fs.existsSync(BIN_PATH)) {
    if (!IS_WINDOWS) {
      fs.chmodSync(BIN_PATH, "755");
    }
    return BIN_PATH;
  }
  
  console.log("📥 Downloading tunnel binary...");
  
  const url = getDownloadUrl();
  const isArchive = url.endsWith(".tgz");
  const downloadDest = isArchive ? path.join(BIN_DIR, "cloudflared.tgz") : BIN_PATH;
  
  try {
    await downloadFile(url, downloadDest);
    
    if (isArchive) {
      console.log("✅ Extracting...");
      execSync(`tar -xzf "${downloadDest}" -C "${BIN_DIR}"`, { stdio: "pipe" });
      fs.unlinkSync(downloadDest);
    }
    
    if (!IS_WINDOWS) {
      fs.chmodSync(BIN_PATH, "755");
    }
    
    console.log("✅ cloudflared ready");
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
 * Spawn cloudflared tunnel
 * @param {string} tunnelToken
 * @returns {ChildProcess}
 */
export async function spawnCloudflared(tunnelToken) {
  const binaryPath = await ensureCloudflared();
  
  const child = spawn(binaryPath, ["tunnel", "run", "--token", tunnelToken], {
    detached: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  
  let connectionCount = 0;
  
  const handleLog = (data) => {
    const msg = data.toString().trim();
    
    // Skip ignored messages
    if (LOG_IGNORE.some(pattern => msg.includes(pattern))) {
      return;
    }
    
    // Skip errors during intentional shutdown
    if (isIntentionalShutdown) {
      return;
    }
    
    // Show connection status briefly
    if (msg.includes("Registered tunnel connection")) {
      connectionCount++;
      if (connectionCount <= 4) {
        process.stdout.write(`\r   ✔ Connection ${connectionCount}/4 established`);
        if (connectionCount === 4) {
          process.stdout.write("\n");
        }
      }
      return;
    }
    
    // Show errors
    if (msg.includes("ERR") || msg.includes("error") || msg.includes("failed")) {
      console.error(`[cloudflared] ${msg}`);
    }
  };
  
  child.stdout.on("data", handleLog);
  child.stderr.on("data", handleLog);
  
  child.on("error", (error) => {
    console.error("❌ cloudflared error:", error);
  });
  
  child.on("exit", (code) => {
    // Only log unexpected exits
    if (!isIntentionalShutdown && code !== 0 && code !== null) {
      console.log(`cloudflared exited with code ${code}`);
    }
  });
  
  // Save PID
  fs.writeFileSync(PID_FILE, child.pid.toString());
  
  return child;
}

/**
 * Kill cloudflared process
 */
export function killCloudflared() {
  try {
    if (fs.existsSync(PID_FILE)) {
      isIntentionalShutdown = true;
      const pid = parseInt(fs.readFileSync(PID_FILE, "utf8"));
      process.kill(pid);
      fs.unlinkSync(PID_FILE);
    }
  } catch (error) {
    // Silently ignore errors
  }
}
