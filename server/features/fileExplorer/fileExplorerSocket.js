// File Explorer Socket.IO handler
import { setupFileHandlers } from "./handlers/FileHandler.js";
import { setupGitHandlers } from "./handlers/GitHandler.js";

export function setupFileExplorerSocket(io) {
  io.on("connection", (socket) => {
    setupFileHandlers(socket);
    setupGitHandlers(socket);
  });
}
