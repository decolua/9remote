import { execSync } from "child_process";
import ora from "ora";
import chalk from "chalk";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");

/**
 * Check if running from global installation
 */
function isGlobalInstall() {
  // Check if we're in global node_modules
  return PROJECT_ROOT.includes("/node_modules/9remote") || 
         PROJECT_ROOT.includes("\\node_modules\\9remote");
}

/**
 * Get dependencies directory
 * For global install: use ~/.9remote/node_modules
 * For local dev: use project node_modules
 */
function getDepsDir() {
  if (isGlobalInstall()) {
    const homeDir = os.homedir();
    return path.join(homeDir, ".9remote");
  }
  return PROJECT_ROOT;
}

const DEPS_DIR = getDepsDir();
const INSTALL_MARKER = path.join(DEPS_DIR, "node_modules", ".deps-installed");

/**
 * Ensure all dependencies are installed
 * Only runs once on first launch
 */
export async function ensureNativeDeps() {
  // Create deps directory if needed
  if (!fs.existsSync(DEPS_DIR)) {
    fs.mkdirSync(DEPS_DIR, { recursive: true });
  }

  // Check if already installed
  if (fs.existsSync(INSTALL_MARKER)) {
    // Add deps to NODE_PATH for global install
    if (isGlobalInstall()) {
      const depsNodeModules = path.join(DEPS_DIR, "node_modules");
      if (process.env.NODE_PATH) {
        process.env.NODE_PATH = `${depsNodeModules}${path.delimiter}${process.env.NODE_PATH}`;
      } else {
        process.env.NODE_PATH = depsNodeModules;
      }
      require("module").Module._initPaths();
    }
    return true;
  }

  const spinner = ora("Checking dependencies...").start();

  try {
    // Check if cloudflared is installed
    let allInstalled = true;
    try {
      await import("cloudflared");
    } catch {
      allInstalled = false;
    }

    if (allInstalled) {
      spinner.succeed("Dependencies ready");
      
      // Mark as installed
      fs.mkdirSync(path.dirname(INSTALL_MARKER), { recursive: true });
      fs.writeFileSync(INSTALL_MARKER, new Date().toISOString());
      
      return true;
    }

    // Install cloudflared only (other deps are in package.json)
    spinner.stop();
    console.log(chalk.cyan("📦 Installing cloudflared (first time only, ~10 seconds)...\n"));
    
    const packageNames = ["cloudflared"];
    
    try {
      console.log(chalk.gray("   Installing cloudflared..."));
      
      // Create package.json if in global install mode
      if (isGlobalInstall()) {
        const pkgJsonPath = path.join(DEPS_DIR, "package.json");
        if (!fs.existsSync(pkgJsonPath)) {
          fs.writeFileSync(pkgJsonPath, JSON.stringify({
            name: "9remote-deps",
            version: "1.0.0",
            private: true
          }, null, 2));
        }
      }
      
      execSync(`npm install --no-save --prefer-offline ${packageNames.join(" ")}`, {
        cwd: DEPS_DIR,
        stdio: "inherit"
      });
      console.log(chalk.green("\n✔ Cloudflared installed successfully"));
      
      // Add deps to NODE_PATH for global install
      if (isGlobalInstall()) {
        const depsNodeModules = path.join(DEPS_DIR, "node_modules");
        if (process.env.NODE_PATH) {
          process.env.NODE_PATH = `${depsNodeModules}${path.delimiter}${process.env.NODE_PATH}`;
        } else {
          process.env.NODE_PATH = depsNodeModules;
        }
        require("module").Module._initPaths();
      }
    } catch (error) {
      console.log(chalk.red("\n✖ Failed to install dependencies"));
      console.error(error.message);
      console.log(chalk.yellow("\n💡 Tip: Try running with sudo if permission denied"));
      return false;
    }
    
    // Mark as installed
    fs.mkdirSync(path.dirname(INSTALL_MARKER), { recursive: true });
    fs.writeFileSync(INSTALL_MARKER, new Date().toISOString());
    
    return true;
  } catch (error) {
    spinner.fail("Failed to install dependencies");
    console.error(error.message);
    return false;
  }
}
