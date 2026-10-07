import { createLogger } from "../../lib/logger.js";
import { getIO } from "../../transport/server.js";
import { broadcast } from "../../transport/broadcast.js";
import { TABS_POLL_MS } from "./constants.js";
import {
  closeTab,
  createProfile,
  enrichHistory,
  evalJs,
  focusTab,
  getOrLaunchBrowser,
  goBack,
  goForward,
  inspectElementAt,
  pickElementsInRect,
  peekBrowser,
  safeProfileName,
  listProfiles,
  listTabs,
  navigateTab,
  navState,
  openTab,
  peekTabs,
  reloadTab,
  removeProfile,
  searchHistory,
  setViewport
} from "./browserEngine.js";
import { ackFrame, dispatchInput, startStream, stopStream } from "./stream.js";
import { importCookiesToSession, parseCookiesContent } from "./cookieImport.js";
import { detectInstalledBrowsers, extractBrowserCookies } from "./browserDetect.js";
import { setTabsPushHook } from "./browserEngine.js";

const logger = createLogger("browserSocket");

let tabsWatchers = 0;
let tabsPollTimer = null;
let lastTabsJson = "";
let currentWatchedProfile = "default";

async function pushTabs() {
  try {
    const tabs = await peekTabs(currentWatchedProfile);
    enrichHistory(tabs);
    const json = JSON.stringify(tabs);
    if (json === lastTabsJson) return;
    lastTabsJson = json;
    const io = getIO();
    if (io) broadcast(io, "browser:tabs", { tabs });
  } catch { /* wait next poll */ }
}

function setTabsWatching(delta) {
  tabsWatchers = Math.max(0, tabsWatchers + delta);
  if (tabsWatchers > 0 && !tabsPollTimer) {
    tabsPollTimer = setInterval(pushTabs, TABS_POLL_MS);
    void pushTabs();
  } else if (tabsWatchers === 0 && tabsPollTimer) {
    clearInterval(tabsPollTimer);
    tabsPollTimer = null;
  }
}

// Hover cursor probe: after a mouse move, ask the page what sits under the
// pointer and tell the pane which CSS cursor to show. Throttled + change-gated.
const CURSOR_PROBE_MS = 150;
const CURSOR_EXPRESSION = `(() => {
  const el = document.elementFromPoint(__X__, __Y__);
  if (!el) return "default";
  if (el.closest("input:not([type=button]):not([type=checkbox]):not([type=radio]),textarea,[contenteditable=\\"true\\"]")) return "text";
  if (el.closest("a[href],button,[role=button],[onclick],select,label,input")) return "pointer";
  return "default";
})()`;
const lastCursorAt = new Map(); // targetId -> ts
const lastCursorValue = new Map(); // targetId -> cursor

async function probeCursor(profile, targetId, x, y) {
  const id = String(targetId || "");
  const now = Date.now();
  if (now - (lastCursorAt.get(id) || 0) < CURSOR_PROBE_MS) return;
  lastCursorAt.set(id, now);
  try {
    const browser = peekBrowser(profile);
    if (!browser) return;
    const sessionId = await browser.sessionFor(id);
    const expr = CURSOR_EXPRESSION.replace("__X__", Math.round(Number(x) || 0)).replace("__Y__", Math.round(Number(y) || 0));
    const res = await browser.client.call("Runtime.evaluate", { expression: expr, returnByValue: true }, sessionId);
    const cursor = res?.result?.value;
    if (typeof cursor !== "string" || cursor === lastCursorValue.get(id)) return;
    lastCursorValue.set(id, cursor);
    const io = getIO();
    if (io) broadcast(io, "browser:cursor", { targetId: id, cursor });
  } catch { /* probe is best-effort */ }
}

export function setupBrowserHandlers(socket) {
  let watching = false;
  const activeTargetStreams = new Set();

  // Target events → immediate (debounced) push: a new tab or a link navigation
  // shows in the strip in ~100ms instead of the next 2s poll tick.
  let eventPushTimer = null;
  setTabsPushHook(() => {
    if (!tabsPollTimer && !watching) return; // nobody is watching
    clearTimeout(eventPushTimer);
    eventPushTimer = setTimeout(() => { void pushTabs(); }, 120);
  });

  socket.on("browser:tabs.watch", ({ on, profile } = {}) => {
    if (profile) currentWatchedProfile = profile;
    const next = on !== false;
    if (next !== watching) {
      watching = next;
      // A freshly connected client (page reload, reconnect) must get a first
      // push even when the tabs are unchanged — the global dedupe would
      // otherwise leave its strip empty and its pane stuck on a dead targetId.
      if (next) lastTabsJson = "";
      setTabsWatching(next ? 1 : -1);
    } else if (profile) {
      lastTabsJson = "";
      void pushTabs();
    }
  });

  socket.on("browser:invoke", async ({ action, payload = {} } = {}, cb) => {
    const profile = payload.profile || "default";
    try {
      switch (action) {
        case "tabs":
          return cb?.({ ok: true, tabs: await listTabs(profile) });
        case "tabs.peek":
          // Read-only: fills the strip without ever launching Chrome.
          return cb?.({ ok: true, tabs: await peekTabs(profile) });
        case "viewport":
          return cb?.({ ok: true, ...(await setViewport(profile, payload.targetId, payload.width, payload.height)) });
        case "open":
          return cb?.({ ok: true, ...(await openTab(profile, payload.url)) });
        case "close":
          return cb?.({ ok: true, ...(await closeTab(profile, payload.targetId)) });
        case "focus":
          return cb?.({ ok: true, ...(await focusTab(profile, payload.targetId)) });
        case "go":
        case "navigate":
          return cb?.({ ok: true, ...(await navigateTab(profile, payload.targetId, payload.url)) });
        case "reload":
          return cb?.({ ok: true, ...(await reloadTab(profile, payload.targetId, { ignoreCache: payload.ignoreCache })) });
        case "back":
          return cb?.({ ok: true, ...(await goBack(profile, payload.targetId)) });
        case "forward":
          return cb?.({ ok: true, ...(await goForward(profile, payload.targetId)) });
        case "nav":
          return cb?.({ ok: true, ...(await navState(profile, payload.targetId)) });
        case "inspect":
          return cb?.({ ok: true, element: await inspectElementAt(profile, payload.targetId, payload.x, payload.y) });
        case "pick.rect":
          return cb?.({ ok: true, elements: await pickElementsInRect(profile, payload.targetId, payload.x, payload.y, payload.width, payload.height) });
        case "eval":
          return cb?.({ ok: true, result: await evalJs(profile, payload.targetId, payload.expression) });
        case "profiles.list":
          return cb?.({ ok: true, profiles: listProfiles() });
        case "profiles.create":
          return cb?.({ ok: true, ...(createProfile(payload.name)) });
        case "profiles.remove":
          return cb?.({ ok: true, ...(await removeProfile(payload.name)) });
        case "history.search": {
          const q = typeof payload.q === "string" ? payload.q.slice(0, 200) : "";
          return cb?.({ ok: true, items: searchHistory(q) });
        }
        case "browsers.detect":
          return cb?.({ ok: true, browsers: detectInstalledBrowsers() });
        case "cookie.importFromBrowser": {
          const { family, profileDirectory, targetId } = payload;
          if (!family || !targetId) return cb?.({ ok: false, error: "family and targetId are required" });
          const cookies = await extractBrowserCookies(family, profileDirectory);
          const browser = await getOrLaunchBrowser(profile);
          const sessionId = await browser.sessionFor(targetId);
          const res = await importCookiesToSession(browser.client, sessionId, cookies);
          return cb?.({ ok: true, ...res, count: cookies.length });
        }
        case "profiles.createFromBrowser": {
          const { family, profileDirectory, name } = payload;
          const cleanName = safeProfileName(name) ? name : `${family}_${Date.now()}`;
          createProfile(cleanName);
          const cookies = await extractBrowserCookies(family, profileDirectory);
          const browser = await getOrLaunchBrowser(cleanName);
          const tab = await openTab(cleanName, "about:blank");
          const sessionId = await browser.sessionFor(tab.id);
          const res = await importCookiesToSession(browser.client, sessionId, cookies);
          return cb?.({ ok: true, profile: cleanName, tabId: tab.id, imported: res.imported });
        }
        case "cookie.import": {
          // Pasted cookies only — a filePath here would be an arbitrary-file-read
          // primitive for any connected client; the UI never needed it.
          const raw = typeof payload.content === "string" ? payload.content.slice(0, 1_000_000) : "";
          const cookies = parseCookiesContent(raw);
          if (!cookies.length) return cb?.({ ok: false, error: "No parsable cookies in content" });
          const browser = await getOrLaunchBrowser(profile);
          const sessionId = await browser.sessionFor(payload.targetId);
          const res = await importCookiesToSession(browser.client, sessionId, cookies);
          return cb?.({ ok: true, ...res });
        }
        default:
          return cb?.({ ok: false, error: `Unknown browser action: ${action}` });
      }
    } catch (e) {
      logger.error(`Action ${action} error: ${e.message}`);
      cb?.({ ok: false, error: e.message });
    }
  });

  socket.on("browser:stream.start", async ({ targetId, width, height, profile = "default" } = {}, cb) => {
    try {
      currentWatchedProfile = profile;
      const browser = await getOrLaunchBrowser(profile);
      const emit = (frame) => {
        const io = getIO();
        if (io) broadcast(io, "browser:frame", frame);
      };
      let id = String(targetId || "");
      let res;
      try {
        res = await startStream(browser.client, id, { width, height }, emit);
      } catch (e) {
        // Stale tab id (Chrome restarted / tab closed): stream the profile's
        // live tab instead — a dead-stream error leaves the pane unhealable.
        if (!/No target/i.test(String(e?.message))) throw e;
        const tabs = await listTabs(profile);
        const live = tabs.find((t) => t.active) || tabs[0];
        if (!live) throw e;
        id = live.id;
        res = await startStream(browser.client, id, { width, height }, emit);
      }
      activeTargetStreams.add(id);
      cb?.({ ok: true, ...res });
    } catch (e) {
      logger.error(`stream.start failed: ${e.message}`);
      cb?.({ ok: false, error: e.message });
    }
  });

  socket.on("browser:stream.ack", ({ targetId, seq } = {}) => {
    if (process.env.NODE_ENV !== "production") logger.info(`TEMP DIAGNOSTIC socket ack targetId=${targetId} seq=${seq}`);
    ackFrame(targetId, seq);
  });

  socket.on("browser:stream.stop", ({ targetId } = {}) => {
    activeTargetStreams.delete(String(targetId || ""));
    void stopStream(targetId);
  });

  socket.on("browser:input", async ({ targetId, events, profile = "default" } = {}, cb) => {
    try {
      const res = await dispatchInput(targetId, events);
      // A trailing hover move is the cursor probe's trigger.
      const last = Array.isArray(events) ? events[events.length - 1] : null;
      if (last?.t === "pointer" && last.type === "move" && !last.drag) {
        void probeCursor(profile, targetId, last.x, last.y);
      }
      cb?.({ ok: true, ...res });
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  socket.on("disconnect", () => {
    if (watching) setTabsWatching(-1);
    for (const tid of activeTargetStreams) void stopStream(tid);
    activeTargetStreams.clear();
  });
}
