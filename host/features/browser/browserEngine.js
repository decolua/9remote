import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
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

export async function getOrLaunchBrowser(profileName = "default", { headless = true } = {}) {
  const name = safeProfileName(profileName) ? profileName : "default";
  const existing = activeBrowsers.get(name);
  if (existing && !existing.client.closed) return existing;

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

  const instance = {
    name,
    port,
    child,
    client,
    setupTargetSession,
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
    active: p.targetId === browser.activeTargetId || idx === 0
  }));
}

export async function openTab(profileName = "default", url = "about:blank") {
  const browser = await getOrLaunchBrowser(profileName);
  const target = await browser.client.call("Target.createTarget", { url: url || "about:blank" });
  browser.activeTargetId = target.targetId;
  const attached = await browser.client.call("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  await browser.setupTargetSession(attached.sessionId, url);
  return { id: target.targetId, url };
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
  const attached = await browser.client.call("Target.attachToTarget", { targetId: String(targetId), flatten: true });
  await browser.client.call("Page.bringToFront", {}, attached.sessionId).catch(() => {});
  return { focused: targetId };
}

export async function navigateTab(profileName = "default", targetId, url) {
  const browser = await getOrLaunchBrowser(profileName);
  const attached = await browser.client.call("Target.attachToTarget", { targetId: String(targetId), flatten: true });
  await browser.setupTargetSession(attached.sessionId, url);
  await browser.client.call("Page.navigate", { url }, attached.sessionId);
  return { navigated: url };
}

export async function reloadTab(profileName = "default", targetId, { ignoreCache = false } = {}) {
  const browser = await getOrLaunchBrowser(profileName);
  const attached = await browser.client.call("Target.attachToTarget", { targetId: String(targetId), flatten: true });
  await browser.client.call("Page.reload", { ignoreCache: Boolean(ignoreCache) }, attached.sessionId);
  return { reloaded: true };
}

export async function goBack(profileName = "default", targetId) {
  const browser = await getOrLaunchBrowser(profileName);
  const attached = await browser.client.call("Target.attachToTarget", { targetId: String(targetId), flatten: true });
  await browser.client.call("Runtime.evaluate", { expression: "window.history.back()" }, attached.sessionId);
  return { back: true };
}

export async function goForward(profileName = "default", targetId) {
  const browser = await getOrLaunchBrowser(profileName);
  const attached = await browser.client.call("Target.attachToTarget", { targetId: String(targetId), flatten: true });
  await browser.client.call("Runtime.evaluate", { expression: "window.history.forward()" }, attached.sessionId);
  return { forward: true };
}

export async function inspectElementAt(profileName = "default", targetId, x, y) {
  const browser = await getOrLaunchBrowser(profileName);
  const attached = await browser.client.call("Target.attachToTarget", { targetId: String(targetId), flatten: true });
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
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      className: typeof el.className === 'string' ? el.className : null,
      selector: getSelector(el),
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
  const res = await browser.client.call("Runtime.evaluate", { expression: expr, returnByValue: true }, attached.sessionId);
  return res.result?.value ?? null;
}

export async function evalJs(profileName = "default", targetId, expression) {
  const browser = await getOrLaunchBrowser(profileName);
  const attached = await browser.client.call("Target.attachToTarget", { targetId: String(targetId), flatten: true });
  const res = await browser.client.call("Runtime.evaluate", {
    expression: String(expression || ""),
    returnByValue: true,
    awaitPromise: true
  }, attached.sessionId);
  return res.result?.value ?? res.exceptionDetails ?? null;
}
