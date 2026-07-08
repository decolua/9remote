import { unregisterProtocol } from "../../transport/broadcast.js";
import { createLogger } from "../../lib/logger.js";
import { ADAPTER_STATE } from "../../lib/transportConstants.js";
import { wakeDisplay } from "../../lib/displayWaker.js";
import { REMOTE_CONFIG } from "./REMOTE_CONFIG.js";

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
    logger.info("✅ Remote desktop not available (headless environment)");
    return remoteAvailable;
  }
  try {
    const robotModule = await import("@hurdlegroup/robotjs");
    const robot = robotModule.default || robotModule;
    robot.getScreenSize();
    remoteAvailable = true;
  } catch {
    remoteAvailable = false;
    logger.info("✅ Remote desktop not available (no display or robotjs not installed)");
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
let resourceManager = null;
let screenUpdateHelper = null;
let mouseHandler = null;
let keyboardHandler = null;
let screenHandler = null;

async function loadRemoteModules() {
  if (robot) return true;
  try {
    const robotModule = await import("@hurdlegroup/robotjs");
    robot = robotModule.default || robotModule;
    const { TileManager: TM } = await import("./TileManager.js");
    const { ResourceManager: RM } = await import("./ResourceManager.js");
    const { ScreenUpdateHelper: SUH } = await import("./utils/ScreenUpdateHelper.js");
    const { MouseHandler: MH } = await import("./handlers/MouseHandler.js");
    const { KeyboardHandler: KH } = await import("./handlers/KeyboardHandler.js");
    const { ScreenHandler: SH } = await import("./handlers/ScreenHandler.js");
    TileManager = TM; ResourceManager = RM; ScreenUpdateHelper = SUH;
    MouseHandler = MH; KeyboardHandler = KH; ScreenHandler = SH;
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
    screenHandler = new ScreenHandler(resourceManager, screenUpdateHelper);
    resourceManager.startResourceMonitoring();
  }

  // Reuse connection-level PM created in transport/server.js
  const protocol = socket.data.protocol;
  if (!protocol) { socket.emit("remote:unavailable"); return; }

  const clientApiKey = socket.handshake.auth?.apiKey;
  const tileManager = new TileManager(robot);
  resourceManager.addClient(socket.id, { tileManager, protocol, screenInterval: null, authenticated: true, apiKey: clientApiKey });

  socket.data.remoteAttached = true;

  // Wake display on every remote action (mouse/key/screen) — throttled internally
  const requireAuth = (handler) => (...args) => { wakeDisplay(); return handler(...args); };
  mouseHandler.setupMouseHandlers(socket, requireAuth);
  keyboardHandler.setupKeyboardHandlers(socket, requireAuth);
  screenHandler.setupScreenHandlers(socket, requireAuth, protocol);

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
}

export async function setupRemoteSocket(io, apiKey) {
  // Legacy: kept for compatibility — no longer creates a separate namespace.
  // Remote handlers are now attached per-socket via setupRemoteHandlers().
}
