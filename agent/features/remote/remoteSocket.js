import { unregisterProtocol } from "../../transport/broadcast.js";
import { createLogger } from "../../lib/logger.js";
import { ADAPTER_STATE } from "../../lib/transportConstants.js";
import { wakeDisplay } from "../../lib/displayWaker.js";

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

  const clientApiKey = socket.handshake.auth?.apiKey;
  const tileManager = new TileManager(robot);
  resourceManager.addClient(socket.id, { tileManager, screenInterval: null, authenticated: true, apiKey: clientApiKey });

  // Reuse connection-level PM created in transport/server.js
  const protocol = socket.data.protocol;
  if (!protocol) { socket.emit("remote:unavailable"); return; }
  socket.data.remoteAttached = true;

  // Wake display on every remote action (mouse/key/screen) — throttled internally
  const requireAuth = (handler) => (...args) => { wakeDisplay(); return handler(...args); };
  mouseHandler.setupMouseHandlers(socket, requireAuth);
  keyboardHandler.setupKeyboardHandlers(socket, requireAuth);
  screenHandler.setupScreenHandlers(socket, requireAuth, protocol);

  // WS rớt + RTC ready → giữ vô hạn, cleanup khi RTC tự closed.
  // RTC chưa ready → cleanup ngay (giữ retry behavior cũ).
  socket.on("disconnect", () => {
    const cleanup = () => {
      resourceManager.removeClient(socket.id);
      protocol.close();
      unregisterProtocol(protocol);
    };
    const rtc = protocol._adapters?.get("rtc");
    if (!rtc?.ready) return cleanup();
    rtc.on("stateChange", (s) => { if (s === ADAPTER_STATE.closed) cleanup(); });
  });

  socket.emit("remote:ready");
}

export async function setupRemoteSocket(io, apiKey) {
  // Legacy: kept for compatibility — no longer creates a separate namespace.
  // Remote handlers are now attached per-socket via setupRemoteHandlers().
}
