// Main Socket.IO setup
import { Server } from "socket.io";
import { writeFileSync } from "fs";
import { setupTerminalSocket } from "../../features/terminal/services/terminalSocket.js";
import { setupRemoteSocket, checkRemoteAvailable } from "../../features/remote/services/remoteSocket.js";

// Codespace detection and keep-alive
let activeTerminalConnections = 0;
let keepAliveInterval = null;

function getCodespaceInfo() {
  const isCodespaces = process.env.CODESPACES === "true";
  return {
    isCodespaces,
    codespaceName: isCodespaces ? process.env.CODESPACE_NAME : null
  };
}

function startKeepAlive() {
  if (keepAliveInterval) return;
  
  const codespaceInfo = getCodespaceInfo();
  console.log(`🔄 Starting Codespace keep-alive (${codespaceInfo.codespaceName})`);
  
  keepAliveInterval = setInterval(() => {
    // Touch file to create filesystem activity
    writeFileSync("/tmp/.codespace-keepalive", Date.now().toString());
  }, 60000); // Every 60 seconds
}

function stopKeepAlive() {
  if (!keepAliveInterval) return;
  
  console.log("⏸️  Stopping Codespace keep-alive");
  clearInterval(keepAliveInterval);
  keepAliveInterval = null;
}

export function trackTerminalConnection(connected) {
  const codespaceInfo = getCodespaceInfo();
  if (!codespaceInfo.isCodespaces) return;
  
  if (connected) {
    activeTerminalConnections++;
    if (activeTerminalConnections === 1) {
      startKeepAlive();
    }
  } else {
    activeTerminalConnections--;
    if (activeTerminalConnections === 0) {
      stopKeepAlive();
    }
  }
}

export async function setupSocketIO(server) {
  const io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
      credentials: true,
      allowedHeaders: ["*"]
    },
    transports: ["websocket", "polling"],
    allowEIO3: true,
    allowUpgrades: true,
    pingTimeout: 60000,
    pingInterval: 25000
  });

  // Check remote availability at startup
  await checkRemoteAvailable();

  // Setup Terminal namespace (default)
  setupTerminalSocket(io);

  // Setup Remote Desktop namespace (/remote)
  setupRemoteSocket(io);

  return io;
}
