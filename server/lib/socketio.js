// Main Socket.IO setup
import { Server } from "socket.io";
import { setupTerminalSocket } from "../features/terminal/terminalSocket.js";
import { setupRemoteSocket, checkRemoteAvailable } from "../features/remote/remoteSocket.js";
import { setupFileExplorerSocket } from "../features/fileExplorer/fileExplorerSocket.js";

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

  // Setup File Explorer (uses default namespace)
  setupFileExplorerSocket(io);

  return io;
}
