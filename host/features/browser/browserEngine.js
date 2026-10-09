import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../../lib/logger.js";
import { CdpClient, waitForDevTools } from "./cdp.js";
import { ANTI_DETECTION_SCRIPT, cacheUserAgentIdentity, headlessOverride, readUserAgentIdentity } from "./antiDetection.js";
import {
  CHROME_CANDIDATES,
  DEFAULT_VIEWPORT,
  HEADLESS_IDLE_CLOSE_MS,
  HEADLESS_IDLE_SWEEP_MS,
  LAUNCH_TIMEOUT_MS,
  getProfilesDir
} from "./constants.js";
import { applyEmulation, hasActiveStreamFor } from "./stream.js";

const logger = createLogger("browser");

export function safeProfileName(name) {
  return /^[a-z0-9][a-z0-9_-]{0,31}$/i.test(String(name || ""));
}

// Anti-detection (headless-UA strip + script) is ALWAYS on — no per-profile
// toggle; a leaked automation fingerprint defeats the whole point.
export function listProfiles() {
  const root = getProfilesDir();
  if (!fs.existsSync(root)) return [{ name: "default" }];
  const found = fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && safeProfileName(d.name))
    .map((d) => ({ name: d.name }));
  return found.some((p) => p.name === "default") ? found : [{ name: "default" }, ...found];
}

export function createProfile(name) {
  if (!safeProfileName(name)) throw new Error("Profile name must match [a-z0-9_-], max 32 chars");
  fs.mkdirSync(path.join(getProfilesDir(), name), { recursive: true });
  return { name };
}

export async function removeProfile(name) {
  if (!safeProfileName(name) || name === "default") throw new Error("Refusing to delete default profile");
  await closeBrowser(name);
  const pdir = path.join(getProfilesDir(), name);
  fs.rmSync(pdir, { recursive: true, force: true });
  return { name, deleted: true };
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

// Headless by default; NREMOTE_BROWSER_HEADLESS=0 boots a visible Chrome for
// debugging stream quality / anti-detection interactively.
const BROWSER_HEADLESS = process.env.NREMOTE_BROWSER_HEADLESS !== "0";

// Tab-list push hook: target events (new tab / url / title change) call it so
// the strip updates in ~100ms instead of the 2s poll. One global door — the
// socket layer decides what to do with it.
let tabsPushHook = null;
export function setTabsPushHook(cb) { tabsPushHook = typeof cb === "function" ? cb : null; }

// Read-only instance lookup — best-effort callers (cursor probe, tab peek)
// must never LAUNCH a browser: a probe with a missing profile would otherwise
// boot a second Chrome window next to the active one.
export function peekBrowser(profileName = "default") {
  const instance = activeBrowsers.get(safeProfileName(profileName) ? profileName : "default");
  return instance && !instance.client.closed ? instance : null;
}

// The front tab is the only one whose document is "visible". CDP has no
// tab-activated event, so polling visibility is the only way tabs clicked
// directly in the real Chrome window sync back to the strip and stream target.
export async function syncActiveTab(instance) {
  if (!instance || instance.client.closed) return;
  try {
    const { targetInfos = [] } = await instance.client.call("Target.getTargets");
    for (const p of targetInfos) {
      if (p.type !== "page") continue;
      const sessionId = await instance.sessionFor(p.targetId).catch(() => null);
      if (!sessionId) continue;
      const res = await instance.client.call("Runtime.evaluate", {
        expression: "document.visibilityState", returnByValue: true
      }, sessionId).catch(() => null);
      if (res?.result?.value === "visible") {
        instance.activeTargetId = p.targetId;
        return;
      }
    }
  } catch { /* best-effort */ }
}

export function getOrLaunchBrowser(profileName = "default", { headless = BROWSER_HEADLESS } = {}) {
  const name = safeProfileName(profileName) ? profileName : "default";
  const existing = activeBrowsers.get(name);
  if (existing && !existing.client.closed) {
    existing.lastActiveAt = Date.now();
    return Promise.resolve(existing);
  }
  if (launching.has(name)) return launching.get(name);
  const p = launchBrowser(name, headless).finally(() => launching.delete(name));
  launching.set(name, p);
  return p;
}

// Socket-layer activity door: every browser invoke/input/stream start marks the
// profile's instance as alive for the idle sweep below.
export function noteBrowserActivity(profileName = "default") {
  const instance = activeBrowsers.get(safeProfileName(profileName) ? profileName : "default");
  if (instance) instance.lastActiveAt = Date.now();
}

// Chrome writes DevToolsActivePort into the user-data-dir while running: a
// live port there means that browser already owns the profile. Returns
// { port, client, headless } or null (stale file / unreachable / ws refused).
async function probeProfileDevTools(profileDir) {
  let port;
  try {
    port = Number(fs.readFileSync(path.join(profileDir, "DevToolsActivePort"), "utf8").split("\n")[0]);
  } catch { return null; }
  if (!Number.isInteger(port) || port <= 0) return null;
  const info = await waitForDevTools(port, 1000).catch(() => null);
  if (!info) return null;
  const client = await CdpClient.connect(info.webSocketDebuggerUrl).catch(() => null);
  if (!client) return null;
  return { port, client, headless: /headless/i.test(info.Browser || "") };
}

function clearStaleProfileLock(profileDir) {
  const lockPath = path.join(profileDir, "SingletonLock");
  try {
    let exists = false;
    try {
      exists = fs.existsSync(lockPath) || fs.lstatSync(lockPath).isSymbolicLink();
    } catch {}
    if (exists) {
      let pid = null;
      try {
        const target = fs.readlinkSync(lockPath);
        const match = target.match(/-(\d+)$/);
        if (match) pid = Number(match[1]);
      } catch {}
      if (pid && Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          logger.warn(`Killing zombie Chrome (PID ${pid}) holding SingletonLock for ${profileDir}`);
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket", "DevToolsActivePort"]) {
        try { fs.unlinkSync(path.join(profileDir, name)); } catch {}
      }
    }
  } catch {}
}

async function launchBrowser(name, headless) {
  const bin = resolveChromeBinary();
  if (!bin) throw new Error("No Chrome/Chromium binary found on this host");

  const profileDir = path.join(getProfilesDir(), name);
  if (name !== "default" && !fs.existsSync(profileDir)) {
    const known = listProfiles().map((p) => p.name).join(", ");
    throw new Error(`Profile "${name}" not found (available: ${known || "default"}). Create it in the Browser & Profiles menu first.`);
  }
  fs.mkdirSync(profileDir, { recursive: true });

  // A Chrome already holding this profile (another host process, or a zombie
  // the idle sweep missed) makes a fresh spawn hand off and exit without ever
  // opening its port — adopt the live browser instead of fighting the lock.
  const live = await probeProfileDevTools(profileDir);
  let port;
  let child = null;
  let client;
  let clientHeadless = !!headless;
  if (live) {
    port = live.port;
    client = live.client;
    clientHeadless = live.headless;
    logger.info(`Reusing live Chrome on port ${port} for profile "${name}"`);
  } else {
    clearStaleProfileLock(profileDir);
    port = await reservePort();
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
    // Headed Chrome throttles renderers of occluded/background windows — CDP
    // input dispatches then hang for the full 30s call timeout. Keep every
    // window interactive even when covered or in the background.
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    // Removes the automation blink switch entirely — belt to the script's suspenders.
    "--disable-blink-features=AutomationControlled",
    // Reopen the previous tabs on relaunch after an idle close — graceful close
    // (Browser.close) flushes the session this flag restores, tabs and all.
      "--restore-last-session"
    ];
    if (headless) args.push("--headless=new");

    child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    child.on("error", (e) => logger.error(`Chrome spawn error: ${e.message}`));

    try {
      const info = await waitForDevTools(port, LAUNCH_TIMEOUT_MS);
      client = await CdpClient.connect(info.webSocketDebuggerUrl);
    } catch (e) {
      child.kill();
      throw new Error(`Failed to connect to Chrome: ${e.message}`);
    }
  }

  // Browser-wide UA identity, cached from a REAL page target: fresh about:blank
  // targets never expose userAgentData, and setUserAgentOverride without
  // metadata blanks the UA-CH brands — a tell worse than the hidden one.
  let identityPromise = null;
  const uaIdentity = () => identityPromise ??= (async () => {
    try {
      const { targetInfos = [] } = await client.call("Target.getTargets");
      const page = targetInfos.find((p) => p.type === "page");
      if (!page) return null;
      const attached = await client.call("Target.attachToTarget", { targetId: page.targetId, flatten: true });
      const identity = await readUserAgentIdentity(client, attached.sessionId);
      void client.call("Target.detachFromTarget", { sessionId: attached.sessionId }).catch(() => {});
      // Cache for applyEmulation's desktop restore after a mobile preset.
      if (identity?.userAgent) cacheUserAgentIdentity(client, identity);
      return identity;
    } catch { return null; }
  })();

  // Auto-init targets with anti-detection and user-agent policy — always on,
  // never a profile option: a HeadlessChrome UA gets the tab flagged anyway.
  const setupTargetSession = async (sessionId, url = "") => {
    try {
      await client.call("Page.enable", {}, sessionId);
      await client.call("DOM.enable", {}, sessionId);
      // No Runtime.enable: its console-serialization is the CDP detection signal
      // Cloudflare/DataDome probe; one-shot Runtime.evaluate needs no events.
      await client.call("Page.addScriptToEvaluateOnNewDocument", { source: ANTI_DETECTION_SCRIPT }, sessionId);
      // Google auth fingerprints the UA mid-flow — touching it there breaks login.
      if (!/accounts\.google\.com/i.test(url) && headless) {
        const identity = (await uaIdentity()) || (await readUserAgentIdentity(client, sessionId));
        const params = identity && headlessOverride(identity);
        if (params) await client.call("Emulation.setUserAgentOverride", params, sessionId);
      }
    } catch (e) {
      // Never silent: a swallowed failure here leaves the raw HeadlessChrome UA.
      logger.warn(`Anti-detection setup failed: ${e.message}`);
    }
  };

  // ONE flattened session per target, reused by every action — attaching per
  // call leaks sessions on the target and re-runs setup each invoke.
  const sessionsByTarget = new Map();
  const attaching = new Map(); // targetId -> in-flight attach (eager attach races invokes)
  client.on("Target.detachedFromTarget", ({ targetId } = {}) => {
    if (targetId) sessionsByTarget.delete(targetId);
  });
  const sessionFor = async (targetId, url = "") => {
    const id = String(targetId || "");
    if (!id) throw new Error("Missing field: targetId");
    const cached = sessionsByTarget.get(id);
    if (cached) return cached;
    const pending = attaching.get(id);
    if (pending) return pending;
    const p = (async () => {
      const attached = await client.call("Target.attachToTarget", { targetId: id, flatten: true });
      await setupTargetSession(attached.sessionId, url);
      sessionsByTarget.set(id, attached.sessionId);
      return attached.sessionId;
    })().finally(() => attaching.delete(id));
    attaching.set(id, p);
    return p;
  };

  // Target discovery feeds the tabsPushHook — without setDiscoverTargets the
  // Target.* events never arrive and the strip leans on the 2s poll.
  const notifyTabs = () => tabsPushHook?.();
  client.on("Target.targetCreated", notifyTabs);
  client.on("Target.targetDestroyed", notifyTabs);
  client.on("Target.targetInfoChanged", notifyTabs);
  client.call("Target.setDiscoverTargets", { discover: true }).catch(() => {});

  const instance = {
    name,
    port,
    child,
    client,
    sessionFor,
    activeTargetId: null,
    headless: clientHeadless, // the reused browser's real mode, not the request's
    lastActiveAt: Date.now()
  };
  // Tab lifecycle/url events count as activity — this is also what keeps an
  // agent-driven run alive: the agent borrows this instance without the socket
  // layer, and every step it takes moves a target.
  const markActive = () => { instance.lastActiveAt = Date.now(); };
  client.on("Target.targetCreated", markActive);
  client.on("Target.targetDestroyed", markActive);
  client.on("Target.targetInfoChanged", markActive);

  // Attach page/iframe targets the moment they appear: a new tab's FIRST
  // request must not carry the raw HeadlessChrome UA (the override only lands
  // once a session exists), and OOPIF challenge iframes need the script too.
  client.on("Target.targetCreated", ({ targetInfo } = {}) => {
    if (targetInfo?.type !== "page" && targetInfo?.type !== "iframe") return;
    void instance.sessionFor(targetInfo.targetId, targetInfo.url).catch(() => {});
  });

  activeBrowsers.set(name, instance);
  logger.info(`Browser launched for profile "${name}" on port ${port} (headless=${headless})`);
  return instance;
}

// Graceful first: Browser.close lets Chrome flush cookies/session data to disk —
// a raw kill discards them and the profile loses its logins on next use.
const CHROME_GRACEFUL_MS = 2500;
async function gracefullyCloseChrome(instance) {
  // An adopted (reused) browser has no child process of ours to wait on.
  const exited = new Promise((resolve) => (instance.child ? instance.child.once("exit", () => resolve(true)) : resolve(false)));
  try { await instance.client.call("Browser.close"); } catch { /* already gone */ }
  if (await Promise.race([exited, sleep(CHROME_GRACEFUL_MS, false)])) return;
  try { instance.child.kill("SIGTERM"); } catch { /* ignore */ }
  if (await Promise.race([exited, sleep(1000, false)])) return;
  try { instance.child.kill("SIGKILL"); } catch { /* ignore */ }
  try { instance.client.close(); } catch { /* ignore */ }
}

export async function closeBrowser(profileName = "default") {
  const instance = activeBrowsers.get(profileName);
  if (!instance) return;
  activeBrowsers.delete(profileName);
  await gracefullyCloseChrome(instance);
}

// Host shutdown door: an orphaned Chrome keeps the profile dir locked and the
// next launch of that profile fails to open its devtools port.
export function closeAllBrowsers() {
  return Promise.all([...activeBrowsers.keys()].map((name) => closeBrowser(name)));
}

// Idle reclaim: a headless Chrome nobody streams into, invokes, or drives (no
// tab events = no agent step) is dead RAM — close it; the next invoke relaunches
// and --restore-last-session brings the tabs back. Headed windows are the
// user's own — never close those. Decision exported for tests.
export function idleCloseDue(instance, now = Date.now()) {
  if (!instance?.headless) return false;
  if (hasActiveStreamFor(instance.client)) return false;
  return now - (instance.lastActiveAt || 0) >= HEADLESS_IDLE_CLOSE_MS;
}

export function sweepIdleBrowsers() {
  for (const [name, instance] of activeBrowsers) {
    if (!idleCloseDue(instance)) continue;
    logger.info(`Idle headless browser "${name}" closed after ${Math.round(HEADLESS_IDLE_CLOSE_MS / 60000)}min`);
    void closeBrowser(name);
  }
}
setInterval(sweepIdleBrowsers, HEADLESS_IDLE_SWEEP_MS).unref?.();

const sleep = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));

// The window a workspace is currently viewing, per profile (last watch wins —
// the socket layer notes it on browser:tabs.watch). Agent-side tab creation
// fronts it first so the new tab joins the strip the user is looking at,
// not whichever Chrome window happened to be active.
const watchedWindows = new Map();
export function noteWatchedWindow(profile, windowId) {
  const name = safeProfileName(profile) ? profile : "default";
  if (windowId == null) watchedWindows.delete(name);
  else watchedWindows.set(name, Number(windowId));
}
export function watchedWindowOf(profile) {
  return watchedWindows.get(safeProfileName(profile) ? profile : "default") ?? null;
}
// Best-effort: bring one of the watched window's tabs to the front so the NEXT
// Target.createTarget lands in that window. Returns the window id or null.
export async function frontWatchedWindow(profileName = "default") {
  const win = watchedWindowOf(profileName);
  if (win == null) return null;
  const browser = peekBrowser(profileName);
  if (!browser) return null; // Chrome not running — nothing to front
  const tabs = await tabsWithWindows(browser).catch(() => []);
  const anchorTab = tabs.find((t) => t.windowId === win);
  if (!anchorTab) return null; // window died — fall through to Chrome's default
  const sid = await browser.sessionFor(anchorTab.id).catch(() => null);
  if (sid) await browser.client.call("Page.bringToFront", {}, sid).catch(() => {});
  return win;
}

// Tabs grouped by Chrome window: a workspace owns ONE window of its profile,
// exactly like terminal tabs belong to a workspace. Window ids are cached per
// target and re-queried only for targets we have not seen before.
async function tabsWithWindows(instance) {
  const { targetInfos = [] } = await instance.client.call("Target.getTargets");
  const pages = targetInfos.filter((t) => t.type === "page");
  if (!instance.windowsByTarget) instance.windowsByTarget = new Map();
  const cache = instance.windowsByTarget;
  for (const id of [...cache.keys()]) {
    if (!pages.some((p) => p.targetId === id)) cache.delete(id);
  }
  await Promise.all(pages.map(async (p) => {
    if (cache.has(p.targetId)) return;
    try {
      const { windowId } = await instance.client.call("Browser.getWindowForTarget", { targetId: p.targetId });
      cache.set(p.targetId, windowId);
    } catch { /* target may vanish mid-scan */ }
  }));
  return pages.map((p, idx) => ({
    id: p.targetId,
    index: idx + 1,
    title: p.title || "New Tab",
    url: p.url || "about:blank",
    openerId: p.openerId || null,
    windowId: cache.get(p.targetId) ?? null,
    active: p.targetId === instance.activeTargetId || idx === 0
  }));
}

export async function listTabs(profileName = "default") {
  const browser = await getOrLaunchBrowser(profileName);
  return tabsWithWindows(browser);
}

// Read-only list: never launches Chrome. The web strip polls this on connect —
// an idle machine must not boot a browser just because the app opened.
export async function peekTabs(profileName = "default") {
  const instance = activeBrowsers.get(safeProfileName(profileName) ? profileName : "default");
  if (!instance || instance.client.closed) return [];
  try {
    return await tabsWithWindows(instance);
  } catch { return []; }
}

// Viewport preset switch, mobile emulation included: metrics + UA + touch move
// together via applyEmulation, so a "Mobile" preset is a full Android identity
// (never a narrow desktop window) and switching back restores the desktop one.
export async function setViewport(profileName = "default", targetId, width, height, { mobile = false, reset = false } = {}) {
  const browser = await getOrLaunchBrowser(profileName);
  const sessionId = await browser.sessionFor(targetId);
  await applyEmulation(browser.client, sessionId, reset ? {} : {
    width: Math.max(200, Math.min(4000, Math.round(Number(width) || 1120))),
    height: Math.max(200, Math.min(4000, Math.round(Number(height) || 780))),
    mobile: !!mobile
  });
  return { viewport: { width, height, mobile: !!mobile && !reset }, reset: !!reset };
}

export async function openTab(profileName = "default", url = "about:blank", { newWindow = false, windowId = null } = {}) {
  const browser = await getOrLaunchBrowser(profileName);
  const target = normalizeUrlInput(url);
  const windowIdOf = async (targetId) => {
    try {
      const res = await browser.client.call("Browser.getWindowForTarget", { targetId });
      if (browser.windowsByTarget) browser.windowsByTarget.set(targetId, res.windowId);
      return res.windowId;
    } catch { return null; }
  };
  // A workspace keeps ONE Chrome window: a "+" with a known windowId fronts one
  // of its tabs first so the new tab lands in THAT window, not whichever window
  // Chrome happened to have active. A windowId with no live tab anymore (Chrome
  // restarted since it was saved) gets a FRESH window — falling through would
  // drop the tab into whatever window is active, possibly another workspace's.
  let wantsNewWindow = newWindow;
  if (!newWindow && windowId) {
    const tabs = await tabsWithWindows(browser).catch(() => []);
    const anchor = tabs.find((t) => t.windowId === windowId);
    if (anchor) {
      const sid = await browser.sessionFor(anchor.id).catch(() => null);
      if (sid) await browser.client.call("Page.bringToFront", {}, sid).catch(() => {});
    } else {
      wantsNewWindow = true;
    }
  }
  // A freshly launched Chrome already opened one blank tab in its first
  // window — that tab IS this workspace's first window. Only a newWindow request
  // (the workspace's FIRST tab) may adopt it; later "+" calls must create a
  // real new tab, and reusing here would silently no-op them.
  if (target === "about:blank" && newWindow) {
    const allTabs = await tabsWithWindows(browser).catch(() => []);
    const blanks = allTabs.filter((t) => !t.url || t.url === "about:blank");
    if (allTabs.length === 1 && blanks.length === 1) {
      browser.activeTargetId = blanks[0].id;
      await browser.sessionFor(blanks[0].id, target);
      return { id: blanks[0].id, url: target, windowId: await windowIdOf(blanks[0].id) };
    }
  }
  // Create blank, set the session up, THEN navigate: running the UA override
  // (or a window resize) while the createTarget navigation is in flight makes
  // Chrome abort it with net::ERR_ABORTED and the tab lands on an error page.
  const created = await browser.client.call("Target.createTarget", {
    url: "about:blank",
    ...(wantsNewWindow ? { newWindow: true } : {})
  });
  browser.activeTargetId = created.targetId;
  const sessionId = await browser.sessionFor(created.targetId, target);
  if (target !== "about:blank") {
    const res = await browser.client.call("Page.navigate", { url: target }, sessionId);
    if (res?.errorText) return { id: created.targetId, url: target, error: res.errorText, windowId: await windowIdOf(created.targetId) };
  }
  recordHistory(target);
  return { id: created.targetId, url: target, windowId: await windowIdOf(created.targetId) };
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
  const target = normalizeUrlInput(url);
  let sessionId;
  try {
    sessionId = await browser.sessionFor(targetId, url);
  } catch (e) {
    // Dead tab id (Chrome restarted under the client): open the URL as a new
    // tab — the returned id lets the pane re-attach instead of erroring out.
    if (!/No target/i.test(String(e?.message))) throw e;
    return openTab(profileName, target);
  }
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

// Page-side selector helper, interpolated into the inspect/pick expressions.
const GET_SELECTOR_JS = `(elem) => {
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
}`;

export async function inspectElementAt(profileName = "default", targetId, x, y) {
  const browser = await getOrLaunchBrowser(profileName);
  const nx = Number(x) || 0;
  const ny = Number(y) || 0;
  const expr = `(() => {
    const el = document.elementFromPoint(${nx}, ${ny});
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const getSelector = ${GET_SELECTOR_JS};
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

// Sweep pick: every visible element intersecting the dragged rectangle, most
// specific (smallest) first; wrappers that fully contain a kept element drop out.
const PICK_MAX_ELEMENTS = 50;

export async function pickElementsInRect(profileName = "default", targetId, x, y, w, h) {
  const browser = await getOrLaunchBrowser(profileName);
  const rx = Number(x) || 0;
  const ry = Number(y) || 0;
  const rw = Math.abs(Number(w)) || 0;
  const rh = Math.abs(Number(h)) || 0;
  const expr = `(() => {
    const getSelector = ${GET_SELECTOR_JS};
    const R = { left: ${rx}, top: ${ry}, right: ${rx + rw}, bottom: ${ry + rh} };
    const hits = [];
    for (const el of document.body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (r.right < R.left || r.bottom < R.top || r.left > R.right || r.top > R.bottom) continue;
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) continue;
      hits.push({ el, r, area: r.width * r.height });
    }
    hits.sort((a, b) => a.area - b.area);
    const kept = [];
    for (const hit of hits) {
      if (kept.length >= ${PICK_MAX_ELEMENTS}) break;
      const isWrapper = kept.some((k) => hit.r.left <= k.r.left && hit.r.top <= k.r.top
        && hit.r.right >= k.r.right && hit.r.bottom >= k.r.bottom);
      if (isWrapper) continue;
      kept.push(hit);
    }
    return kept.map((hit) => {
      const el = hit.el;
      const rect = el.getBoundingClientRect();
      const computed = getComputedStyle(el);
      const link = el.closest('a[href]');
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        className: typeof el.className === 'string' ? el.className : null,
        selector: getSelector(el),
        href: link ? link.href : null,
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        text: (el.innerText || el.textContent || '').trim().slice(0, 300),
        html: (el.outerHTML || '').slice(0, 500),
        styles: {
          color: computed.color,
          backgroundColor: computed.backgroundColor,
          fontSize: computed.fontSize,
          display: computed.display
        }
      };
    });
  })()`;
  const sessionId = await browser.sessionFor(targetId);
  const res = await browser.client.call("Runtime.evaluate", { expression: expr, returnByValue: true }, sessionId);
  return Array.isArray(res.result?.value) ? res.result.value : [];
}

// Pick rings live INSIDE the page: the overlay re-reads each picked element's rect
// every frame, so any scroll (page, inner scroller, fixed layers) keeps them glued.
// Selectors are JSON-embedded, never string-concatenated into the expression.
const PICK_OVERLAY_ID = "__9r_pick_overlay";

export async function markPicked(profileName = "default", targetId, selectors = []) {
  const list = (Array.isArray(selectors) ? selectors : []).filter((x) => typeof x === "string" && x).slice(0, PICK_MAX_ELEMENTS);
  const expr = `(() => {
    const ID = ${JSON.stringify(PICK_OVERLAY_ID)};
    const old = document.getElementById(ID);
    if (old) { old.__stop && old.__stop(); old.remove(); }
    const sels = ${JSON.stringify(list)};
    if (!sels.length || !document.documentElement) return 0;
    const els = sels.map((s) => { try { return document.querySelector(s); } catch { return null; } });
    const root = document.createElement('div');
    root.id = ID;
    root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    const boxes = els.map((el, i) => {
      const box = document.createElement('div');
      box.style.cssText = 'position:fixed;box-sizing:border-box;border:2px solid #3b82f6;background:rgba(59,130,246,.15);border-radius:3px;box-shadow:0 0 0 1px rgba(0,0,0,.4);display:none;';
      const n = document.createElement('span');
      n.textContent = String(i + 1);
      n.style.cssText = 'position:absolute;top:2px;left:2px;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:#3b82f6;color:#fff;font:600 10px/16px sans-serif;text-align:center;';
      box.appendChild(n);
      root.appendChild(box);
      return box;
    });
    document.documentElement.appendChild(root);
    let raf = 0;
    const tick = () => {
      if (!root.isConnected) return;
      els.forEach((el, i) => {
        const b = boxes[i];
        if (!el || !el.isConnected) { b.style.display = 'none'; return; }
        const r = el.getBoundingClientRect();
        b.style.display = r.width && r.height ? 'block' : 'none';
        b.style.left = r.left + 'px'; b.style.top = r.top + 'px';
        b.style.width = r.width + 'px'; b.style.height = r.height + 'px';
      });
      raf = requestAnimationFrame(tick);
    };
    root.__stop = () => cancelAnimationFrame(raf);
    tick();
    return els.filter(Boolean).length;
  })()`;
  // Clearing must never relaunch an idle-closed Chrome or fail on a tab that is already gone.
  if (!list.length) return peekBrowser(profileName) ? evalJs(profileName, targetId, expr).catch(() => 0) : 0;
  return evalJs(profileName, targetId, expr);
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
