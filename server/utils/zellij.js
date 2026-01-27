import fs from "fs";
import path from "path";
import https from "https";
import os from "os";
import { execSync, spawn } from "child_process";

const BIN_DIR = path.join(os.homedir(), ".9remote", "bin");
const BINARY_NAME = "zellij";
const IS_WINDOWS = os.platform() === "win32";
const BIN_NAME = IS_WINDOWS ? `${BINARY_NAME}.exe` : BINARY_NAME;
const BIN_PATH = path.join(BIN_DIR, BIN_NAME);

const GITHUB_BASE_URL = "https://github.com/zellij-org/zellij/releases/latest/download";

/**
 * Platform mappings for Zellij
 */
const PLATFORM_MAPPINGS = {
  darwin: {
    x64: "zellij-x86_64-apple-darwin.tar.gz",
    arm64: "zellij-aarch64-apple-darwin.tar.gz"
  },
  win32: {
    x64: "zellij-x86_64-pc-windows-msvc.zip"
  },
  linux: {
    x64: "zellij-x86_64-unknown-linux-musl.tar.gz",
    arm64: "zellij-aarch64-unknown-linux-musl.tar.gz"
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
 * Extract archive
 */
function extractArchive(archivePath, destDir) {
  const isZip = archivePath.endsWith(".zip");
  
  if (isZip) {
    // Windows zip
    if (IS_WINDOWS) {
      execSync(`powershell -command "Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force"`, { stdio: "pipe" });
    } else {
      execSync(`unzip -o "${archivePath}" -d "${destDir}"`, { stdio: "pipe" });
    }
  } else {
    // tar.gz
    execSync(`tar -xzf "${archivePath}" -C "${destDir}"`, { stdio: "pipe" });
  }
}

/**
 * Ensure Zellij binary exists
 */
export async function ensureZellij() {
  if (!fs.existsSync(BIN_DIR)) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
  }
  
  if (fs.existsSync(BIN_PATH)) {
    if (!IS_WINDOWS) {
      fs.chmodSync(BIN_PATH, "755");
    }
    // Ensure minimal config exists
    ensureZellijConfig();
    return BIN_PATH;
  }
  
  console.log("📥 Downloading Zellij binary...");
  
  const url = getDownloadUrl();
  const isArchive = url.endsWith(".tar.gz") || url.endsWith(".zip");
  const downloadDest = isArchive 
    ? path.join(BIN_DIR, path.basename(url))
    : BIN_PATH;
  
  try {
    await downloadFile(url, downloadDest);
    
    if (isArchive) {
      console.log("✅ Extracting...");
      extractArchive(downloadDest, BIN_DIR);
      fs.unlinkSync(downloadDest);
    }
    
    if (!IS_WINDOWS) {
      fs.chmodSync(BIN_PATH, "755");
    }
    
    // Create minimal config
    ensureZellijConfig();
    
    console.log("✅ Zellij ready");
    return BIN_PATH;
  } catch (error) {
    console.error("❌ Failed to download Zellij:", error.message);
    throw error;
  }
}

/**
 * Ensure minimal Zellij config and layout exist
 * Use dedicated config for 9remote to avoid conflicts with user's config
 */
function ensureZellijConfig() {
  const configPath = path.join(BIN_DIR, "9remote-zellij.kdl");
  const layoutPath = path.join(BIN_DIR, "9remote.kdl");
  
  // Get default shell
  const defaultShell = process.env.SHELL || "/bin/bash";
  const isWindows = process.platform === "win32";
  
  // Config: disable all UI elements and popups
  const minimalConfig = `// Minimal Zellij config for 9remote
pane_frames false
simplified_ui true
mouse_mode true
scroll_buffer_size 10000
show_startup_tips false
show_release_notes false
default_layout "9remote"
layout_dir "${BIN_DIR.replace(/\\/g, "/")}"
`;
  
  // Layout: single pane with login shell command (loads .bashrc/.zshrc)
  // Use command + args to run shell as login shell with -l flag
  const minimalLayout = isWindows 
    ? `layout {
    pane borderless=true command="${defaultShell}"
}
`
    : `layout {
    pane borderless=true {
        command "${defaultShell}"
        args "-l"
    }
}
`;
  
  fs.writeFileSync(configPath, minimalConfig, "utf8");
  fs.writeFileSync(layoutPath, minimalLayout, "utf8");
  
  return configPath;
}

/**
 * Check if Zellij is available
 */
export function isZellijAvailable() {
  return fs.existsSync(BIN_PATH);
}

/**
 * List all Zellij sessions
 */
export async function listZellijSessions() {
  if (!isZellijAvailable()) {
    return [];
  }
  
  try {
    const output = execSync(`"${BIN_PATH}" list-sessions`, { 
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" }
    });
    
    // Strip ANSI color codes
    const cleanOutput = output.replace(/\x1b\[[0-9;]*m/g, "");
    
    // Parse output: session_name [Created Xm Ys ago]
    const sessions = [];
    const lines = cleanOutput.trim().split("\n");
    
    for (const line of lines) {
      // Match: "session-name [Created ...]"
      const match = line.match(/^([^\s\[]+)/);
      if (match) {
        const sessionName = match[1].trim();
        if (sessionName) {
          sessions.push({
            name: sessionName,
            attached: false
          });
        }
      }
    }
    
    return sessions;
  } catch (error) {
    // No sessions or error
    return [];
  }
}

/**
 * Attach to Zellij session via PTY
 * Returns PTY process that can be used for I/O
 */
export function attachZellijSession(sessionName, pty, shellEnv, cwd) {
  if (!isZellijAvailable()) {
    throw new Error("Zellij not available");
  }
  
  // Use dedicated 9remote config file
  const configPath = path.join(BIN_DIR, "9remote-zellij.kdl");
  
  // Spawn PTY with Zellij attach using minimal config
  const args = [
    "--config", configPath,
    "attach", sessionName,
    "--create"
  ];
  
  const ptyProcess = pty.spawn(BIN_PATH, args, {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd,
    env: {
      ...shellEnv,
      ZELLIJ_AUTO_ATTACH: "false",
      ZELLIJ_AUTO_EXIT: "true"
    },
    useConpty: process.platform === "win32" // Use ConPTY on Windows
  });
  
  return ptyProcess;
}

/**
 * Kill/Delete Zellij session
 * Uses delete-session with --force to handle both running and exited sessions
 */
export function killZellijSession(sessionName) {
  if (!isZellijAvailable()) {
    return;
  }
  
  try {
    // Use delete-session with --force to kill running session and delete it
    execSync(`"${BIN_PATH}" delete-session --force "${sessionName}"`, { 
      stdio: "pipe",
      timeout: 5000
    });
    console.log(`✅ Deleted Zellij session: ${sessionName}`);
  } catch (error) {
    // Session might not exist
    console.log(`⚠️  Failed to delete session ${sessionName}: ${error.message}`);
  }
}

/**
 * Get session info
 */
export async function getZellijSessionInfo(sessionName) {
  const sessions = await listZellijSessions();
  return sessions.find(s => s.name === sessionName);
}
