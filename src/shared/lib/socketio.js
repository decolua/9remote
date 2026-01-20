// Main Socket.IO setup
import { Server } from "socket.io";
import fs from "fs";
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
  
  console.log("🔄 Starting Codespace keep-alive...");
  keepAliveInterval = setInterval(() => {
    // Touch file to create filesystem activity
    fs.writeFileSync("/tmp/.codespace-keepalive", Date.now().toString());
  }, 60000); // Every 60s
}

function stopKeepAlive() {
  if (!keepAliveInterval) return;
  
  console.log("⏸️  Stopping Codespace keep-alive");
  clearInterval(keepAliveInterval);
  keepAliveInterval = null;
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
  setupTerminalSocket(io, {
    onConnect: () => {
      activeTerminalConnections++;
      const codespaceInfo = getCodespaceInfo();
      if (codespaceInfo.isCodespaces && activeTerminalConnections === 1) {
        startKeepAlive();
      }
    },
    onDisconnect: () => {
      activeTerminalConnections--;
      if (activeTerminalConnections === 0) {
        stopKeepAlive();
      }
    },
    getCodespaceInfo
  });

  // Setup Remote Desktop namespace (/remote)
  setupRemoteSocket(io);

  return io;
}
