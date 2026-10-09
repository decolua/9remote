import { createLogger } from "../../lib/logger.js";
import { getIO } from "../../transport/server.js";
import { broadcast } from "../../transport/broadcast.js";
import { CHANNELS } from "../../lib/transportConstants.js";
import { STREAM_RESYNC_MIN_MS, TABS_POLL_MS } from "./constants.js";
import { encodeTilesBatch } from "../remote/handlers/ScreenHandler.js";
import { closeTab, createProfile, enrichHistory, evalJs, focusTab, getOrLaunchBrowser, goBack, goForward, inspectElementAt, listProfiles, listTabs, markPicked, navState, navigateTab, noteBrowserActivity, noteWatchedWindow, openTab, peekBrowser, peekTabs, pickElementsInRect, reloadTab, removeProfile, safeProfileName, searchHistory, setViewport, syncActiveTab } from "./browserEngine.js";
import { ackFrame, compareClientTileHashes, dispatchInput, startStream, stopStream } from "./stream.js";
import { importCookiesToSession, parseCookiesContent } from "./cookieImport.js";
import { detectInstalledBrowsers, extractBrowserCookies } from "./browserDetect.js";
import { setTabsPushHook } from "./browserEngine.js";

const logger = createLogger("browserSocket");

let tabsPollTimer = null;
// Per-profile dedupe: a client that switches profile (or reloads) must get a
// first push for THAT profile even when its tabs did not change.
const lastTabsJsonByProfile = new Map();
const watchingProfiles = new Map(); // `${profile}|${windowId}` -> watcher count

async function pushTabs(profile, windowId = null) {
  try {
    // Sync the "active" flag with the real Chrome first: tabs the user clicked
    // directly in the window never notify CDP, visibility polling is the only
    // signal of which tab is actually front.
    const instance = peekBrowser(profile);
    if (instance) await syncActiveTab(instance);
    let tabs = await peekTabs(profile);
    if (windowId != null) {
      const base = tabs.filter((t) => t.windowId === windowId);
      // A window.open popup is its OWN Chrome window — keep it in the push so
      // the pane can float it (OAuth flows), as long as its opener lives in
      // the watched window.
      const ids = new Set(base.map((t) => t.id));
      tabs = [...base, ...tabs.filter((t) => t.openerId && ids.has(t.openerId))];
    }
    enrichHistory(tabs);
    const json = JSON.stringify(tabs);
    const dedupeKey = `${profile}|${windowId == null ? "" : windowId}`;
    if (json === lastTabsJsonByProfile.get(dedupeKey)) return;
    lastTabsJsonByProfile.set(dedupeKey, json);
    const io = getIO();
    if (io) broadcast(io, "browser:tabs", { profile, windowId, tabs });
  } catch { /* wait next poll */ }
}

// Agent tabs ride every browser:tabs push so any profile the engine drives is
// visible on every strip. Lazy import keeps the browser feature loadable
// without browserUse.
let agentTabsModule = null;
async function currentAgentTabs() {
  if (agentTabsModule === null) {
    agentTabsModule = await import("../browserUse/engine.js").catch(() => false);
  }
  if (!agentTabsModule) return [];
  try { return await agentTabsModule.agentTabsSnapshot(); }
  catch { return []; }
}
let lastAgentTabsJson = "";

async function pushAllTabs() {
  for (const key of watchingProfiles.keys()) {
    const [profile, windowId] = key.split("|");
    void pushTabs(profile, windowId === "" || windowId === "null" ? null : Number(windowId));
  }
}

// Agent tabs must reach every connected client even when NO workspace watches
// a window (the strip shows them without owning one), so their poll runs on
// its own timer, alive while any socket is connected.
let agentPollTimer = null;
function ensureAgentPoll() {
  if (agentPollTimer) return;
  agentPollTimer = setInterval(async () => {
    const io = getIO();
    if (!io || !io.engine?.clientsCount) return;
    const agentTabs = await currentAgentTabs();
    const json = JSON.stringify(agentTabs);
    if (json === lastAgentTabsJson) return;
    lastAgentTabsJson = json;
    broadcast(io, "browser:agentTabs", { agentTabs }); // empty list clears the strips too
  }, TABS_POLL_MS);
  if (agentPollTimer.unref) agentPollTimer.unref();
}

function setTabsWatching(delta, profile, windowId = null) {
  const key = `${profile}|${windowId == null ? "" : windowId}`;
  const count = Math.max(0, (watchingProfiles.get(key) || 0) + delta);
  if (count > 0) watchingProfiles.set(key, count);
  else watchingProfiles.delete(key);
  if (watchingProfiles.size > 0 && !tabsPollTimer) {
    tabsPollTimer = setInterval(pushAllTabs, TABS_POLL_MS);
    pushAllTabs();
  } else if (watchingProfiles.size === 0 && tabsPollTimer) {
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
// Resync throttle (per target): each resync mints a full frame — a spamming
// or looping client must not turn that into a bandwidth firehose.
const lastResyncAt = new Map();

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

// Watchers per streamed tab across ALL sockets: the stream tears down when
// the LAST socket stops watching (a pane on another client keeps it alive).
// A socket-id Map, not a counter — a stop racing an in-flight start can
// neither inflate nor deflate it, so zombie records cannot pile up.
const streamWatchers = new Map(); // targetId -> Map<socketId, socket>

function watchTarget(socket, tid) {
  let watchers = streamWatchers.get(tid);
  if (!watchers) { watchers = new Map(); streamWatchers.set(tid, watchers); }
  watchers.set(socket.id, socket);
}

function unwatchTarget(socketId, tid) {
  const watchers = streamWatchers.get(tid);
  if (!watchers) return;
  watchers.delete(socketId);
  if (!watchers.size) {
    streamWatchers.delete(tid);
    void stopStream(tid);
  }
}

// Tiles carry no target id on the wire, so they go ONLY to clients watching
// this tab — a phone on tab Y must never paint tab X's tiles.
// Rides CHANNELS.browser (dcBrowser on RTC, browser:tiles-bin on WS), exactly
// like Remote Desktop's protocol.sendTiles pipeline.
function emitTiles(frame, frameTs = Date.now()) {
  if (!frame) return false;
  const tiles = frame.tiles;
  if (!Array.isArray(tiles) || !tiles.length) return true;
  const pms = new Set();
  for (const socket of streamWatchers.get(frame.targetId)?.values() || []) {
    if (socket.data?.protocol) pms.add(socket.data.protocol);
  }
  let sentAny = false;
  for (const pm of pms) {
    // Size first (control lane, ordered): tiles must never paint on a canvas of the wrong size.
    if (frame.dims) pm.emit("browser:screen-dimensions", frame.dims);
    const sent = pm.sendTiles({ tiles, timestamp: frameTs }, encodeTilesBatch, CHANNELS.browser);
    if (sent?.length) sentAny = true;
  }
  return sentAny;
}

export function setupBrowserHandlers(socket) {
  ensureAgentPoll();
  // One watched (profile, window) per socket — the workspace the client is
  // looking at: its profile AND its own Chrome window of that profile.
  let watchingProfile = null;
  let watchingWindowId = null;
  const activeTargetStreams = new Set();

  // Target events → immediate (debounced) push: a new tab or a link navigation
  // shows in the strip in ~100ms instead of the next 2s poll tick.
  let eventPushTimer = null;
  setTabsPushHook(() => {
    if (watchingProfiles.size === 0) return; // nobody is watching
    clearTimeout(eventPushTimer);
    eventPushTimer = setTimeout(pushAllTabs, 120);
  });

  socket.on("browser:tabs.watch", ({ on, profile, windowId } = {}) => {
    const name = safeProfileName(profile) ? profile : "default";
    const win = Number.isFinite(Number(windowId)) && Number(windowId) > 0 ? Number(windowId) : null;
    const next = on !== false;
    if (next && (watchingProfile !== name || watchingWindowId !== win)) {
      if (watchingProfile) setTabsWatching(-1, watchingProfile, watchingWindowId);
      watchingProfile = name;
      watchingWindowId = win;
      noteWatchedWindow(name, win);
      // Fresh watcher on this key gets a first push even when its tabs are
      // unchanged — the dedupe would otherwise leave the strip empty.
      lastTabsJsonByProfile.delete(`${name}|${win == null ? "" : win}`);
      setTabsWatching(1, name, win);
    } else if (!next && watchingProfile) {
      setTabsWatching(-1, watchingProfile, watchingWindowId);
      noteWatchedWindow(watchingProfile, null);
      watchingProfile = null;
      watchingWindowId = null;
    }
  });

  socket.on("browser:invoke", async ({ action, payload = {} } = {}, cb) => {
    const profile = payload.profile || "default";
    noteBrowserActivity(profile);
    try {
      switch (action) {
        case "tabs":
          return cb?.({ ok: true, tabs: await listTabs(profile) });
        case "tabs.peek":
          // Read-only: fills the strip without ever launching Chrome.
          return cb?.({ ok: true, tabs: await peekTabs(profile) });
        case "warm":
          // Pre-boot the profile's Chrome so the first URL skips the cold start.
          return cb?.({ ok: true, ...(await getOrLaunchBrowser(profile).then(() => ({}), (e) => ({ error: e.message }))) });
        case "viewport":
          return cb?.({ ok: true, ...(await setViewport(profile, payload.targetId, payload.width, payload.height, { mobile: !!payload.mobile, reset: !!payload.reset })) });
        case "open":
          return cb?.({ ok: true, ...(await openTab(profile, payload.url, { newWindow: !!payload.newWindow, windowId: payload.windowId || null })) });
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
        case "pick.mark":
          return cb?.({ ok: true, marked: await markPicked(profile, payload.targetId, payload.selectors) });
        case "eval":
          return cb?.({ ok: true, result: await evalJs(profile, payload.targetId, payload.expression) });
        case "screenshot": {
          const browser = await getOrLaunchBrowser(profile);
          const sessionId = await browser.sessionFor(payload.targetId);
          const shot = await browser.client.call("Page.captureScreenshot", { format: "jpeg", quality: 90 }, sessionId);
          return cb?.({ ok: true, image: shot?.data });
        }
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

  socket.on("browser:stream.start", async ({ targetId, width, height, quality, scale, mobile, profile = "default", isPopup = false } = {}, cb) => {
    try {
      noteBrowserActivity(profile);
      const browser = await getOrLaunchBrowser(profile);
      let id = String(targetId || "");
      // Watch BEFORE the start: its first frame (an immediate capture) fires
      // inside startStream and must already have a recipient.
      watchTarget(socket, id);
      let res;
      try {
        res = await startStream(browser.client, id, { width, height, quality, scale, mobile }, emitTiles);
      } catch (e) {
        // Stale tab id (Chrome restarted / tab closed): stream the profile's
        // live tab instead — a dead-stream error leaves the pane unhealable.
        if (!/No target/i.test(String(e?.message))) {
          unwatchTarget(socket.id, id);
          throw e;
        }
        unwatchTarget(socket.id, id);
        const tabs = await listTabs(profile);
        const live = tabs.find((t) => t.active) || tabs[0];
        if (!live) throw e;
        id = live.id;
        watchTarget(socket, id);
        res = await startStream(browser.client, id, { width, height, quality, scale, mobile }, emitTiles);
      }
      // Non-popup: evict any prior tab streamed on this socket so 2 tabs never interleave.
      if (!isPopup) {
        for (const oldId of [...activeTargetStreams]) {
          if (oldId !== id) {
            activeTargetStreams.delete(oldId);
            unwatchTarget(socket.id, oldId);
          }
        }
      }
      activeTargetStreams.add(id);
      watchTarget(socket, id);
      cb?.({ ok: true, ...res, targetId: id });
    } catch (e) {
      logger.error(`stream.start failed: ${e.message}`);
      cb?.({ ok: false, error: e.message });
    }
  });

  socket.on("browser:stream.ack", (payload = {}) => {
    ackFrame(payload.targetId, payload.seq ?? payload.ts);
  });

  socket.on("browser:stream.stop", ({ targetId } = {}) => {
    const id = String(targetId || "");
    activeTargetStreams.delete(id);
    // Teardown only when no OTHER socket still watches this tab.
    unwatchTarget(socket.id, id);
  });

  // Remote Desktop compareClientTileHashes: client sends array of tileHashes;
  // host diffs with current screen and sends missing/mismatched tiles.
  socket.on("browser:request-tiles-hashes", ({ targetId, tileHashes } = {}) => {
    const id = String(targetId || "");
    if (!id) return;
    const now = Date.now();
    if (now - (lastResyncAt.get(id) || 0) < STREAM_RESYNC_MIN_MS) return;
    lastResyncAt.set(id, now);
    void compareClientTileHashes(id, Array.isArray(tileHashes) ? tileHashes : []);
  });

  socket.on("browser:input", async ({ targetId, events, profile = "default" } = {}, cb) => {
    try {
      noteBrowserActivity(profile);
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
    if (watchingProfile) setTabsWatching(-1, watchingProfile, watchingWindowId);
    for (const tid of activeTargetStreams) unwatchTarget(socket.id, tid);
    activeTargetStreams.clear();
  });
}
