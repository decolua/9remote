import { getSocket } from "../terminalSocket";

// File explorer + git socket wrapper. Mirrors web useFileSocket but uses the
// local agent socket singleton (no ref indirection — local UI is always connected).
function emit(socket, name, payload) {
  return new Promise((resolve) => {
    if (!socket) { resolve({ success: false, error: "Not connected" }); return; }
    socket.emit(name, payload, resolve);
  });
}

export function useFileSocket() {
  const socket = getSocket();
  return {
    getSystemInfo: () => emit(socket, "getSystemInfo", {}),
    getFiles: (dirPath, showHidden = false) => emit(socket, "getFiles", { dirPath, showHidden }),
    readFile: (filePath) => emit(socket, "readFile", { filePath }),
    readImage: (filePath) => emit(socket, "readImage", { filePath }),
    writeFile: (filePath, content) => emit(socket, "writeFile", { filePath, content }),
    createItem: (itemPath, type) => emit(socket, "createItem", { itemPath, type }),
    deleteItem: (itemPath) => emit(socket, "deleteItem", { itemPath }),
    renameItem: (oldPath, newPath) => emit(socket, "renameItem", { oldPath, newPath }),
    gitStatus: (repoPath) => emit(socket, "gitStatus", { repoPath }),
    gitChangedCount: (repoPath) => emit(socket, "gitChangedCount", { repoPath }),
    gitFileStatus: (repoPath, filePath) => emit(socket, "gitFileStatus", { repoPath, filePath }),
    gitDiff: (repoPath, file, status) => emit(socket, "gitDiff", { repoPath, file, status }),
    gitDiscard: (repoPath, file, status) => emit(socket, "gitDiscard", { repoPath, file, status }),
    searchFiles: (workspace, query) => emit(socket, "searchFiles", { workspace, query }),
    searchInFiles: (workspace, query, options = {}) => emit(socket, "searchInFiles", { workspace, query, caseSensitive: options.caseSensitive || false, regex: options.regex || false, includeGlob: options.includeGlob || "", excludeGlob: options.excludeGlob || "" }),
    replaceInFiles: (workspace, query, replacement, options = {}, files = []) => emit(socket, "replaceInFiles", { workspace, query, replacement, caseSensitive: options.caseSensitive || false, regex: options.regex || false, includeGlob: options.includeGlob || "", excludeGlob: options.excludeGlob || "", files }),
    watchDir: (dirPath) => emit(socket, "watchDir", { dirPath }),
    unwatchDir: (dirPath) => emit(socket, "unwatchDir", { dirPath }),
    revealInOS: (filePath) => emit(socket, "revealInOS", { filePath }),
    openInTerminal: (dirPath) => emit(socket, "openInTerminal", { dirPath }),
    getFileTree: (dirPath, depth = 1, showHidden = false) => emit(socket, "getFileTree", { dirPath, depth, showHidden }),
    gitBranch: (repoPath) => emit(socket, "gitBranch", { repoPath }),
    gitAdd: (repoPath, files) => emit(socket, "gitAdd", { repoPath, files }),
    gitReset: (repoPath, files) => emit(socket, "gitReset", { repoPath, files }),
    gitCommit: (repoPath, message) => emit(socket, "gitCommit", { repoPath, message }),
    gitPush: (repoPath) => emit(socket, "gitPush", { repoPath }),
    gitPull: (repoPath) => emit(socket, "gitPull", { repoPath }),
    gitLog: (repoPath, limit = 50) => emit(socket, "gitLog", { repoPath, limit }),
  };
}
