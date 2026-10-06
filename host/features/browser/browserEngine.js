import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../../lib/logger.js";
import { CdpClient, waitForDevTools } from "./cdp.js";
import { ANTI_DETECTION_SCRIPT, stripHeadlessUa } from "./antiDetection.js";
import {
  CHROME_CANDIDATES,
  DEFAULT_VIEWPORT,
  LAUNCH_TIMEOUT_MS,
  getProfilesDir
} from "./constants.js";

const logger = createLogger("browser");

function safeProfileName(name) {
  return /^[a-z0-9][a-z0-9_-]{0,31}$/i.test(String(name || ""));
}

export function listProfiles() {
  const root = getProfilesDir();
  if (!fs.existsSync(root)) return [{ name: "default", userAgentUnmodified: false }];
  const found = fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && safeProfileName(d.name))
    .map((d) => {
      let cfg = {};
      try {
        cfg = JSON.parse(fs.readFileSync(path.join(root, d.name, "9r-config.json"), "utf8"));
      } catch { /* defaults */ }
      return {
        name: d.name,
        userAgentUnmodified: Boolean(cfg.userAgentUnmodified)
      };
    });
  return found.some((p) => p.name === "default") ? found : [{ name: "default", userAgentUnmodified: false }, ...found];
}

export function createProfile(name, { userAgentUnmodified = false } = {}) {
  if (!safeProfileName(name)) throw new Error("Profile name must match [a-z0-9_-], max 32 chars");
  const pdir = path.join(getProfilesDir(), name);
  fs.mkdirSync(pdir, { recursive: true });
  fs.writeFileSync(path.join(pdir, "9r-config.json"), JSON.stringify({ userAgentUnmodified: Boolean(userAgentUnmodified) }));
  return { name, userAgentUnmodified };
}

export async function removeProfile(name) {
  if (!safeProfileName(name) || name === "default") throw new Error("Refusing to delete default profile");
  await closeBrowser(name);
  const pdir = path.join(getProfilesDir(), name);
  fs.rmSync(pdir, { recursive: true, force: true });
  return { name, deleted: true };
}

// Flip a setting on an EXISTING profile's 9r-config.json (merge, never replace).
export function updateProfile(name, { userAgentUnmodified } = {}) {
  if (!safeProfileName(name)) throw new Error("Profile name must match [a-z0-9_-], max 32 chars");
  const pdir = path.join(getProfilesDir(), name);
  if (!fs.existsSync(pdir)) throw new Error(`Profile not found: ${name}`);
  const cfgPath = path.join(pdir, "9r-config.json");
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch { /* defaults */ }
  if (userAgentUnmodified !== undefined) cfg.userAgentUnmodified = Boolean(userAgentUnmodified);
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  return { name, userAgentUnmodified: Boolean(cfg.userAgentUnmodified) };
}

// ---- address-bar history (single install-wide file, capped) -------------------
const HISTORY_FILE = path.join(os.homedir(), ".9remote", "browser", "history.json");
const HISTORY_MAX = 500;

function readHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8")); } catch { return []; }
}

export function recordHistory(url) {
  if (!url || !/^https?:/i.test(url)) return;
  const list = readHistory().filter((h) => h.url !== url);
  list.unshift({ url, ts: Date.now() });
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(list.slice(0, HISTORY_MAX)));
  } catch { /* history is best-effort */ }
}

// Prefix beats substring beats title match; recency breaks ties.
export function scoreHistory(list, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [...list].sort((a, b) => b.ts - a.ts).slice(0, 8);
  const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ""; } };
  const scored = [];
  for (const h of list || []) {
    const url = String(h.url || "").toLowerCase();
    let score = 0;
    if (url.startsWith(q)) score = 4;
    else if (hostOf(url).includes(q)) score = 3;
    else if (url.includes(q)) score = 2;
    else if (String(h.title || "").toLowerCase().includes(q)) score = 1;
    if (score) scored.push({ ...h, score });
  }
  scored.sort((a, b) => (b.score - a.score) || (b.ts - a.ts));
  return scored.slice(0, 8);
}

export function searchHistory(query) {
  return scoreHistory(readHistory(), query);
}

// Tab titles arrive later than the navigation that created the entry — backfill.
export function enrichHistory(tabs) {
  const list = readHistory();
  const byUrl = new Map(list.map((h) => [h.url, h]));
  let changed = false;
  for (const tab of tabs || []) {
    const h = byUrl.get(tab.url);
    if (h && !h.title && tab.title && tab.title !== "New Tab") {
      h.title = String(tab.title).slice(0, 120);
      changed = true;
    }
  }
  if (changed) {
    try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(list)); } catch { /* best-effort */ }
  }
}

export function resolveChromeBinary() {
  for (const candidate of CHROME_CANDIDATES) {
    if (path.isAbsolute(candidate)) {
      if (fs.existsSync(candidate)) return candidate;
    } else {
      try { return execFileSync("which", [candidate], { timeout: 2000 }).toString().trim(); } catch { /* next */ }
    }
  }
  return null;
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

// Active browser instances keyed by profile name.
const activeBrowsers = new Map();
const launching = new Map(); // name -> in-flight launch promise (concurrent invokes share one Chrome)

export function getOrLaunchBrowser(profileName = "default", { headless = true } = {}) {
  const name = safeProfileName(profileName) ? profileName : "default";
  const existing = activeBrowsers.get(name);
  if (existing && !existing.client.closed) return Promise.resolve(existing);
  if (launching.has(name)) return launching.get(name);
  const p = launchBrowser(name, headless).finally(() => launching.delete(name));
  launching.set(name, p);
  return p;
}

async function launchBrowser(name, headless) {
  const bin = resolveChromeBinary();
  if (!bin) throw new Error("No Chrome/Chromium binary found on this host");

  const port = await reservePort();
  const profileDir = path.join(getProfilesDir(), name);
  fs.mkdirSync(profileDir, { recursive: true });

  let profileCfg = {};
  try {
    profileCfg = JSON.parse(fs.readFileSync(path.join(profileDir, "9r-config.json"), "utf8"));
  } catch { /* defaults */ }

  const args = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    `--window-size=${DEFAULT_VIEWPORT.width},${DEFAULT_VIEWPORT.height}`,
    // Raster at 2× physical pixels: Page.startScreencast ignores the session's
    // deviceScaleFactor, so Retina sharpness has to come from the launch flag.
    // Per-client scale is applied via screencast maxWidth (Chrome downscales).
    "--force-device-scale-factor=2",
    "about:blank"
  ];
  if (headless) args.push("--headless=new");

  const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
  child.on("error", (e) => logger.error(`Chrome spawn error: ${e.message}`));

  let client;
  try {
    const info = await waitForDevTools(port, LAUNCH_TIMEOUT_MS);
    client = await CdpClient.connect(info.webSocketDebuggerUrl);
  } catch (e) {
    child.kill();
    throw new Error(`Failed to connect to Chrome: ${e.message}`);
  }

  // Auto-init targets with anti-detection and user-agent policy
  const setupTargetSession = async (sessionId, url = "") => {
    try {
      await client.call("Page.enable", {}, sessionId);
      await client.call("DOM.enable", {}, sessionId);
      await client.call("Runtime.enable", {}, sessionId);
      await client.call("Page.addScriptToEvaluateOnNewDocument", { source: ANTI_DETECTION_SCRIPT }, sessionId);

      if (!profileCfg.userAgentUnmodified) {
        // Special-case Google auth: if navigating to accounts.google.com, don't modify UA
        const isGoogle = /accounts\.google\.com/i.test(url);
        if (!isGoogle && headless) {
          const evalRes = await client.call("Runtime.evaluate", { expression: "navigator.userAgent" }, sessionId);
          const rawUa = evalRes.result?.value;
          if (rawUa && /HeadlessChrome/i.test(rawUa)) {
            await client.call("Emulation.setUserAgentOverride", { userAgent: stripHeadlessUa(rawUa) }, sessionId);
          }
        }
      }
    } catch { /* ignore per-target setup failures */ }
  };

  // ONE flattened session per target, reused by every action — attaching per
  // call leaks sessions on the target and re-runs setup each invoke.
  const sessionsByTarget = new Map();
  client.on("Target.detachedFromTarget", ({ targetId } = {}) => {
    if (targetId) sessionsByTarget.delete(targetId);
  });
  const sessionFor = async (targetId, url = "") => {
    const id = String(targetId || "");
    if (!id) throw new Error("Missing field: targetId");
    let sessionId = sessionsByTarget.get(id);
    if (!sessionId) {
      const attached = await client.call("Target.attachToTarget", { targetId: id, flatten: true });
      sessionId = attached.sessionId;
      sessionsByTarget.set(id, sessionId);
      await setupTargetSession(sessionId, url);
    }
    return sessionId;
  };

  const instance = {
    name,
    port,
    child,
    client,
    sessionFor,
    activeTargetId: null
  };

  activeBrowsers.set(name, instance);
  logger.info(`Browser launched for profile "${name}" on port ${port}`);
  return instance;
}

export async function closeBrowser(profileName = "default") {
  const instance = activeBrowsers.get(profileName);
  if (!instance) return;
  activeBrowsers.delete(profileName);
  try { instance.client.close(); } catch { /* ignore */ }
  try { instance.child.kill(); } catch { /* ignore */ }
}

export async function listTabs(profileName = "default") {
  const browser = await getOrLaunchBrowser(profileName);
  const { targetInfos = [] } = await browser.client.call("Target.getTargets");
  const pages = targetInfos.filter((t) => t.type === "page");
  return pages.map((p, idx) => ({
    id: p.targetId,
    index: idx + 1,
    title: p.title || "New Tab",
    url: p.url || "about:blank",
    openerId: p.openerId || null,
    active: p.targetId === browser.activeTargetId || idx === 0
  }));
}

// Read-only list: never launches Chrome. The web strip polls this on connect —
// an idle machine must not boot a browser just because the app opened.
export async function peekTabs(profileName = "default") {
  const instance = activeBrowsers.get(safeProfileName(profileName) ? profileName : "default");
  if (!instance || instance.client.closed) return [];
  try {
    const { targetInfos = [] } = await instance.client.call("Target.getTargets");
    const pages = targetInfos.filter((t) => t.type === "page");
    return pages.map((p, idx) => ({
      id: p.targetId,
      index: idx + 1,
      title: p.title || "New Tab",
      url: p.url || "about:blank",
      openerId: p.openerId || null,
      active: p.targetId === instance.activeTargetId || idx === 0
    }));
  } catch { return []; }
}

export async function setViewport(profileName = "default", targetId, width, height) {
  const browser = await getOrLaunchBrowser(profileName);
  const sessionId = await browser.sessionFor(targetId);
  await browser.client.call("Emulation.setDeviceMetricsOverride", {
    width: Math.max(200, Math.min(4000, Math.round(Number(width) || 1120))),
    height: Math.max(200, Math.min(4000, Math.round(Number(height) || 780))),
    deviceScaleFactor: 1,
    mobile: false
  }, sessionId);
  return { viewport: { width, height } };
}

export async function openTab(profileName = "default", url = "about:blank") {
  const browser = await getOrLaunchBrowser(profileName);
  const target = normalizeUrlInput(url);
  // Create blank, set the session up, THEN navigate: running the UA override
  // (or a window resize) while the createTarget navigation is in flight makes
  // Chrome abort it with net::ERR_ABORTED and the tab lands on an error page.
  const created = await browser.client.call("Target.createTarget", { url: "about:blank" });
  browser.activeTargetId = created.targetId;
  const sessionId = await browser.sessionFor(created.targetId, target);
  if (target !== "about:blank") {
    const res = await browser.client.call("Page.navigate", { url: target }, sessionId);
    if (res?.errorText) return { id: created.targetId, url: target, error: res.errorText };
  }
  recordHistory(target);
  return { id: created.targetId, url: target };
}

export async function closeTab(profileName = "default", targetId) {
  const browser = await getOrLaunchBrowser(profileName);
  await browser.client.call("Target.closeTarget", { targetId: String(targetId) });
  if (browser.activeTargetId === targetId) browser.activeTargetId = null;
  return { closed: targetId };
}

export async function focusTab(profileName = "default", targetId) {
  const browser = await getOrLaunchBrowser(profileName);
  browser.activeTargetId = String(targetId);
  const sessionId = await browser.sessionFor(targetId);
  await browser.client.call("Page.bringToFront", {}, sessionId).catch(() => {});
  return { focused: targetId };
}

// Address-bar input → navigable URL (orca normalizeBrowserNavigationUrl shape):
// blank stays blank, scheme-less URL-ish gets https, anything else is a search.
export function normalizeUrlInput(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed || trimmed === "about:blank") return "about:blank";
  // Only known schemes count — "localhost:3000" must fall through to local-dev.
  if (/^(https?|file|chrome|devtools|about|data|blob|view-source):/i.test(trimmed)) return trimmed;
  // Local dev addresses keep plain http (orca's classifySchemeLessLocalDevAddress).
  if (/^(localhost|127\.0\.0\.1|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#].*)?$/i.test(trimmed)) {
    return `http://${trimmed}`;
  }
  if (/^[\w.-]+\.[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(trimmed) && !trimmed.includes(" ")) {
    return `https://${trimmed}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

export async function navigateTab(profileName = "default", targetId, url) {
  const browser = await getOrLaunchBrowser(profileName);
  const sessionId = await browser.sessionFor(targetId, url);
  const target = normalizeUrlInput(url);
  let res = await browser.client.call("Page.navigate", { url: target }, sessionId);
  // ERR_ABORTED = superseded load (viewport/UA swap racing the commit) — one
  // retry after the swap settles is the standard cure; a second failure is real.
  if (res?.errorText === "net::ERR_ABORTED") {
    await new Promise((r) => setTimeout(r, 400));
    res = await browser.client.call("Page.navigate", { url: target }, sessionId);
  }
  recordHistory(target);
  // CDP reports navigation failures (DNS, refused, blocked) in errorText —
  // that is the load-failure overlay's trigger on the web side.
  if (res?.errorText) return { navigated: false, url: target, error: res.errorText };
  return { navigated: true, url: target };
}

export async function reloadTab(profileName = "default", targetId, { ignoreCache = false } = {}) {
  const browser = await getOrLaunchBrowser(profileName);
  const sessionId = await browser.sessionFor(targetId);
  await browser.client.call("Page.reload", { ignoreCache: Boolean(ignoreCache) }, sessionId);
  return { reloaded: true };
}

export async function goBack(profileName = "default", targetId) {
  const browser = await getOrLaunchBrowser(profileName);
  const sessionId = await browser.sessionFor(targetId);
  await browser.client.call("Runtime.evaluate", { expression: "window.history.back()" }, sessionId);
  return { back: true };
}

export async function goForward(profileName = "default", targetId) {
  const browser = await getOrLaunchBrowser(profileName);
  const sessionId = await browser.sessionFor(targetId);
  await browser.client.call("Runtime.evaluate", { expression: "window.history.forward()" }, sessionId);
  return { forward: true };
}

// History bounds for the toolbar's disabled back/forward (orca parity).
export async function navState(profileName = "default", targetId) {
  const browser = await getOrLaunchBrowser(profileName);
  const sessionId = await browser.sessionFor(targetId);
  const res = await browser.client.call("Page.getNavigationHistory", {}, sessionId);
  return {
    back: (res.currentIndex || 0) > 0,
    forward: (res.currentIndex || 0) < (res.entries?.length || 1) - 1
  };
}

export async function inspectElementAt(profileName = "default", targetId, x, y) {
  const browser = await getOrLaunchBrowser(profileName);
  const nx = Number(x) || 0;
  const ny = Number(y) || 0;
  const expr = `(() => {
    const el = document.elementFromPoint(${nx}, ${ny});
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const getSelector = (elem) => {
      if (elem.id) return '#' + CSS.escape(elem.id);
      const path = [];
      let curr = elem;
      while (curr && curr.nodeType === 1 && curr !== document.body && curr !== document.documentElement) {
        const tag = curr.tagName.toLowerCase();
        if (curr.id) {
          path.unshift('#' + CSS.escape(curr.id));
          break;
        }
        const siblings = Array.from(curr.parentNode?.children || []).filter(c => c.tagName === curr.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(curr) + 1;
          path.unshift(tag + ':nth-of-type(' + idx + ')');
        } else {
          path.unshift(tag);
        }
        curr = curr.parentElement;
      }
      return path.join(' > ') || elem.tagName.toLowerCase();
    };
    const computed = window.getComputedStyle(el);
    const text = (el.innerText || el.textContent || '').trim().slice(0, 500);
    const html = (el.outerHTML || '').slice(0, 1000);
    const link = el.closest('a[href]');
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      className: typeof el.className === 'string' ? el.className : null,
      selector: getSelector(el),
      href: link ? link.href : null,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      text,
      html,
      styles: {
        color: computed.color,
        backgroundColor: computed.backgroundColor,
        fontSize: computed.fontSize,
        display: computed.display
      }
    };
  })()`;
  const sessionId = await browser.sessionFor(targetId);
  const res = await browser.client.call("Runtime.evaluate", { expression: expr, returnByValue: true }, sessionId);
  return res.result?.value ?? null;
}

export async function evalJs(profileName = "default", targetId, expression) {
  const browser = await getOrLaunchBrowser(profileName);
  const sessionId = await browser.sessionFor(targetId);
  const res = await browser.client.call("Runtime.evaluate", {
    expression: String(expression || ""),
    returnByValue: true,
    awaitPromise: true
  }, sessionId);
  return res.result?.value ?? res.exceptionDetails ?? null;
}
