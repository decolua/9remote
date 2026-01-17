// Main Socket.IO setup
import { Server } from "socket.io";
import { setupTerminalSocket } from "../../features/terminal/services/terminalSocket.js";
import { setupRemoteSocket } from "../../features/remote/services/remoteSocket.js";

export function setupSocketIO(server) {
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

  // Setup Terminal namespace (default)
  setupTerminalSocket(io);

  // Setup Remote Desktop namespace (/remote)
  setupRemoteSocket(io);

  return io;
}
