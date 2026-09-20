import chalk from "chalk";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { fileURLToPath } from "url";
import { spawn, execSync } from "child_process";
import path from "path";
import os from "os";
import { browserFetch, NPM_REGISTRY_URL, NPM_INSTALL_SPEC, PACKAGE_NAME, PATHS } from "../../lib/constants.js";
import { killAll as killAllPids, getPidsDir } from "./pids.js";
import { getCliEntry, getNodeBin, nodeBinEnvPrefix } from "./autostart.js";
import { UPDATE } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPDATE_CHECK_TIMEOUT = 3000;
const SAFETY_TIMEOUT = 8000;
const SERVER_PORT = 2208;
// Legacy cloudflared PID path for cleanup during upgrade from older versions
const LEGACY_CLOUDFLARED_PID_FILE = path.join(os.homedir(), ".9remote", "cloudflared.pid");

// Releases file locks by PID before update to avoid EBUSY on Windows
function cleanupBeforeUpdate() {
  try { killAllPids(); } catch {}

  try {
    if (existsSync(LEGACY_CLOUDFLARED_PID_FILE)) {
      const pid = parseInt(readFileSync(LEGACY_CLOUDFLARED_PID_FILE, "utf8"));
      if (Number.isFinite(pid)) { try { process.kill(pid); } catch {} }
      try { unlinkSync(LEGACY_CLOUDFLARED_PID_FILE); } catch {}
    }
  } catch {}

  try {
    if (process.platform === "win32") {
      execSync(`for /f "tokens=5" %a in ('netstat -aon ^| findstr :${SERVER_PORT}') do taskkill /F /PID %a`, { stdio: "ignore", windowsHide: true });
    } else {
      execSync(`lsof -ti:${SERVER_PORT} | xargs kill -9 2>/dev/null || true`, { stdio: "ignore" });
    }
  } catch {}

  if (process.platform === "win32") {
    const end = Date.now() + 1500;
    while (Date.now() < end) {}
  }
}

function getCurrentVersion() {
  if (typeof __CLI_VERSION__ !== "undefined") {
    return __CLI_VERSION__;
  }

  try {
    const packagePath = path.resolve(__dirname, "../../package.json");
    const packageJson = JSON.parse(readFileSync(packagePath, "utf-8"));
    return packageJson.version;
  } catch {
    return null;
  }
}

export function isNewerVersion(current, latest) {
  const currentParts = current.split(".").map(Number);
  const latestParts = latest.split(".").map(Number);

  for (let i = 0; i < 3; i++) {
    if (latestParts[i] > currentParts[i]) return true;
    if (latestParts[i] < currentParts[i]) return false;
  }
  return false;
}

function isRestrictedEnvironment() {
  if (process.env.CODESPACES === "true" || process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN) {
    return "GitHub Codespaces";
  }
  if (existsSync("/.dockerenv")) {
    return "Docker";
  }
  return null;
}

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
  }
}

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

export async function checkAndUpdate(skipUpdate = false) {
  if (skipUpdate) return false;

  const currentVersion = getCurrentVersion();
  if (!currentVersion) return false;

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

        const restrictedEnv = isRestrictedEnvironment();
        if (restrictedEnv) {
          console.log(chalk.yellow(`   ⚠️  ${restrictedEnv} detected - manual update required`));
          console.log(chalk.gray(`   Run: npm install -g ${PACKAGE_NAME}@latest\n`));
          safeResolve(false);
          return;
        }

        console.log(chalk.yellow("🔄 Auto-updating...\n"));

        const args = process.argv.slice(2).filter((a) => a !== "--skip-update");
        const argsStr = args.join(" ");
        const platform = process.platform;

        let scriptPath, shellCmd;
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

        cleanupBeforeUpdate();

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

const LOCK_PATH = path.join(PATHS.STATE, UPDATE.lockFile);

// Skip if a fresh lock held by a live process exists
function acquireUpdateLock() {
  try {
    if (existsSync(LOCK_PATH)) {
      const { pid, ts } = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
      const fresh = Date.now() - ts < UPDATE.lockTtlMs;
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch {}
      if (fresh && alive) return false;
    }
  } catch {}
  try { writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, ts: Date.now() })); } catch {}
  return true;
}

async function fetchLatestVersion() {
  try {
    const res = await browserFetch(NPM_REGISTRY_URL, { signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT) });
    if (!res.ok) return null;
    const { version } = await res.json();
    return version || null;
  } catch { return null; }
}

function registryFlag() {
  try {
    if (process.env.NREMOTE_REGISTRY) return `--registry ${new URL(process.env.NREMOTE_REGISTRY).origin}`;
  } catch {}
  return "";
}

// Install back into prefix to avoid mislocating Electron-bundled installs
function prefixFlag() {
  const cli = getCliEntry();
  const sep = path.sep;
  for (const marker of [`${sep}lib${sep}node_modules${sep}`, `${sep}node_modules${sep}`]) {
    const i = cli.indexOf(marker);
    if (i > 0) return `--prefix "${cli.slice(0, i)}"`;
  }
  return "";
}

// Fallback to bundled npm and Electron Node if system npm is missing
function npmCommand() {
  const bundled = process.env.NREMOTE_NPM_CLI;
  if (bundled && existsSync(bundled)) {
    return process.platform === "win32"
      ? `"${getNodeBin()}" "${bundled}"`
      : `env ELECTRON_RUN_AS_NODE=1 "${getNodeBin()}" "${bundled}"`;
  }
  return "npm";
}

function buildUpdateScript({ currentVersion, latest, agentPid }) {
  const pidsDir = getPidsDir();
  const reg = registryFlag();
  const nodeBin = getNodeBin();
  const nodeEnv = nodeBinEnvPrefix();
  const cliEntry = getCliEntry();
  const lock = LOCK_PATH;
  const npmFlags = `--prefer-online --no-audit --no-fund ${reg} ${prefixFlag()}`.trim();
  const npm = npmCommand();

  if (process.platform === "win32") {
    const restartVbsPath = path.join(os.tmpdir(), `${PACKAGE_NAME}-restart.vbs`);
    const script = `@echo off
setlocal EnableDelayedExpansion
set "NODE=${nodeBin}"
set "CLI=${cliEntry}"
${process.env.NREMOTE_NPM_CLI ? 'set "ELECTRON_RUN_AS_NODE=1"' : ""}

:waitloop
tasklist /FI "PID eq ${agentPid}" 2>nul | find "${agentPid}" >nul
if not errorlevel 1 (
  timeout /t 1 /nobreak >nul
  goto waitloop
)

for %%N in (cloudflared agent) do (
  if exist "${pidsDir}\\%%N.pid" (
    for /f %%P in ('type "${pidsDir}\\%%N.pid"') do taskkill /F /T /PID %%P >nul 2>&1
    del /f /q "${pidsDir}\\%%N.pid" >nul 2>&1
  )
)
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :${SERVER_PORT}') do taskkill /F /PID %%a >nul 2>&1
timeout /t 3 /nobreak >nul

set ATTEMPT=0
:installloop
set /a ATTEMPT+=1
call ${npm} install -g ${NPM_INSTALL_SPEC} ${npmFlags} >nul 2>&1
if !ERRORLEVEL! EQU 0 goto verify
if !ATTEMPT! GEQ ${UPDATE.maxRetry} (
  call ${npm} install -g ${NPM_INSTALL_SPEC} ${npmFlags} --omit=optional >nul 2>&1
  goto verify
)
timeout /t 3 /nobreak >nul
goto installloop

:verify
set "NEWVER="
set "VERFILE=%TEMP%\\${PACKAGE_NAME}-ver.txt"
"%NODE%" "%CLI%" --version > "%VERFILE%" 2>nul
REM Read first line + strip surrounding whitespace/CR via for/f tokens
for /f "usebackq tokens=* delims= " %%V in ("%VERFILE%") do (
  set "NEWVER=%%V"
  goto :gotver
)
:gotver
del /f /q "%VERFILE%" >nul 2>&1
if defined NEWVER set "NEWVER=!NEWVER: =!"
if not "!NEWVER!"=="${latest}" (
  call ${npm} install -g ${PACKAGE_NAME}@${currentVersion} ${npmFlags} >nul 2>&1
)
del /f /q "${lock}" >nul 2>&1

wscript "${restartVbsPath}"
exit /b 0
`;
    const scriptPath = path.join(os.tmpdir(), `${PACKAGE_NAME}-update.bat`);
    writeFileSync(scriptPath, script);
    // Restart launcher: node agent is NOT a child of the batch, keeps running after .bat exits.
    // Run window style 0 = invisible; False = don't wait.
    writeFileSync(
      restartVbsPath,
      `CreateObject("WScript.Shell").Run "\"\"%NODE%\"\" \"\"%CLI%\"\" --tray --skip-update --start", 0, False`
        .replace("%NODE%", nodeBin).replace("%CLI%", cliEntry) + "\n"
    );
    // Launch .bat fully hidden + detached via VBS (window style 0 = no console flash).
    const vbsPath = path.join(os.tmpdir(), `${PACKAGE_NAME}-update.vbs`);
    writeFileSync(vbsPath, `CreateObject("WScript.Shell").Run "cmd /c ""${scriptPath}""", 0, False\n`);
    return { shellCmd: ["wscript.exe", [vbsPath]], windowsVerbatim: false };
  }

  const script = `#!/bin/bash
# Wait for agent to exit so it releases the cli.cjs file lock
while kill -0 ${agentPid} 2>/dev/null; do sleep 1; done

# Kill tracked PIDs only (never ptyDaemon → sessions survive)
for name in cloudflared agent; do
  f="${pidsDir}/\${name}.pid"
  if [ -f "$f" ]; then
    pid=$(cat "$f" 2>/dev/null)
    [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null || true
    rm -f "$f"
  fi
done
lsof -ti:${SERVER_PORT} | xargs kill -9 2>/dev/null || true
sleep 2

attempt=0
while [ $attempt -lt ${UPDATE.maxRetry} ]; do
  attempt=$((attempt+1))
  echo "Installing (attempt $attempt)..."
  if ${npm} install -g ${NPM_INSTALL_SPEC} ${npmFlags}; then break; fi
  if [ $attempt -eq ${UPDATE.maxRetry} ]; then
    ${npm} install -g ${NPM_INSTALL_SPEC} ${npmFlags} --omit=optional || true
  fi
  sleep 3
done

# Verify version == latest; roll back if the new binary is broken/wrong (R2)
# Take first line + strip ANSI escapes so trailing cursor codes don't corrupt compare
NEWVER=$(${nodeEnv}"${nodeBin}" "${cliEntry}" --version 2>/dev/null | head -1 | sed 's/\x1b\[[0-9;?]*[a-zA-Z]//g' | tr -d '[:space:]')
if [ "$NEWVER" != "${latest}" ]; then
  echo "Verify failed (got $NEWVER, want ${latest}), rolling back to ${currentVersion}..."
  ${npm} install -g ${PACKAGE_NAME}@${currentVersion} ${npmFlags} || true
fi

rm -f "${lock}"
${nodeEnv}"${nodeBin}" "${cliEntry}" --tray --skip-update --start
`;
  const scriptPath = path.join(os.tmpdir(), `${PACKAGE_NAME}-update.sh`);
  writeFileSync(scriptPath, script, { mode: 0o755 });
  return { shellCmd: ["sh", [scriptPath]], windowsVerbatim: false };
}

export async function runWebUpdate() {
  const currentVersion = getCurrentVersion();
  if (!currentVersion) return false;
  if (isRestrictedEnvironment()) return false;

  const latest = await fetchLatestVersion();
  if (!latest || !isNewerVersion(currentVersion, latest)) return false;

  if (!acquireUpdateLock()) return false;

  const { shellCmd, windowsVerbatim } = buildUpdateScript({ currentVersion, latest, agentPid: process.pid });

  const child = spawn(shellCmd[0], shellCmd[1], { detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: windowsVerbatim });
  child.unref();

  setTimeout(() => process.exit(0), 500);
  return true;
}

