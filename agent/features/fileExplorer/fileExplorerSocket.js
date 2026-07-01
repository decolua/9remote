// File Explorer Socket.IO handler
import { setupFileHandlers } from "./handlers/FileHandler.js";
import { setupGitHandlers } from "./handlers/GitHandler.js";

// Per-socket file explorer handlers (called from the single connection handler).
export function setupFileExplorerHandlers(socket) {
  setupFileHandlers(socket);
  setupGitHandlers(socket);
}
