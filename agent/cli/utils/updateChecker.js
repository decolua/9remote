import chalk from "chalk";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { fileURLToPath } from "url";
import { spawn, execSync } from "child_process";
import path from "path";
import os from "os";
import { browserFetch } from "../../lib/constants.js";
import { killAll as killAllPids, getPidsDir } from "./pids.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_NAME = "9remote";
const NPM_REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const UPDATE_CHECK_TIMEOUT = 3000;
const SAFETY_TIMEOUT = 8000;
const SERVER_PORT = 2208;
// Legacy path from pre-pids.js installs — clean up once so old instances
// can still be killed during upgrade from older versions.
const LEGACY_CLOUDFLARED_PID_FILE = path.join(os.homedir(), ".9remote", "cloudflared.pid");

/**
 * Kill all 9remote-related child processes to release file locks before npm install.
 *
 * Critical on Windows: node.exe / tray helper / cloudflared.exe lock files inside
 * node_modules\9remote\dist, so `npm i -g` fails with EBUSY when trying to rename
 * the old dist folder.
 *
 * We kill ONLY by PID (from ~/.9remote/pids/) — never by image name (taskkill /IM)
 * or by commandline match, because those would also kill unrelated apps on the
 * machine that happen to use cloudflared.exe, tray_windows_release.exe, or node.exe.
 */
function cleanupBeforeUpdate() {
  // 1. Kill tracked processes (cloudflared + agent tree) via pids.js.
  //    Agent kill with taskkill /F /T sweeps its server child + tray helper.
  try { killAllPids(); } catch {}

  // 2. Legacy: older versions stored cloudflared PID at a different path.
  try {
    if (existsSync(LEGACY_CLOUDFLARED_PID_FILE)) {
      const pid = parseInt(readFileSync(LEGACY_CLOUDFLARED_PID_FILE, "utf8"));
      if (Number.isFinite(pid)) { try { process.kill(pid); } catch {} }
      try { unlinkSync(LEGACY_CLOUDFLARED_PID_FILE); } catch {}
    }
  } catch {}

  // 3. Safety net for stale server on SERVER_PORT (e.g. crashed without clearing PID).
  //    Scoped to one specific port, so we only touch 9remote's own server.
  try {
    if (process.platform === "win32") {
      execSync(`for /f "tokens=5" %a in ('netstat -aon ^| findstr :${SERVER_PORT}') do taskkill /F /PID %a`, { stdio: "ignore", windowsHide: true });
    } else {
      execSync(`lsof -ti:${SERVER_PORT} | xargs kill -9 2>/dev/null || true`, { stdio: "ignore" });
    }
  } catch {}

  // 4. Give Windows a moment to release file handles before npm tries to rename.
  if (process.platform === "win32") {
    const end = Date.now() + 1500;
    while (Date.now() < end) { /* spin-wait; Atomics.wait not worth importing */ }
  }
}

/**
 * Get current version
 */
function getCurrentVersion() {
  // When bundled, version is injected at build time
  if (typeof __CLI_VERSION__ !== "undefined") {
    return __CLI_VERSION__;
  }
  
  // Dev mode: read from package.json
  try {
    const packagePath = path.resolve(__dirname, "../package.json");
    const packageJson = JSON.parse(readFileSync(packagePath, "utf-8"));
    return packageJson.version;
  } catch {
    return null;
  }
}

/**
 * Compare semver versions
 * Returns true if latest > current
 */
export function isNewerVersion(current, latest) {
  const currentParts = current.split(".").map(Number);
  const latestParts = latest.split(".").map(Number);

  for (let i = 0; i < 3; i++) {
    if (latestParts[i] > currentParts[i]) return true;
    if (latestParts[i] < currentParts[i]) return false;
  }
  return false;
}

/**
 * Check if running in restricted environment (Codespaces, Docker)
 */
function isRestrictedEnvironment() {
  if (process.env.CODESPACES === "true" || process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN) {
    return "GitHub Codespaces";
  }
  if (existsSync("/.dockerenv")) {
    return "Docker";
  }
  return null;
}

/**
 * Check for npm updates (non-blocking, notification only)
 */
/**
 * Kill running 9remote processes so user can safely run `npm i -g 9remote@latest`.
 * Called when user chooses manual update from startup menu.
 */
export function stopRunningInstances() {
  cleanupBeforeUpdate();
}

export async function checkForUpdates() {
  try {
    const currentVersion = getCurrentVersion();
    if (!currentVersion) return;

    const response = await browserFetch(NPM_REGISTRY_URL, {
      signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT)
    });

    if (!response.ok) return;

    const data = await response.json();
    const latestVersion = data.version;

    if (latestVersion && isNewerVersion(currentVersion, latestVersion)) {
      console.log(
        chalk.yellow(`\n⬆️  New version ${chalk.green(latestVersion)} available (current: ${currentVersion})`)
      );
      console.log(chalk.gray(`   Run: npm i -g ${PACKAGE_NAME}\n`));
    }
  } catch {
    // Silent fail - don't block CLI
  }
}

/**
 * Check if a newer version exists — returns { current, latest } or null.
 * Silent fail, no auto-update, no spinner.
 */
export async function checkLatestVersion() {
  try {
    const currentVersion = getCurrentVersion();
    if (!currentVersion) return null;
    const response = await browserFetch(NPM_REGISTRY_URL, {
      signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT)
    });
    if (!response.ok) return null;
    const { version: latestVersion } = await response.json();
    if (latestVersion && isNewerVersion(currentVersion, latestVersion)) {
      return { current: currentVersion, latest: latestVersion };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check and auto-update if new version available
 * Returns true if update started (process will exit), false otherwise
 */
export async function checkAndUpdate(skipUpdate = false) {
  if (skipUpdate) return false;

  const currentVersion = getCurrentVersion();
  if (!currentVersion) return false;

  // Spinner frames
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let frameIndex = 0;
  let spinnerInterval = null;

  const startSpinner = (text) => {
    if (process.stdout.isTTY) {
      process.stdout.write(`\r${frames[0]} ${text}`);
      spinnerInterval = setInterval(() => {
        process.stdout.write(`\r${frames[frameIndex++ % frames.length]} ${text}`);
      }, 80);
    }
  };

  const stopSpinner = () => {
    if (spinnerInterval) {
      clearInterval(spinnerInterval);
      spinnerInterval = null;
    }
    if (process.stdout.isTTY) {
      process.stdout.write("\r\x1b[K");
    }
  };

  return new Promise((resolve) => {
    let resolved = false;

    const safeResolve = (value) => {
      if (!resolved) {
        resolved = true;
        stopSpinner();
        resolve(value);
      }
    };

    // Safety timeout to prevent hanging
    const safetyTimer = setTimeout(() => safeResolve(false), SAFETY_TIMEOUT);

    startSpinner("Checking for updates...");

    browserFetch(NPM_REGISTRY_URL, { signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT) })
      .then((res) => res.json())
      .then((data) => {
        if (resolved) return;
        clearTimeout(safetyTimer);

        const latestVersion = data.version;
        if (!latestVersion || !isNewerVersion(currentVersion, latestVersion)) {
          safeResolve(false);
          return;
        }

        stopSpinner();
        console.log(chalk.green(`✅ New version available: ${currentVersion} → ${latestVersion}`));

        // Check restricted environment
        const restrictedEnv = isRestrictedEnvironment();
        if (restrictedEnv) {
          console.log(chalk.yellow(`   ⚠️  ${restrictedEnv} detected - manual update required`));
          console.log(chalk.gray(`   Run: npm install -g ${PACKAGE_NAME}@latest\n`));
          safeResolve(false);
          return;
        }

        console.log(chalk.yellow("🔄 Auto-updating...\n"));

        // Build update script
        const args = process.argv.slice(2).filter((a) => a !== "--skip-update");
        const argsStr = args.join(" ");
        const platform = process.platform;

        let scriptPath, shellCmd;

        // The update script must kill our tracked processes by PID ONLY.
        // Never use `taskkill /IM <image>` or `pkill -f <name>` — those match
        // by binary name / commandline and would nuke unrelated apps on the
        // machine (other cloudflared tunnels, other tray apps, any node.exe).
        const pidsDir = getPidsDir();

        if (platform === "win32") {
          const script = `@echo off
echo 📥 Downloading update...
echo ⏳ Stopping 9remote processes...

REM Kill cloudflared first so it stops reconnecting, then kill the agent
REM tree (/T also terminates its server child + tray helper). PID-based so
REM we never touch unrelated node.exe / cloudflared.exe on this machine.
REM ptyDaemon is intentionally NOT killed — keep terminal sessions alive.
for %%N in (cloudflared agent) do (
  if exist "${pidsDir}\\%%N.pid" (
    for /f %%P in ('type "${pidsDir}\\%%N.pid"') do taskkill /F /T /PID %%P >nul 2>&1
    del /f /q "${pidsDir}\\%%N.pid" >nul 2>&1
  )
)

REM Safety net: kill anything still bound to our server port.
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :${SERVER_PORT}') do taskkill /F /PID %%a >nul 2>&1

REM Let Windows flush file handles before npm renames node_modules\\9remote.
timeout /t 3 /nobreak >nul

echo 🔄 Installing new version...
call npm cache clean --force >nul 2>&1
call npm install -g ${PACKAGE_NAME}@latest --prefer-online

if %ERRORLEVEL% EQU 0 (
  echo ✅ Update completed successfully
  echo 🚀 Restarting with new version...
  ${PACKAGE_NAME} ${argsStr} --skip-update
) else (
  echo ❌ Update failed
  echo 💡 Try manually: npm install -g ${PACKAGE_NAME}
  echo 🔄 Starting with current version...
  ${PACKAGE_NAME} ${argsStr} --skip-update
)
`;
          scriptPath = path.join(os.tmpdir(), `${PACKAGE_NAME}-update.bat`);
          writeFileSync(scriptPath, script);
          shellCmd = ["cmd.exe", ["/c", scriptPath]];
        } else {
          const script = `#!/bin/bash
echo "📥 Downloading update..."
echo "⏳ Stopping 9remote processes..."

# Kill cloudflared first, then the agent (children die with the agent on
# POSIX once the parent process exits and systemd/init reaps them, or here
# because we SIGKILL them via kill -9). PID-based so unrelated apps are safe.
# ptyDaemon is intentionally NOT killed — keep terminal sessions alive.
for name in cloudflared agent; do
  f="${pidsDir}/\${name}.pid"
  if [ -f "$f" ]; then
    pid=$(cat "$f" 2>/dev/null)
    [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null || true
    rm -f "$f"
  fi
done

# Safety net: kill anything still bound to our server port.
lsof -ti:${SERVER_PORT} | xargs kill -9 2>/dev/null || true
sleep 2

echo "🔄 Installing new version..."
npm cache clean --force 2>/dev/null

# Try to install with full output for debugging
npm install -g ${PACKAGE_NAME}@latest --prefer-online 2>&1
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
  echo "✅ Update completed successfully"
  echo "🚀 Restarting with new version..."
  ${PACKAGE_NAME} ${argsStr} --skip-update
else
  echo "❌ Update failed (exit code: $EXIT_CODE)"
  echo "💡 Update manually: npm install -g ${PACKAGE_NAME}@latest"
  echo "🔄 Starting with current version..."
  ${PACKAGE_NAME} ${argsStr} --skip-update
fi
`;
          scriptPath = path.join(os.tmpdir(), `${PACKAGE_NAME}-update.sh`);
          writeFileSync(scriptPath, script, { mode: 0o755 });
          shellCmd = ["sh", [scriptPath]];
        }

        // Cleanup child processes to release file locks before npm install
        cleanupBeforeUpdate();

        // Execute update script in background
        const child = spawn(shellCmd[0], shellCmd[1], {
          detached: true,
          stdio: "inherit"
        });
        child.unref();

        process.exit(0);
      })
      .catch(() => {
        clearTimeout(safetyTimer);
        safeResolve(false);
      });
  });
}
