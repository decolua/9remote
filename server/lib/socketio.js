// Main Socket.IO setup
import { Server } from "socket.io";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { setupTerminalSocket } from "../features/terminal/terminalSocket.js";
import { setupRemoteSocket, checkRemoteAvailable } from "../features/remote/remoteSocket.js";
import { setupFileExplorerSocket } from "../features/fileExplorer/fileExplorerSocket.js";

function loadApiKey() {
  try {
    const keysFile = join(homedir(), ".9remote", "keys.json");
    const data = JSON.parse(readFileSync(keysFile, "utf8"));
    return data.key || null;
  } catch {
    return null;
  }
}

let ioInstance = null;

export function getIO() {
  return ioInstance;
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
  setupRemoteSocket(io, loadApiKey());

  // Setup File Explorer (uses default namespace)
  setupFileExplorerSocket(io);

  ioInstance = io;
  return io;
}
