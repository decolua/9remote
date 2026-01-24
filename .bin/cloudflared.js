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
  
  console.log("📥 Downloading cloudflared...");
  
  const url = getDownloadUrl();
  const isArchive = url.endsWith(".tgz");
  const downloadDest = isArchive ? path.join(BIN_DIR, "cloudflared.tgz") : BIN_PATH;
  
  try {
    await downloadFile(url, downloadDest);
    
    if (isArchive) {
      console.log("📦 Extracting...");
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
  
  child.stdout.on("data", (data) => {
    console.log(`[cloudflared] ${data.toString().trim()}`);
  });
  
  child.stderr.on("data", (data) => {
    console.error(`[cloudflared] ${data.toString().trim()}`);
  });
  
  child.on("error", (error) => {
    console.error("❌ cloudflared error:", error);
  });
  
  child.on("exit", (code) => {
    console.log(`cloudflared exited with code ${code}`);
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
      const pid = parseInt(fs.readFileSync(PID_FILE, "utf8"));
      process.kill(pid);
      fs.unlinkSync(PID_FILE);
      console.log("✅ cloudflared stopped");
    }
  } catch (error) {
    console.error("Error killing cloudflared:", error.message);
  }
}
