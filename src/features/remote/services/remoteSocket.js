// Remote Desktop Socket.IO namespace

// Track remote availability globally
let remoteAvailable = null;

// Check if robotjs is available (called once at startup)
export async function checkRemoteAvailable() {
  if (remoteAvailable !== null) return remoteAvailable;
  
  try {
    await import("@hurdlegroup/robotjs");
    remoteAvailable = true;
    console.log("✅ Remote desktop available");
  } catch {
    remoteAvailable = false;
    console.log("ℹ️ Remote desktop not available (robotjs not installed)");
  }
  return remoteAvailable;
}

// Get cached remote availability status
export function isRemoteAvailable() {
  return remoteAvailable === true;
}

export async function setupRemoteSocket(io) {
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
      screenHandler = new ScreenHandler(resourceManager, screenUpdateHelper);
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

    socket.on("disconnect", () => {
      console.log("🖥️ Remote client disconnected:", socket.id);
      resourceManager.removeClient(socket.id);
    });
  });
}
