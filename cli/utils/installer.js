import { execSync } from "child_process";
import ora from "ora";
import chalk from "chalk";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const INSTALL_MARKER = path.join(PROJECT_ROOT, "node_modules", ".deps-installed");

/**
 * Ensure all dependencies are installed
 * Only runs once on first launch
 */
export async function ensureNativeDeps() {
  // Check if already installed
  if (fs.existsSync(INSTALL_MARKER)) {
    return true;
  }

  const spinner = ora("Checking dependencies...").start();

  try {
    // Check if all dependencies are installed
    let allInstalled = true;
    try {
      await import("@homebridge/node-pty-prebuilt-multiarch");
      await import("sharp");
      await import("@hurdlegroup/robotjs");
      await import("cloudflared");
    } catch {
      allInstalled = false;
    }

    if (allInstalled) {
      spinner.succeed("Dependencies ready");
      
      // Mark as installed
      fs.writeFileSync(INSTALL_MARKER, new Date().toISOString());
      
      return true;
    }

    // Install all dependencies directly to project node_modules
    spinner.stop();
    console.log(chalk.cyan("📦 Installing dependencies (first time only, ~30 seconds)...\n"));
    
    // Install ALL packages in a single command (more reliable)
    const packageNames = [
      "@homebridge/node-pty-prebuilt-multiarch",
      "sharp",
      "@hurdlegroup/robotjs",
      "cloudflared"
    ];
    
    try {
      console.log(chalk.gray("   Installing all packages..."));
      execSync(`npm install --no-save --prefer-offline ${packageNames.join(" ")}`, {
        cwd: PROJECT_ROOT,
        stdio: "inherit" // Show npm output
      });
      console.log(chalk.green("\n✔ All dependencies installed successfully"));
    } catch (error) {
      console.log(chalk.red("\n✖ Failed to install dependencies"));
      console.error(error.message);
      return false;
    }
    
    // Mark as installed
    fs.writeFileSync(INSTALL_MARKER, new Date().toISOString());
    
    return true;
  } catch (error) {
    spinner.fail("Failed to install dependencies");
    console.error(error.message);
    return false;
  }
}
