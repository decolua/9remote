import chalk from "chalk";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import path from "path";
import os from "os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_NAME = "9remote";
const NPM_REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const UPDATE_CHECK_TIMEOUT = 3000;
const SAFETY_TIMEOUT = 8000;

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
function isNewerVersion(current, latest) {
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
export async function checkForUpdates() {
  try {
    const currentVersion = getCurrentVersion();
    if (!currentVersion) return;

    const response = await fetch(NPM_REGISTRY_URL, {
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

    fetch(NPM_REGISTRY_URL, { signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT) })
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

        if (platform === "win32") {
          const script = `@echo off
echo 📥 Downloading update...
echo ⏳ Waiting for process to exit...
timeout /t 2 /nobreak >nul

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
echo "⏳ Waiting for process to exit..."
sleep 1

pkill -f "${PACKAGE_NAME}" 2>/dev/null || true
sleep 1

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
