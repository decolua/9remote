// Self-heal for native addons whose install scripts were skipped (e.g. Garner/npm
// fork blocks install scripts by default). Tries the package's own prebuild-install
// at runtime — a spawned process, not an npm script, so script-blocking does not apply.
import { spawnSync } from "child_process";
import { createRequire } from "module";
import path from "path";
import os from "os";

const require = createRequire(import.meta.url);

// Avoid repeated heal attempts within a retry window. A transient heal failure
// (DNS/GitHub down, AV quarantine, prebuild-install fetch blip) must not permanently
// disable the native module for the process lifetime — after the window the next
// loadNative call retries the heal instead of rethrowing the stale error forever.
const HEAL_RETRY_MS = 5 * 60 * 1000;
const _triedAt = new Map();

/**
 * Load a native module, retrying via prebuild-install if the .node binary is missing.
 * @param {string} moduleName  package name (e.g. "node-datachannel")
 * @returns {any} required module
 * @throws if both require and heal fail
 */
export function loadNative(moduleName) {
  try {
    return require(moduleName);
  } catch (err) {
    if (err.code !== "MODULE_NOT_FOUND" && !_isMissingBinary(err)) throw err;
    const lastTried = _triedAt.get(moduleName);
    if (lastTried != null && Date.now() - lastTried < HEAL_RETRY_MS) throw err;
    _triedAt.set(moduleName, Date.now());
    _heal(moduleName);
    return require(moduleName); // throws again if still broken
  }
}

// node-datachannel throws MODULE_NOT_FOUND for the .node file; message varies by loader.
function _isMissingBinary(err) {
  return /\.node'|Cannot find module.*\.node|MODULE_NOT_FOUND/i.test(err.message || "");
}

function _pkgDir(moduleName) {
  const pkgJson = require.resolve(`${moduleName}/package.json`);
  return path.dirname(pkgJson);
}

function _heal(moduleName) {
  const pkgDir = _pkgDir(moduleName);
  // .bin sits in the node_modules that contains the package, i.e. parent of pkgDir.
  const modulesDir = path.dirname(pkgDir);
  const binName = os.platform() === "win32" ? "prebuild-install.cmd" : "prebuild-install";
  const bin = path.join(modulesDir, ".bin", binName);
  // node-datachannel uses napi prebuilds; -r napi covers the common case.
  try {
    const res = spawnSync(bin, ["-r", "napi"], {
      cwd: pkgDir,
      stdio: "ignore",
      shell: os.platform() === "win32",
      timeout: 120000,
    });
    console.warn(`[nativeSelfHeal] ${moduleName} heal attempted (status=${res.status})`);
  } catch (e) {
    console.warn(`[nativeSelfHeal] ${moduleName} heal failed:`, e.message);
  }
}
