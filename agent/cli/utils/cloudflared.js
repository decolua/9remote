import fs from "fs";
import path from "path";
import https from "https";
import os from "os";
import net from "net";
import { execSync, spawn } from "child_process";
import { writePid, readPid, clearPid, isAlive } from "./pids.js";
import { createLogger } from "../../lib/logger.js";
import { computeDelay } from "./backoff.js";

const logger = createLogger("tunnel");
import { RETRY_CONFIG, SERVER_PORT } from "../../lib/constants.js";
import { probeTunnelOnce } from "./dnsProbe.js";
import { setLastStatus } from "./tunnelHealth.js";

// Tunnel-only network probe params (not retry-related)
const TUNNEL_CONFIG = {
  networkCheckIntervalMs: 5000,
  networkRestoreDelayMs: 2500,
  internetCheckTimeoutMs: 3000,
  internetCheckHost: "1.1.1.1",
  internetCheckPort: 443,
  // Edge-liveness probe. Separate from the 5s tick: the tick also does cheap
  // local checks (pid, network fingerprint) that are worth running often, while
  // this one crosses the network and must not run on every tick.
  //
  // Killing the tunnel is expensive — the URL changes and every client has to
  // reconnect — so one unlucky probe must not trigger it. trycloudflare offers
  // no uptime guarantee and rate-limits at 200 in-flight requests, so isolated
  // failures are expected; only a sustained one means the edge is really gone.
  // Matches the retry-before-verdict shape already used by the sleep/wake and
  // network-change branches below, and the debounce in tunnelHealth.js.
  edgeProbeIntervalMs: 15000,
  edgeProbeFailureThreshold: 3,
  readyTimeoutMs: 1500,
};

// cloudflared's own readiness endpoint. It reports how many edge connections the
// process currently holds, which is what "is the tunnel alive" actually means —
// unlike our external probe, it involves no DNS and no round trip through the
// edge, so it cannot fail for reasons unrelated to the tunnel.
//
// This matters because cloudflared already repairs itself: it keeps up to 4
// connections to different PoPs, redials with backoff, rotates edge IPs, and
// falls back QUIC->HTTP/2 (supervisor.go: "reconnects them if they disconnect").
// Killing it mid-recovery throws away that work and rotates the URL for nothing.
//
// Served on the first free port in 20241-20245 with no extra flags; /ready is
// 200 with readyConnections>0, 503 when the process holds no connection at all.
const CLOUDFLARED_METRICS_PORTS = [20241, 20242, 20243, 20244, 20245];
let metricsPort = null;

async function fetchReady(port, timeoutMs) {
  try {
    const res = await fetch(`http://localhost:${port}/ready`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json();
    return typeof body?.readyConnections === "number" ? body : null;
  } catch {
    return null;
  }
}

/** Connection count from the metrics server on `port`, but only if it belongs to
 * the tunnel we manage. Any other cloudflared on this machine also answers on
 * these ports, and trusting it would report a healthy tunnel while ours is dead
 * — the one case where a restart really is needed. */
async function readyConnectionsOn(port, timeoutMs) {
  const body = await fetchReady(port, timeoutMs);
  if (!body) return null;
  const host = await fetchQuickTunnelHost(port, timeoutMs);
  // No hostname (named tunnel, older build) is not proof of a mismatch, so it is
  // accepted; a hostname that disagrees with our URL is.
  if (host && activeTunnelUrl && !activeTunnelUrl.includes(host)) return null;
  return body.readyConnections;
}

/** Edge connections cloudflared reports, or null when it cannot be asked (older
 * build, port taken by something else, metrics server not up yet). */
async function readyConnections(timeoutMs) {
  if (metricsPort !== null) {
    const conns = await readyConnectionsOn(metricsPort, timeoutMs);
    if (conns !== null) return conns;
    // Gone, or now serving a different tunnel after a respawn — rediscover.
    metricsPort = null;
  }
  // Probed in parallel, not in sequence: five ports each waiting out the timeout
  // would take 5x longer than the 5s monitor tick, stacking ticks on a machine
  // where nothing answers. In parallel the whole sweep costs one timeout.
  const results = await Promise.all(
    CLOUDFLARED_METRICS_PORTS.map(async (port) => ({
      port,
      conns: await readyConnectionsOn(port, timeoutMs),
    }))
  );
  const hit = results.find((r) => r.conns !== null);
  if (!hit) return null;
  metricsPort = hit.port;
  return hit.conns;
}

async function fetchQuickTunnelHost(port, timeoutMs) {
  try {
    const res = await fetch(`http://localhost:${port}/quicktunnel`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json();
    return body?.hostname || null;
  } catch {
    return null;
  }
}

// Sleep/wake detection — setInterval misses ticks while OS suspends the process,
// so the gap between ticks jumps far past the poll interval. Tuned above CPU spikes.
const SLEEP_DETECT_MS = 30000;
let lastTickAt = 0;

// Network + restart state (module-scoped)
let networkMonitorInterval = null;
let lastNetworkState = null;
let currentRestartArg = null;
let restartCallback = null;
let restartInFlight = false;
let restartFailCount = 0;
let isWaitingForInternet = false;
let activeTunnelUrl = null;
let tunnelReadyAt = 0;
let lastScheduleAt = 0;
let killInFlight = false;
let edgeProbeAt = 0;
let edgeFailStreak = 0;
const NETWORK_CHANGE_COOLDOWN_MS = 30000;
const SCHEDULE_DEBOUNCE_MS = 5000;

const BIN_DIR = path.join(os.homedir(), ".9remote", "bin");
const BINARY_NAME = "cloudflared";
const IS_WINDOWS = os.platform() === "win32";
const BIN_NAME = IS_WINDOWS ? `${BINARY_NAME}.exe` : BINARY_NAME;
const BIN_PATH = path.join(BIN_DIR, BIN_NAME);
// Legacy PID file — kept for one-time cleanup of installs from older versions
const LEGACY_PID_FILE = path.join(os.homedir(), ".9remote", "cloudflared.pid");

// Track intentional shutdown to suppress exit logs
let isIntentionalShutdown = false;
// PID of the cloudflared this module currently owns. A spawn that gets superseded
// (timeout, stale cleanup) leaves its exit handler attached, and that handler must
// not schedule a restart for a process we already replaced.
let currentChildPid = null;

// Pin stable version — avoid "latest" renaming/breakage
const CLOUDFLARED_VERSION = "2026.6.1";
const GITHUB_BASE_URL = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}`;

/**
 * Check internet reachability via a single TCP connect attempt.
 */
function checkInternet() {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch {}
      resolve(ok);
    };
    socket.setTimeout(TUNNEL_CONFIG.internetCheckTimeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    try {
      socket.connect(TUNNEL_CONFIG.internetCheckPort, TUNNEL_CONFIG.internetCheckHost);
    } catch {
      finish(false);
    }
  });
}

// Poll until internet is reachable; never give up
async function waitForInternet() {
  isWaitingForInternet = true;
  try {
    let attempt = 0;
    while (true) {
      attempt++;
      if (await checkInternet()) return;
      await new Promise((r) => setTimeout(r, computeDelay(RETRY_CONFIG.internet, attempt)));
    }
  } finally {
    isWaitingForInternet = false;
  }
}

/**
 * Schedule a tunnel restart. Never gives up. Single-flight to prevent races.
 */
async function scheduleRestart(arg, reason) {
  if (!restartCallback) {
    logger.warn("No restartCallback registered — skip");
    return;
  }
  if (restartInFlight) {
    return;
  }
  // Debounce: collapse bursts (network change + exit handler) within 5s window
  if (Date.now() - lastScheduleAt < SCHEDULE_DEBOUNCE_MS) {
    return;
  }
  lastScheduleAt = Date.now();
  restartInFlight = true;
  try {
    await waitForInternet();
    const delay = computeDelay(RETRY_CONFIG.tunnelRestart, restartFailCount + 1);
    await new Promise((r) => setTimeout(r, delay));
    await restartCallback(arg);
    restartFailCount = 0;
    lastScheduleAt = 0;
  } catch (err) {
    restartFailCount++;
    logger.error(`restart failed (#${restartFailCount}): ${err?.message || err}`);
    // Re-queue next attempt asynchronously to avoid recursion stack growth
    setImmediate(() => {
      restartInFlight = false;
      scheduleRestart(arg, "retry after fail");
    });
    return;
  } finally {
    restartInFlight = false;
  }
}

/**
 * Platform mappings for cloudflared
 */
const PLATFORM_MAPPINGS = {
  darwin: {
    x64: "cloudflared-darwin-amd64.tgz",
    arm64: "cloudflared-darwin-arm64.tgz"
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

    await verifyCloudflaredSha256(url, downloadDest);

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
    try { if (fs.existsSync(downloadDest)) fs.unlinkSync(downloadDest); } catch {}
    console.error("Failed to download cloudflared:", error.message);
    throw error;
  }
}

// Fetch text content via https (no redirect handling needed for raw release files)
function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if ([301, 302].includes(res.statusCode)) return fetchText(res.headers.location).then(resolve).catch(reject);
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => resolve(buf));
    }).on("error", reject);
  });
}

// Verify downloaded cloudflared binary matches sha256 from official release manifest
async function verifyCloudflaredSha256(downloadUrl, filePath) {
  const filename = path.basename(downloadUrl);
  let manifest;
  // Soft verify: manifest unavailable (cloudflare no longer publishes it) → skip, trust HTTPS
  try {
    manifest = await fetchText(`${GITHUB_BASE_URL}/sha256sum.txt`);
  } catch (e) {
    logger.warn(`sha256 manifest unavailable (${e.message}), skipping verify`);
    return;
  }
  const line = manifest.split("\n").find((l) => l.includes(filename));
  if (!line) {
    logger.warn(`No sha256 entry for ${filename}, skipping verify`);
    return;
  }
  const expected = line.trim().split(/\s+/)[0];
  const { createHash } = await import("crypto");
  const actual = createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  if (actual !== expected) throw new Error(`Integrity check failed: SHA256 mismatch (expected ${expected}, got ${actual})`);
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
export async function spawnQuickTunnel(localPort, onUrlUpdate = null, onRestart = null) {
  const binaryPath = await ensureCloudflared();

  // Clear any cloudflared left over from an earlier spawn or a hard agent restart.
  // Uses the PID file, not the port: a cloudflared that never finished connecting
  // has no ESTABLISHED socket, so the port lookup would miss exactly the orphans
  // a timeout leaves behind. The stale process is a different PID than the one we
  // are about to spawn, so its exit event can't be confused with ours.
  const stalePid = readPid("cloudflared");
  if (stalePid && isAlive(stalePid)) {
    logger.info(`killing stale cloudflared pid=${stalePid}`);
    killPid(stalePid);
    clearPid("cloudflared");
  }

  if (onRestart) restartCallback = onRestart;
  currentRestartArg = localPort;

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
  currentChildPid = child.pid;
  isIntentionalShutdown = false;

  return new Promise((resolve, reject) => {
    let resolved = false;
    let lastUrl = null;
    let lastOutput = "";

    const timeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      cleanup();
      // Kill the child — otherwise the retry loop spawns a second cloudflared
      // while this one keeps running, and they pile up across timeouts. Clearing
      // currentChildPid marks it superseded so its exit handler stays quiet.
      if (currentChildPid === child.pid) currentChildPid = null;
      try { child.kill("SIGKILL"); } catch {}
      clearPid("cloudflared");
      reject(new Error("Quick tunnel timed out after 90s"));
    }, 90000);

    const handleLog = (data) => {
      const msg = data.toString();
      lastOutput += msg;
      if (lastOutput.length > 4096) lastOutput = lastOutput.slice(-4096);
      const tunnelUrl = parseQuickTunnelUrl(msg);
      if (!tunnelUrl) return;

      if (!resolved) {
        resolved = true;
        lastUrl = tunnelUrl;
        activeTunnelUrl = tunnelUrl;
        tunnelReadyAt = Date.now();
        // Fresh tunnel — failures counted against the previous one must not carry
        // over, or an inherited streak could kill this one on its first miss.
        edgeFailStreak = 0;
        edgeProbeAt = 0;
        metricsPort = null; // new process may land on a different metrics port
        clearTimeout(timeout);
        cleanup();
        startNetworkMonitor();
        logger.info(`tunnel ready: ${tunnelUrl}`);
        resolve({ child, tunnelUrl });
        return;
      }

      // URL rotated after initial connect — notify caller
      if (tunnelUrl !== lastUrl) {
        logger.info(`URL rotated: ${tunnelUrl}`);
        lastUrl = tunnelUrl;
        activeTunnelUrl = tunnelUrl;
        tunnelReadyAt = Date.now();
        edgeFailStreak = 0;
        edgeProbeAt = 0;
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

    child.on("exit", (code, signal) => {
      cleanup();
      // Superseded child (timed out, or replaced by a newer spawn) — its death is
      // expected and must not drive status or trigger another restart.
      const superseded = currentChildPid !== child.pid;
      const quiet = isIntentionalShutdown || superseded;
      logger.info(`cloudflared exited (intentional=${isIntentionalShutdown} superseded=${superseded})`);
      if (!quiet) setLastStatus("unreachable");
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        const tail = lastOutput.trim().split("\n").slice(-5).join(" | ");
        // Died before the tunnel came up: reject only. The caller's retry loop
        // (spawnQuickTunnelWithRetry) owns the retry — also calling
        // scheduleRestart here would spawn two cloudflared for one failure.
        currentChildPid = null;
        reject(new Error(`cloudflared exited (code=${code}, signal=${signal}) output: ${tail || "(empty)"}`));
        return;
      }
      if (!quiet) {
        scheduleRestart(localPort, `quick tunnel exit code ${code}`);
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

  if (onRestart) restartCallback = onRestart;
  currentRestartArg = tunnelToken;
  
  const child = spawn(binaryPath, ["tunnel", "run", "--token", tunnelToken], {
    detached: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  
  isIntentionalShutdown = false;

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
          process.stdout.write(`\r   Connection ${connectionCount}/4 established`);
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
    console.error("cloudflared error:", error);
  });
  
  child.on("exit", (code, signal) => {
    logger.warn(`Cloudflared process exited (code: ${code}, signal: ${signal}, intentional: ${isIntentionalShutdown})`);
    if (isIntentionalShutdown) return;
    scheduleRestart(tunnelToken, `tunnel exit code ${code}${signal ? `/${signal}` : ""}`);
  });
  
  // Save PID
  writePid("cloudflared", child.pid);

  // Start network monitor
  startNetworkMonitor();
  
  return child;
}

// Windows: taskkill /T /F kills entire process tree; SIGTERM only stops parent
function killPid(pid) {
  if (IS_WINDOWS) {
    try { execSync(`taskkill /PID ${pid} /T /F`, { windowsHide: true, stdio: "ignore" }); } catch {}
  } else {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
}

// Find cloudflared PIDs holding TCP to localhost:port — filtered by image name to avoid false positives
function killCloudflaredByPort(port) {
  try {
    let pids = [];
    if (IS_WINDOWS) {
      const ps = `Get-NetTCPConnection -LocalPort ${port} -State Established -ErrorAction SilentlyContinue | Where-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).Name -eq 'cloudflared' } | Select-Object -ExpandProperty OwningProcess -Unique`;
      const out = execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      pids = out.split(/\r?\n/).map((s) => +s.trim()).filter(Boolean);
    } else {
      const out = execSync(
        `lsof -nP -iTCP:${port} -sTCP:ESTABLISHED 2>/dev/null | awk '/cloudflar/ {print $2}' | sort -u`,
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      pids = out.split("\n").map((s) => +s.trim()).filter(Boolean);
    }
    for (const p of new Set(pids)) { killPid(p); }
  } catch {}
}

export function killCloudflared() {
  if (killInFlight) return;
  killInFlight = true;
  try {
    // One-time legacy PID file cleanup
    try {
      if (fs.existsSync(LEGACY_PID_FILE)) {
        const legacyPid = parseInt(fs.readFileSync(LEGACY_PID_FILE, "utf8"));
        if (Number.isFinite(legacyPid)) {
          isIntentionalShutdown = true;
          killPid(legacyPid);
        }
        fs.unlinkSync(LEGACY_PID_FILE);
      }
    } catch {}

    const pid = readPid("cloudflared");
    isIntentionalShutdown = true;
    currentChildPid = null;
    if (pid) {
      killPid(pid);
      clearPid("cloudflared");
    }

    killCloudflaredByPort(SERVER_PORT);
  } finally {
    setTimeout(() => { killInFlight = false; }, 2000);
  }
}

/**
 * Reset restart counter and stop network monitor
 */
/** A cloudflared is running and has a URL. Used by the background reconnect loop
 * to stand down instead of spawning over a tunnel that recovered by another path
 * (restart handler, network-change restart) while the loop was in its backoff. */
export function hasLiveTunnel() {
  if (!activeTunnelUrl) return false;
  const pid = readPid("cloudflared");
  return !!pid && isAlive(pid);
}

export function resetRestartCounter() {
  restartFailCount = 0;
  restartInFlight = false;
  restartCallback = null;
  currentRestartArg = null;
  activeTunnelUrl = null;
  edgeFailStreak = 0;
  edgeProbeAt = 0;
  metricsPort = null;
  stopNetworkMonitor();
}

// Skip virtual/transient interfaces that flap during boot, sleep, or VPN connect
const VIRTUAL_IFACE_REGEX = /^(utun|awdl|llw|anpi|bridge|gif|stf|ipsec|ap|tun|tap|vmnet|veth|docker)/i;

/**
 * Get network state fingerprint (only physical active interfaces with IPv4)
 */
function getNetworkFingerprint() {
  const interfaces = os.networkInterfaces();
  const active = [];

  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    if (VIRTUAL_IFACE_REGEX.test(name)) continue;
    for (const addr of addrs) {
      if (!addr.internal && addr.family === "IPv4") {
        active.push(`${name}:${addr.address}`);
      }
    }
  }

  return active.sort().join("|");
}

/**
 * Start network change monitor (event-driven).
 * Polls only local interface fingerprint (cheap syscall, no network IO).
 * When fingerprint changes: wait for stabilization, confirm Internet via TCP probe,
 * then restart tunnel. Avoids periodic Internet pings.
 */
function startNetworkMonitor() {
  if (networkMonitorInterval) return;

  lastNetworkState = getNetworkFingerprint();
  lastTickAt = Date.now();

  networkMonitorInterval = setInterval(async () => {
   try {
    // Time gap between ticks — must track before any early return so a long
    // restartInFlight / waitForInternet window isn't misread as sleep on the next tick.
    const now = Date.now();
    const gap = now - lastTickAt;
    lastTickAt = now;

    if (isWaitingForInternet || restartInFlight) return;
    if (!restartCallback || currentRestartArg == null) return;

    // Sleep/wake: gap >> poll interval → OS suspended us (clamshell, idle sleep).
    // Probe first — cloudflared may have auto-reconnected after wake, no kill needed.
    if (gap > SLEEP_DETECT_MS) {
      logger.info(`Sleep/wake detected (gap=${gap}ms)`);
      if (activeTunnelUrl) {
        let survived = false;
        for (let i = 0; i < 3; i++) {
          const probe = await probeTunnelOnce(activeTunnelUrl);
          if (probe.ok) { survived = true; break; }
          if (i < 2) await new Promise((r) => setTimeout(r, 3000));
        }
        if (survived) { return; }
        logger.info("tunnel unresponsive after sleep → restarting");
      }
      setLastStatus("unreachable");
      killCloudflared();
      scheduleRestart(currentRestartArg, "woke from sleep");
      return;
    }

    const current = getNetworkFingerprint();
    const fingerprintChanged = current !== lastNetworkState;
    lastNetworkState = current;

    // Liveness watchdog — catches cases where exit-restart chain stopped
    // (e.g. callback never re-armed) or fingerprint never changed after reconnect.
    const pid = readPid("cloudflared");
    const cloudflaredDead = !pid || !isAlive(pid);

    if (!fingerprintChanged && !cloudflaredDead) {
      // Process alive, no network change — but the edge connection may have died
      // silently (cloudflared stays running). Probe periodically, and only act
      // once the failures are consecutive: a single miss is far more often a DNS
      // hiccup or a slow response than a dead edge, and killing on it costs the
      // URL. The streak resets on any success, so a real outage still converges.
      //
      // Counted across ticks rather than retried inside one: the tick fires every
      // 5s, so awaiting several probes here would overrun the interval.
      if (activeTunnelUrl && tunnelReadyAt
          && Date.now() - tunnelReadyAt > NETWORK_CHANGE_COOLDOWN_MS
          && now - edgeProbeAt >= TUNNEL_CONFIG.edgeProbeIntervalMs) {
        edgeProbeAt = now;
        const probe = await probeTunnelOnce(activeTunnelUrl);
        if (probe.ok) {
          edgeFailStreak = 0;
        } else if (++edgeFailStreak >= TUNNEL_CONFIG.edgeProbeFailureThreshold) {
          // Last word before killing: ask cloudflared itself. While it still holds
          // an edge connection the fault is on the path to us (DNS, ISP, the edge
          // POP for our region), and a restart would not fix it — it would only
          // rotate the URL and disconnect every client. Only act when the process
          // reports no connections, or cannot be asked at all.
          const conns = await readyConnections(TUNNEL_CONFIG.readyTimeoutMs);
          if (conns > 0) {
            logger.info(`edge probe failing but cloudflared holds ${conns} connection(s) — not restarting`);
            edgeFailStreak = 0;
            return;
          }
          logger.warn(`tunnel unreachable but cloudflared alive — edge lost after ${edgeFailStreak} probes (ready=${conns ?? "unknown"}), restarting`);
          edgeFailStreak = 0;
          setLastStatus("unreachable");
          killCloudflared();
          scheduleRestart(currentRestartArg, "tunnel unreachable (edge lost)");
        } else {
          logger.debug(`edge probe failed (${edgeFailStreak}/${TUNNEL_CONFIG.edgeProbeFailureThreshold}) — ${probe.dnsCode ?? probe.httpStatus ?? "no response"}`);
        }
      }
      return;
    }

    // Cooldown: skip network-change kill within 30s of tunnel ready (avoids killing during DHCP stabilization)
    if (fingerprintChanged && !cloudflaredDead && tunnelReadyAt && Date.now() - tunnelReadyAt < NETWORK_CHANGE_COOLDOWN_MS) {
      return;
    }

    if (fingerprintChanged) logger.info("Network change detected");
    if (cloudflaredDead) logger.warn("cloudflared not alive — watchdog");
    setLastStatus("unreachable");

    // Wait briefly for network to stabilize (DHCP, RA, VPN auto-connect)
    await new Promise((r) => setTimeout(r, TUNNEL_CONFIG.networkRestoreDelayMs));

    if (!(await checkInternet())) return;

    // Smart kill: probe twice (2s gap) — avoid false negatives during network handoff
    if (fingerprintChanged && !cloudflaredDead && activeTunnelUrl) {
      let survived = false;
      for (let i = 0; i < 2; i++) {
        const probe = await probeTunnelOnce(activeTunnelUrl);
        if (probe.ok) { survived = true; break; }
        if (i === 0) await new Promise((r) => setTimeout(r, 2000));
      }
      if (survived) {
        logger.info("Tunnel survived network change, skip restart");
        return;
      }
    }

    if (fingerprintChanged && !cloudflaredDead) killCloudflared();
    scheduleRestart(currentRestartArg, fingerprintChanged ? "network change" : "liveness watchdog");
   } catch (err) {
     logger.error(`network monitor tick failed: ${err?.message || err}`);
   }
  }, TUNNEL_CONFIG.networkCheckIntervalMs);
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
