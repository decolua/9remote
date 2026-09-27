// File Explorer Socket.IO handler
import { setupFileHandlers } from "./handlers/FileHandler.js";
import { setupGitHandlers } from "./handlers/GitHandler.js";
import { TransferManager } from "./transfer/TransferManager.js";
import { setupPreviewHandlers } from "./previewServer.js";

// Per-socket file explorer handlers (called from the single connection handler).
export function setupFileExplorerHandlers(socket) {
  setupFileHandlers(socket);
  setupGitHandlers(socket);
  setupPreviewHandlers(socket);
  setupTransferHandlers(socket);
}

// File copy/transfer (upload + download) over the FILE channel.
function setupTransferHandlers(socket) {
  const tx = new TransferManager(socket);
  socket.data.transfer = tx;

  socket.on("upload:start", (payload, cb) => tx.startUpload(payload, cb));
  socket.on("upload:end", (payload, cb) => tx.endUpload(payload, cb));
  socket.on("upload:cancel", (payload, cb) => tx.cancelUpload(payload, cb));
  socket.on("download:start", (payload, cb) => tx.startDownload(payload, cb));
  socket.on("streamMedia:start", (payload, cb) => tx.startStreamMedia(payload, cb));
  socket.on("download:cancel", (payload, cb) => tx.cancelDownload(payload, cb));

  // Binary frames arrive here from BOTH transports: WS via socket.io onAny,
  // RTC via ProtocolManager._onBinary routing.
  socket.on("file-bin", (buffer) => tx.handleBinary(buffer));

  socket.once("disconnect", () => tx.cleanup());
}
