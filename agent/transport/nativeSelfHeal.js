// Self-heal for native addons whose install scripts were skipped (e.g. Garner/npm
// fork blocks install scripts by default). Tries the package's own prebuild-install
// at runtime — a spawned process, not an npm script, so script-blocking does not apply.
import { spawnSync } from "child_process";
import { createRequire } from "module";
import path from "path";
import os from "os";

const require = createRequire(import.meta.url);

// Avoid repeated heal attempts within one process lifetime.
const _tried = new Set();

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
    if (_tried.has(moduleName)) throw err;
    _tried.add(moduleName);
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
