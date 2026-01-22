import chalk from "chalk";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_NAME = "9remote";
const NPM_REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;

/**
 * Get current version from package.json
 */
function getCurrentVersion() {
  try {
    const packagePath = path.resolve(__dirname, "../../package.json");
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
 * Check for npm updates (non-blocking)
 */
export async function checkForUpdates() {
  try {
    const currentVersion = getCurrentVersion();
    if (!currentVersion) return;

    const response = await fetch(NPM_REGISTRY_URL, {
      signal: AbortSignal.timeout(3000)
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
