import crypto from "crypto";
import { unregisterProtocol } from "../../transport/broadcast.js";
import { createLogger } from "../../lib/logger.js";
import { ADAPTER_STATE } from "../../lib/transportConstants.js";
import { wakeDisplay } from "../../lib/displayWaker.js";
import * as desktopBridge from "../../lib/desktopBridge.js";
import { REMOTE_CONFIG } from "./REMOTE_CONFIG.js";
import { readClipboardText } from "./utils/clipboard.js";

const logger = createLogger("remote");

// Track remote availability globally
let remoteAvailable = null;

function isKnownHeadless() {
  return (
    process.env.CODESPACES === "true" ||
    process.env.GITPOD_WORKSPACE_ID ||
    (process.platform === "linux" && !process.env.DISPLAY)
  );
}

export async function checkRemoteAvailable() {
  if (remoteAvailable !== null) return remoteAvailable;
  if (isKnownHeadless()) {
    remoteAvailable = false;
    logger.warn("Remote desktop not available (headless environment)");
    return remoteAvailable;
  }
  try {
    const robotModule = await import("@hurdlegroup/robotjs");
    const robot = robotModule.default || robotModule;
    robot.getScreenSize();
    remoteAvailable = true;
  } catch {
    remoteAvailable = false;
    logger.warn("Remote desktop not available (no display or robotjs not installed)");
  }
  return remoteAvailable;
}

export function isRemoteAvailable() {
  return remoteAvailable === true;
}

// Expose active client map for system stats (RAM monitor UI)
export function getResourceManager() {
  return resourceManager;
}

let robot = null;
let TileManager = null;
let ResourceManager = null;
let ScreenUpdateHelper = null;
let MouseHandler = null;
let KeyboardHandler = null;
let ScreenHandler = null;
let MonitorManager = null;
let resourceManager = null;
let screenUpdateHelper = null;
let mouseHandler = null;
let keyboardHandler = null;
let screenHandler = null;

// Multi-monitor + multi-DPI: robotjs is DPI-unaware, so mouse coords on a
// non-primary display or any scaled display come out wrong. Make the agent
// process per-monitor DPI-aware BEFORE any mouse API is called. Win32-only,
// must run once at module load (a process-wide setting).
async function enablePerMonitorDpiAwareness() {
  if (process.platform !== "win32") return;
  try {
    const koffi = (await import("koffi")).default;
    const user32 = koffi.load("user32.dll");
    const setDpi = user32.func("bool __stdcall SetProcessDpiAwarenessContext(void* value)");
    // PER_MONITOR_AWARE_V2 = -4. After this, mouse APIs use physical pixels.
    setDpi(koffi.as(-4, "void*"));
  } catch (err) {
    logger.warn(`DPI awareness setup failed: ${err.message}`);
  }
}

// Must precede any robotjs mouse API — invoked inside loadRemoteModules (the
// first code path that imports robotjs), so the process is DPI-aware before
// robotjs caches its view of the screen.

async function loadRemoteModules() {
  if (robot && TileManager && ResourceManager) return true;
  try {
    const robotModule = await import("@hurdlegroup/robotjs");
    robot = robotModule.default || robotModule;
    const { TileManager: TM } = await import("./TileManager.js");
    const { ResourceManager: RM } = await import("./ResourceManager.js");
    const { ScreenUpdateHelper: SUH } = await import("./utils/ScreenUpdateHelper.js");
    const { MouseHandler: MH } = await import("./handlers/MouseHandler.js");
    const { KeyboardHandler: KH } = await import("./handlers/KeyboardHandler.js");
    const { ScreenHandler: SH } = await import("./handlers/ScreenHandler.js");
    const { MonitorManager: MM } = await import("./MonitorManager.js");
    TileManager = TM; ResourceManager = RM; ScreenUpdateHelper = SUH;
    MouseHandler = MH; KeyboardHandler = KH; ScreenHandler = SH;
    MonitorManager = MM;
    await enablePerMonitorDpiAwareness();
    robot.setMouseDelay(2);
    robot.setKeyboardDelay(2);
    return true;
  } catch (error) {
    console.error("❌ Failed to load remote modules:", error.message);
    return false;
  }
}

/**
 * Setup remote desktop handlers on an existing socket.
 * Called per-connection from terminalSocket when client requests remote.
 */
export async function setupRemoteHandlers(socket, apiKey) {
  if (!remoteAvailable) {
    socket.emit("remote:unavailable");
    return;
  }

  const loaded = await loadRemoteModules();
  if (!loaded) {
    socket.emit("remote:unavailable");
    return;
  }

  if (!resourceManager) {
    resourceManager = new ResourceManager();
    screenUpdateHelper = new ScreenUpdateHelper(resourceManager);
    mouseHandler = new MouseHandler(robot, resourceManager);
    keyboardHandler = new KeyboardHandler(robot, resourceManager);
    screenHandler = new ScreenHandler(resourceManager, screenUpdateHelper, robot);
    resourceManager.startResourceMonitoring();
  }

  // Reuse connection-level PM created in transport/server.js
  const protocol = socket.data.protocol;
  if (!protocol) { socket.emit("remote:unavailable"); return; }

  const clientApiKey = socket.handshake.auth?.apiKey;
  // Multi-monitor is Win + Mac. Win maps input in physical px, Mac in points
  // (robotjs-mac takes points, matching node-screenshots origin/dims). Linux X11
  // virtual-desktop coords differ, so it keeps the legacy single-display path.
  const useMultiMonitor = process.platform === "win32" || process.platform === "darwin";
  const monitorManager = useMultiMonitor ? new MonitorManager() : null;
  const activeEntry = monitorManager?.getActive();
  const tileManager = new TileManager(robot, activeEntry ? { monitor: activeEntry.mon } : {});
  resourceManager.addClient(socket.id, {
    tileManager, protocol, monitorManager,
    screenInterval: null, authenticated: true, apiKey: clientApiKey
  });

  socket.data.remoteAttached = true;

  // Wake display on every remote action (mouse/key/screen) — throttled internally
  const requireAuth = (handler) => (...args) => { wakeDisplay(); return handler(...args); };
  mouseHandler.setupMouseHandlers(socket, requireAuth, protocol);
  keyboardHandler.setupKeyboardHandlers(socket, requireAuth);
  screenHandler.setupScreenHandlers(socket, requireAuth, protocol);

  // Windows unlock bridge — poll liveness + emit screen-locked on change.
  // Signals:
  //   ready  = worker pipe responds (STATE ok). Debounced: a transient miss
  //            (worker busy typing) holds the last verdict; persistent failure
  //            (worker gone) flips to not-ready after 3 polls.
  //   locked = capture keeps failing — Winlogon is a secure desktop, capture is
  //            blocked there. Session-independent (the worker's OpenInputDesktop
  //            would read session 0 when spawned by a SYSTEM task).
  let desktopPoll = null;
  let lastLocked = null;
  let lastReady = null;
  let readyFailCount = 0;
  if (desktopBridge.isSupported()) {
    const cfg = REMOTE_CONFIG.desktopUnlock;
    const computeAndEmit = async (force = false) => {
      const cd = resourceManager.getClient(socket.id);
      const name = await desktopBridge.getDesktopState();
      let ready;
      if (name != null) {
        readyFailCount = 0;
        ready = true;
      } else {
        readyFailCount++;
        // A transient STATE failure usually means the worker is busy typing
        // (single-threaded pipe) — hold the last ready verdict instead of
        // flipping to the grant prompt mid-unlock. Persistent failure (worker
        // actually gone) crosses the threshold within a few seconds.
        ready = readyFailCount >= 3 ? false : lastReady;
      }
      // Locked = capture keeps failing. When Windows is on the Winlogon (secure)
      // desktop, screen capture is blocked → captureErrorCount climbs. This is
      // session-independent (unlike the worker's OpenInputDesktop, which reads
      // the worker's own session — wrong when the task runs as SYSTEM in session 0).
      const errCount = cd?.captureErrorCount || 0;
      const locked = errCount >= cfg.captureErrorThreshold;
      if (force || locked !== lastLocked || ready !== lastReady) {
        lastLocked = locked;
        lastReady = ready;
        protocol.emit("screen-locked", { locked, ready });
      }
    };
    // computeAndEmit is async — an unguarded rejection would escape the timer.
    // It is also driven from two places (this interval and the client's
    // get-unlock-state), and it mutates the shared readyFailCount/lastReady
    // verdict across an await — overlapping runs would double-count a single
    // failure and flip the verdict early. One poll at a time.
    let pollInFlight = false;
    const pollDesktop = (force) => {
      if (pollInFlight) return;
      pollInFlight = true;
      return computeAndEmit(force)
        .catch((err) => logger.error(`desktop poll: ${err.message}`))
        .finally(() => { pollInFlight = false; });
    };
    pollDesktop();
    desktopPoll = setInterval(() => pollDesktop(false), cfg.pollIntervalMs);
    // Web requests the current state on mount (its listener races the first
    // emit) — re-emit unconditionally so the overlay shows even if the host
    // was already locked before the client connected.
    socket.on("get-unlock-state", requireAuth(() => pollDesktop(true)));
  }

  // Client submitted unlock text (PIN/password). Orchestration lives in JS:
  // type → wait → check; retry once on fail. Click-to-focus dropped — the user
  // can remote-click the field directly if focus is lost.
  socket.on("desktop-unlock", requireAuth(async (data) => {
    if (!desktopBridge.isSupported()) return;
    const text = typeof data?.text === "string" ? data.text : "";
    if (!text) return;
    const cfg = REMOTE_CONFIG.desktopUnlock;
    const waitMs = cfg.retryWaitMs;
    // Success = capture recovering (count drops below threshold once back on
    // the Default desktop). Same session-independent signal as the lock poll.
    const stillLocked = () => {
      const cd = resourceManager.getClient(socket.id);
      return (cd?.captureErrorCount || 0) >= cfg.captureErrorThreshold;
    };
    try {
      await desktopBridge.typeText(text);
      await new Promise((r) => setTimeout(r, waitMs));
      // Submit failed (wrong PIN) — Win11 refocuses the field after the Enter
      // that ended the first typeText, so just retype.
      if (stillLocked()) {
        await desktopBridge.typeText(text);
        await new Promise((r) => setTimeout(r, waitMs));
      }
      const ok = !stillLocked();
      socket.emit("unlock-result", { ok, reason: ok ? null : "still_locked" });
    } catch (err) {
      socket.emit("unlock-result", { ok: false, reason: err.message || "error" });
    }
  }));

  // WS rớt + RTC ready → giữ vô hạn, cleanup khi RTC tự closed.
  // RTC chưa ready → cleanup ngay (giữ retry behavior cũ).
  socket.on("disconnect", () => {
    const rtc = protocol._adapters?.get("rtc");
    let cleaned = false;
    let fallbackTimer = null;
    let onState = null;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
      if (rtc && onState) rtc.off("stateChange", onState);
      if (clipboardTimer) { clearInterval(clipboardTimer); clipboardTimer = null; }
      if (desktopPoll) { clearInterval(desktopPoll); desktopPoll = null; }
      resourceManager.removeClient(socket.id);
      protocol.close();
      unregisterProtocol(protocol);
    };
    if (!rtc?.ready) return cleanup();
    // WS dropped but RTC alive → keep session; cleanup on RTC death or grace timeout
    onState = (s) => { if (s === ADAPTER_STATE.closed) cleanup(); };
    rtc.on("stateChange", onState);
    fallbackTimer = setTimeout(cleanup, REMOTE_CONFIG.resourceManagement.disconnectGraceMs);
  });

  socket.emit("remote:ready");

  // Send monitor list so the client can render a switcher (hidden if only 1).
  // Only emitted on Win/Mac — Linux never sends it, so the client keeps the
  // switcher hidden and stays on the legacy single-display path.
  if (monitorManager) {
    protocol.emit("monitors", {
      list: monitorManager.list(),
      activeIndex: monitorManager.getActiveIndex()
    });
  }

  // Clipboard sync — poll host clipboard, emit only on content change.
  // First poll seeds baseline WITHOUT emitting (count EMPTY clipboard too) so the
  // first real change badges — otherwise an empty host clipboard makes the first
  // copy look like the baseline and the user must copy twice.
  let lastLen = -1;
  let lastHash = "";
  let seeded = false;
  // Guarded: the read is awaited before lastLen/lastHash/seeded are updated, so
  // a slow clipboard (large payload, busy host) could let the next tick observe
  // the pre-update baseline and emit the same change twice.
  let clipInFlight = false;
  const pollClipboard = async () => {
    if (clipInFlight) return;
    clipInFlight = true;
    try {
      const text = await readClipboardText(REMOTE_CONFIG.clipboard.maxTextLength);
      const len = text == null ? 0 : text.length;
      const hash = text == null ? "" : crypto.createHash("md5").update(text).digest("hex");
      if (len === lastLen && hash === lastHash) return;
      lastLen = len;
      lastHash = hash;
      if (!seeded) { seeded = true; return; }
      if (text != null) protocol.emit("clipboard-update", { text, hash });
    } catch (err) {
      logger.error(`clipboard poll: ${err.message}`);
    } finally {
      clipInFlight = false;
    }
  };
  let clipboardTimer = null;
  if (REMOTE_CONFIG.clipboard.enabled) {
    pollClipboard();
    clipboardTimer = setInterval(pollClipboard, REMOTE_CONFIG.clipboard.pollInterval);
  }
}

export async function setupRemoteSocket(io, apiKey) {
  // Legacy: kept for compatibility — no longer creates a separate namespace.
  // Remote handlers are now attached per-socket via setupRemoteHandlers().
}
