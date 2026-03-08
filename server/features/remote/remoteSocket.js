import { WebRTCManager } from "./webrtcManager.js";
import { WebRTCHandler } from "./handlers/webrtcHandler.js";
import { REMOTE_CONFIG } from "./REMOTE_CONFIG.js";

const { enableWebRTC, enableTurn } = REMOTE_CONFIG.webrtc;

// Singleton WebRTC manager (only used if enableWebRTC is true)
const webrtcManager = enableWebRTC ? new WebRTCManager() : null;

// Track remote availability globally
let remoteAvailable = null;

function isKnownHeadless() {
  // Known headless environments - skip slow robotjs import
  return (
    process.env.CODESPACES === "true" ||
    process.env.GITPOD_WORKSPACE_ID ||
    (process.platform === "linux" && !process.env.DISPLAY)
  );
}

// Check if robotjs is available (called once at startup)
export async function checkRemoteAvailable() {
  if (remoteAvailable !== null) return remoteAvailable;
  
  // Quick check for known headless environments
  if (isKnownHeadless()) {
    remoteAvailable = false;
    console.log("✅ Remote desktop not available (headless environment)");
    return remoteAvailable;
  }
  
  // Actually test robotjs for unknown environments
  try {
    const robotModule = await import("@hurdlegroup/robotjs");
    const robot = robotModule.default || robotModule;
    robot.getScreenSize(); // Will throw if no display
    remoteAvailable = true;
  } catch {
    remoteAvailable = false;
    console.log("✅ Remote desktop not available (no display or robotjs not installed)");
  }
  return remoteAvailable;
}

// Get cached remote availability status
export function isRemoteAvailable() {
  return remoteAvailable === true;
}

export async function setupRemoteSocket(io, apiKey) {
  // Init WebRTC only if enabled; fetch TURN only if enableTurn is true
  if (enableWebRTC && webrtcManager) {
    const key = enableTurn ? apiKey : null;
    webrtcManager.init(key).catch(err =>
      console.error("[WebRTC] init error:", err.message)
    );
  }
  let robot = null;
  let TileManager = null;
  let ResourceManager = null;
  let ScreenUpdateHelper = null;
  let MouseHandler = null;
  let KeyboardHandler = null;
  let ScreenHandler = null;

  // Lazy load remote modules (they require native dependencies)
  const loadRemoteModules = async () => {
    if (robot) return true;
    
    try {
      const robotModule = await import("@hurdlegroup/robotjs");
      robot = robotModule.default || robotModule;
      
      const { TileManager: TM } = await import("./TileManager.js");
      const { ResourceManager: RM } = await import("./ResourceManager.js");
      const { ScreenUpdateHelper: SUH } = await import("./utils/ScreenUpdateHelper.js");
      const { MouseHandler: MH } = await import("./handlers/mouseHandler.js");
      const { KeyboardHandler: KH } = await import("./handlers/keyboardHandler.js");
      const { ScreenHandler: SH } = await import("./handlers/screenHandler.js");
      
      TileManager = TM;
      ResourceManager = RM;
      ScreenUpdateHelper = SUH;
      MouseHandler = MH;
      KeyboardHandler = KH;
      ScreenHandler = SH;
      
      robot.setMouseDelay(2);
      robot.setKeyboardDelay(2);
      
      return true;
    } catch (error) {
      console.error("❌ Failed to load remote modules:", error.message);
      return false;
    }
  };

  const remoteNs = io.of("/remote");
  
  // Initialize handlers when first connection
  let resourceManager = null;
  let screenUpdateHelper = null;
  let mouseHandler = null;
  let keyboardHandler = null;
  let screenHandler = null;
  const webrtcHandler = enableWebRTC && webrtcManager ? new WebRTCHandler(webrtcManager) : null;

  remoteNs.on("connection", async (socket) => {
    // Check apiKey from handshake auth
    const apiKey = socket.handshake.auth?.apiKey;
    if (!apiKey) {
      console.log("❌ Remote connection rejected: no apiKey");
      socket.disconnect();
      return;
    }

    console.log("🖥️ Remote client connected:", socket.id);

    // Load modules on first connection
    const loaded = await loadRemoteModules();
    if (!loaded) {
      socket.emit("error", { message: "Remote desktop not available" });
      socket.disconnect();
      return;
    }

    // Initialize handlers if not already done
    if (!resourceManager) {
      resourceManager = new ResourceManager();
      screenUpdateHelper = new ScreenUpdateHelper(resourceManager);
      mouseHandler = new MouseHandler(robot, resourceManager);
      keyboardHandler = new KeyboardHandler(robot, resourceManager);
      screenHandler = new ScreenHandler(resourceManager, screenUpdateHelper, webrtcManager);
      resourceManager.startResourceMonitoring();
    }

    // Auto-authenticated via apiKey in handshake
    socket.isAuthenticated = true;

    // Create tile manager for this client
    const tileManager = new TileManager(robot);
    resourceManager.addClient(socket.id, {
      tileManager,
      screenInterval: null,
      authenticated: true,
      apiKey
    });

    // Simple passthrough - no auth check needed
    const requireAuth = (handler) => handler;

    // Setup all handlers
    mouseHandler.setupMouseHandlers(socket, requireAuth);
    keyboardHandler.setupKeyboardHandlers(socket, requireAuth);
    screenHandler.setupScreenHandlers(socket, requireAuth);
    webrtcHandler?.setupWebRTCHandlers(socket);

    socket.on("disconnect", () => {
      console.log("🖥️ Remote client disconnected:", socket.id);
      resourceManager.removeClient(socket.id);
      if (enableWebRTC && webrtcManager) webrtcManager.closePeer(socket.id);
    });
  });
}
