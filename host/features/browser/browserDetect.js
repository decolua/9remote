import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const CHROMIUM_BROWSERS = [
  {
    family: "chrome",
    label: "Google Chrome",
    keychainService: "Chrome Safe Storage",
    keychainAccount: "Chrome",
    macRoot: "Google/Chrome",
    winRoot: "Google/Chrome/User Data",
    linuxRoot: "google-chrome"
  },
  {
    family: "edge",
    label: "Microsoft Edge",
    keychainService: "Microsoft Edge Safe Storage",
    keychainAccount: "Microsoft Edge",
    macRoot: "Microsoft Edge",
    winRoot: "Microsoft/Edge/User Data",
    linuxRoot: "microsoft-edge"
  },
  {
    family: "brave",
    label: "Brave",
    keychainService: "Brave Safe Storage",
    keychainAccount: "Brave",
    macRoot: "BraveSoftware/Brave-Browser",
    winRoot: "BraveSoftware/Brave-Browser/User Data",
    linuxRoot: "BraveSoftware/Brave-Browser"
  },
  {
    family: "arc",
    label: "Arc",
    keychainService: "Arc Safe Storage",
    keychainAccount: "Arc",
    macRoot: "Arc/User Data"
  }
];

function browserRootPath(def) {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return def.macRoot ? path.join(home, "Library", "Application Support", def.macRoot) : null;
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || "";
    return def.winRoot && local ? path.join(local, def.winRoot) : null;
  }
  const config = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return def.linuxRoot ? path.join(config, def.linuxRoot) : null;
}

function isSafeProfileDir(dir) {
  return typeof dir === "string" && dir.length > 0 && !dir.includes("..") && !dir.includes("/") && !dir.includes("\\");
}

function discoverChromiumProfiles(root) {
  try {
    const localStatePath = path.join(root, "Local State");
    if (!fs.existsSync(localStatePath)) {
      return [{ name: "Default", directory: "Default" }];
    }
    const localState = JSON.parse(fs.readFileSync(localStatePath, "utf8"));
    const infoCache = localState?.profile?.info_cache;
    if (!infoCache || typeof infoCache !== "object") {
      return [{ name: "Default", directory: "Default" }];
    }
    const profiles = [];
    for (const [dir, info] of Object.entries(infoCache)) {
      if (!isSafeProfileDir(dir)) continue;
      profiles.push({ name: info?.name || dir, directory: dir });
    }
    return profiles.length ? profiles : [{ name: "Default", directory: "Default" }];
  } catch {
    return [{ name: "Default", directory: "Default" }];
  }
}

function firefoxProfilesRoot() {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Firefox", "Profiles");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || "";
    return appData ? path.join(appData, "Mozilla", "Firefox", "Profiles") : null;
  }
  return path.join(home, ".mozilla", "firefox");
}

function discoverFirefoxProfiles() {
  const root = firefoxProfilesRoot();
  if (!root || !fs.existsSync(root)) return [];
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);

    const sorted = entries.sort((a, b) => {
      if (a.includes("default-release")) return -1;
      if (b.includes("default-release")) return 1;
      if (a.includes("default")) return -1;
      if (b.includes("default")) return 1;
      return 0;
    });

    return sorted.map((dir) => {
      const label = dir.includes(".") ? dir.split(".").slice(1).join(".") : dir;
      return { name: label, directory: dir };
    });
  } catch {
    return [];
  }
}

export function detectInstalledBrowsers() {
  const detected = [];

  for (const def of CHROMIUM_BROWSERS) {
    const root = browserRootPath(def);
    if (!root || !fs.existsSync(root)) continue;

    const profiles = discoverChromiumProfiles(root);
    const validProfiles = profiles.filter((p) => {
      const pdir = path.join(root, p.directory);
      return fs.existsSync(path.join(pdir, "Cookies")) || fs.existsSync(path.join(pdir, "Network", "Cookies"));
    });

    if (validProfiles.length) {
      detected.push({
        family: def.family,
        label: def.label,
        root,
        profiles: validProfiles
      });
    }
  }

  const ffProfiles = discoverFirefoxProfiles();
  const ffRoot = firefoxProfilesRoot();
  if (ffRoot && ffProfiles.length) {
    const validFf = ffProfiles.filter((p) => fs.existsSync(path.join(ffRoot, p.directory, "cookies.sqlite")));
    if (validFf.length) {
      detected.push({
        family: "firefox",
        label: "Firefox",
        root: ffRoot,
        profiles: validFf
      });
    }
  }

  return detected;
}

// ---------------------------------------------------------------------------
// Decryption and cookie extraction
// ---------------------------------------------------------------------------

function getMacKey(service, account) {
  try {
    const raw = execFileSync("security", ["find-generic-password", "-s", service, "-a", account, "-w"], {
      encoding: "utf8",
      timeout: 10_000
    }).trim();
    return { key: pbkdf2Sync(raw, "saltysalt", 1003, 16, "sha1"), mode: "aes-128-cbc" };
  } catch {
    return null;
  }
}

function getWindowsKey(root) {
  try {
    const localStatePath = path.join(root, "Local State");
    if (!fs.existsSync(localStatePath)) return null;
    const localState = JSON.parse(fs.readFileSync(localStatePath, "utf8"));
    const encB64 = localState?.os_crypt?.encrypted_key;
    if (!encB64) return null;
    const enc = Buffer.from(encB64, "base64");
    if (enc.subarray(0, 5).toString("utf8") !== "DPAPI") return null;

    const dpapiData = enc.subarray(5).toString("base64");
    const script = [
      "try { Add-Type -AssemblyName System.Security.Cryptography.ProtectedData -ErrorAction Stop }",
      "catch { try { Add-Type -AssemblyName System.Security -ErrorAction Stop } catch {} };",
      "$in=[Convert]::FromBase64String([Console]::In.ReadLine());",
      "$out=[System.Security.Cryptography.ProtectedData]::Unprotect($in,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);",
      "[Convert]::ToBase64String($out)"
    ].join("");

    const result = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      timeout: 10_000,
      input: dpapiData
    }).trim();

    return { key: Buffer.from(result, "base64"), mode: "aes-256-gcm" };
  } catch {
    return null;
  }
}

function getLinuxKey(service, account) {
  try {
    const raw = execFileSync("secret-tool", ["lookup", "service", service, "account", account], {
      encoding: "utf8",
      timeout: 5_000
    }).trim();
    const v11Key = pbkdf2Sync(raw, "saltysalt", 1, 16, "sha1");
    const v10Key = pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");
    return { key: v11Key, mode: "aes-128-cbc", fallbackKey: v10Key };
  } catch {
    const v10Key = pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");
    return { key: v10Key, mode: "aes-128-cbc" };
  }
}

function getEncryptionKey(def, root) {
  if (process.platform === "darwin") return getMacKey(def.keychainService, def.keychainAccount);
  if (process.platform === "win32") return getWindowsKey(root);
  if (process.platform === "linux") return getLinuxKey(def.keychainService, def.keychainAccount);
  return null;
}

function decryptCookieValue(buf, keyInfo) {
  if (!buf || buf.length < 3) return null;
  const version = buf.subarray(0, 3).toString("utf8");
  if (!/^v\d\d$/.test(version)) return null;

  if (keyInfo.mode === "aes-256-gcm") {
    const payload = buf.subarray(3);
    if (payload.length < 12 + 16) return null;
    try {
      const nonce = payload.subarray(0, 12);
      const tag = payload.subarray(payload.length - 16);
      const ciphertext = payload.subarray(12, payload.length - 16);
      const decipher = createDecipheriv("aes-256-gcm", keyInfo.key, nonce);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      return null;
    }
  }

  // AES-128-CBC
  const ciphertext = buf.subarray(3);
  if (!ciphertext.length) return Buffer.alloc(0);
  const keys = [keyInfo.key, ...(keyInfo.fallbackKey ? [keyInfo.fallbackKey] : [])];

  for (const k of keys) {
    try {
      const decipher = createDecipheriv("aes-128-cbc", k, Buffer.alloc(16, " "));
      decipher.setAutoPadding(true);
      let dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      // Strip 32-byte HMAC prefix if present
      if (dec.length > 32) {
        let nonPrint = 0;
        for (let i = 0; i < 32; i++) {
          if (dec[i] < 0x20 || dec[i] > 0x7e) nonPrint++;
        }
        if (nonPrint >= 8) dec = dec.subarray(32);
      }
      return dec;
    } catch {
      continue;
    }
  }
  return null;
}

const CHROMIUM_EPOCH_OFFSET = 11644473600n;
function chromiumTimestampToUnix(ts) {
  if (!ts) return 0;
  try {
    const b = BigInt(ts);
    if (b === 0n) return 0;
    return Math.max(Number(b / 1000000n - CHROMIUM_EPOCH_OFFSET), 0);
  } catch {
    return 0;
  }
}

function chromiumSameSite(val) {
  switch (Number(val)) {
    case 1: return "None";
    case 2: return "Lax";
    case 3: return "Strict";
    default: return "Lax";
  }
}

function firefoxSameSite(val) {
  switch (Number(val)) {
    case 0: return "None";
    case 1: return "Lax";
    case 2: return "Strict";
    default: return "Lax";
  }
}

export async function extractBrowserCookies(family, profileDirectory = "Default") {
  if (family === "firefox") {
    return extractFirefoxCookies(profileDirectory);
  }

  const def = CHROMIUM_BROWSERS.find((b) => b.family === family);
  if (!def) throw new Error(`Unsupported browser family: ${family}`);
  const root = browserRootPath(def);
  if (!root) throw new Error(`Browser root not found for ${family}`);

  let cookiesDbPath = path.join(root, profileDirectory, "Cookies");
  if (!fs.existsSync(cookiesDbPath)) {
    cookiesDbPath = path.join(root, profileDirectory, "Network", "Cookies");
  }
  if (!fs.existsSync(cookiesDbPath)) {
    throw new Error(`Cookies database not found at ${cookiesDbPath}`);
  }

  const keyInfo = getEncryptionKey(def, root);
  if (!keyInfo) throw new Error(`Could not access encryption key for ${def.label}`);

  const tmpPath = path.join(os.tmpdir(), `9r_cookie_${Date.now()}_${Math.random().toString(36).slice(2)}.sqlite`);
  fs.copyFileSync(cookiesDbPath, tmpPath);

  try {
    const db = new DatabaseSync(tmpPath, { readOnly: true });
    const rows = db.prepare(
      "SELECT host_key, name, value, encrypted_value, path, is_secure, is_httponly, samesite, CAST(expires_utc AS TEXT) AS expires_utc FROM cookies"
    ).all();
    db.close();

    const now = Math.floor(Date.now() / 1000);
    const cookies = [];

    for (const r of rows) {
      let val = r.value;
      if (!val && r.encrypted_value) {
        const dec = decryptCookieValue(Buffer.from(r.encrypted_value), keyInfo);
        if (dec) val = dec.toString("utf8");
      }
      if (!val || !r.name || !r.host_key) continue;

      const exp = chromiumTimestampToUnix(r.expires_utc);
      if (exp > 0 && exp < now) continue;

      cookies.push({
        domain: r.host_key,
        name: r.name,
        value: val,
        path: r.path || "/",
        secure: Boolean(r.is_secure),
        httpOnly: Boolean(r.is_httponly),
        sameSite: chromiumSameSite(r.samesite),
        expires: exp > 0 ? exp : undefined
      });
    }

    return cookies;
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

function extractFirefoxCookies(profileDirectory) {
  const root = firefoxProfilesRoot();
  if (!root) throw new Error("Firefox profiles root not found");
  const cookiesDbPath = path.join(root, profileDirectory, "cookies.sqlite");
  if (!fs.existsSync(cookiesDbPath)) throw new Error(`Firefox cookies.sqlite not found at ${cookiesDbPath}`);

  const tmpPath = path.join(os.tmpdir(), `9r_ff_cookie_${Date.now()}_${Math.random().toString(36).slice(2)}.sqlite`);
  fs.copyFileSync(cookiesDbPath, tmpPath);

  try {
    const db = new DatabaseSync(tmpPath, { readOnly: true });
    const rows = db.prepare(
      "SELECT host, name, value, path, CAST(expiry AS TEXT) AS expiry, isSecure, isHttpOnly, sameSite FROM moz_cookies"
    ).all();
    db.close();

    const now = Math.floor(Date.now() / 1000);
    const cookies = [];

    for (const r of rows) {
      if (!r.name || !r.host || !r.value) continue;
      const exp = Number(r.expiry) || 0;
      if (exp > 0 && exp < now) continue;

      cookies.push({
        domain: r.host,
        name: r.name,
        value: r.value,
        path: r.path || "/",
        secure: Boolean(r.isSecure),
        httpOnly: Boolean(r.isHttpOnly),
        sameSite: firefoxSameSite(r.sameSite),
        expires: exp > 0 ? exp : undefined
      });
    }

    return cookies;
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}
