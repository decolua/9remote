import { createLogger } from "../../lib/logger.js";
import { getIO } from "../../transport/server.js";
import { broadcast } from "../../transport/broadcast.js";
import { TABS_POLL_MS } from "./constants.js";
import {
  closeTab,
  createProfile,
  evalJs,
  focusTab,
  getOrLaunchBrowser,
  goBack,
  goForward,
  inspectElementAt,
  listProfiles,
  listTabs,
  navigateTab,
  openTab,
  reloadTab,
  removeProfile
} from "./browserEngine.js";
import { ackFrame, dispatchInput, startStream, stopStream } from "./stream.js";
import { importCookiesToSession, parseCookiesFromFile, parseCookiesJson } from "./cookieImport.js";

const logger = createLogger("browserSocket");

let tabsWatchers = 0;
let tabsPollTimer = null;
let lastTabsJson = "";

async function pushTabs() {
  try {
    const tabs = await listTabs("default");
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

export function setupBrowserHandlers(socket) {
  let watching = false;
  const activeTargetStreams = new Set();

  socket.on("browser:tabs.watch", ({ on } = {}) => {
    const next = on !== false;
    if (next === watching) return;
    watching = next;
    setTabsWatching(next ? 1 : -1);
  });

  socket.on("browser:invoke", async ({ action, payload = {} } = {}, cb) => {
    const profile = payload.profile || "default";
    try {
      switch (action) {
        case "tabs":
          return cb?.({ ok: true, tabs: await listTabs(profile) });
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
        case "inspect":
          return cb?.({ ok: true, element: await inspectElementAt(profile, payload.targetId, payload.x, payload.y) });
        case "eval":
          return cb?.({ ok: true, result: await evalJs(profile, payload.targetId, payload.expression) });
        case "profiles.list":
          return cb?.({ ok: true, profiles: listProfiles() });
        case "profiles.create":
          return cb?.({ ok: true, ...(createProfile(payload.name, { userAgentUnmodified: payload.userAgentUnmodified })) });
        case "profiles.remove":
          return cb?.({ ok: true, ...(await removeProfile(payload.name)) });
        case "cookie.import": {
          let cookies = [];
          if (payload.filePath) {
            cookies = parseCookiesFromFile(payload.filePath);
          } else if (payload.content) {
            cookies = parseCookiesJson(payload.content);
          }
          const browser = await getOrLaunchBrowser(profile);
          const attached = await browser.client.call("Target.attachToTarget", { targetId: String(payload.targetId), flatten: true });
          const res = await importCookiesToSession(browser.client, attached.sessionId, cookies);
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
      const browser = await getOrLaunchBrowser(profile);
      const res = await startStream(browser.client, targetId, { width, height }, (frame) => {
        const io = getIO();
        if (io) broadcast(io, "browser:frame", frame);
      });
      activeTargetStreams.add(String(targetId));
      cb?.({ ok: true, ...res });
    } catch (e) {
      logger.error(`stream.start failed: ${e.message}`);
      cb?.({ ok: false, error: e.message });
    }
  });

  socket.on("browser:stream.ack", ({ targetId, seq } = {}) => ackFrame(targetId, seq));

  socket.on("browser:stream.stop", ({ targetId } = {}) => {
    activeTargetStreams.delete(String(targetId || ""));
    void stopStream(targetId);
  });

  socket.on("browser:input", async ({ targetId, events } = {}, cb) => {
    try {
      cb?.({ ok: true, ...(await dispatchInput(targetId, events)) });
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
