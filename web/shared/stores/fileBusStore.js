"use client";

import { create } from "zustand";
import { useConnectionStore } from "@/shared/stores/connectionStore";
import { normalizePathsResponse } from "@/features/fileExplorer/constants/fileExplorer.js";
import { uploadFiles as transferUpload, downloadFile as transferDownload, streamMedia as transferStream } from "@/features/fileExplorer/lib/fileTransfer.js";

const normResolve = (resolve) => (res) => {
  resolve(normalizePathsResponse(res));
};

const getBus = () => {
  const state = useConnectionStore.getState();
  if (!state.connected) return null;
  return state.busRef?.current || state.bus;
};
const getProtocol = () => useConnectionStore.getState().protocolRef;

export const useFileBusStore = create(() => ({
  getSystemInfo: () => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("getSystemInfo", resolve);
  }),

  getFiles: (dirPath, showHidden = false) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("getFiles", { dirPath, showHidden }, normResolve(resolve));
  }),

  readFile: (filePath) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("readFile", { filePath }, resolve);
  }),

  readImage: (filePath) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("readImage", { filePath }, resolve);
  }),

  readMedia: (filePath) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("readMedia", { filePath }, resolve);
  }),

  writeFile: (filePath, content) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("writeFile", { filePath, content }, resolve);
  }),

  createItem: (itemPath, type) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("createItem", { itemPath, type }, resolve);
  }),

  deleteItem: (itemPath) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("deleteItem", { itemPath }, resolve);
  }),

  renameItem: (oldPath, newPath) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("renameItem", { oldPath, newPath }, resolve);
  }),

  copyItem: (srcPath, destPath) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("copyItem", { srcPath, destPath }, resolve);
  }),

  gitStatus: (repoPath) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitStatus", { repoPath }, normResolve(resolve));
  }),

  gitChangedCount: (repoPath) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitChangedCount", { repoPath }, resolve);
  }),

  gitFileStatus: (repoPath, filePath) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitFileStatus", { repoPath, filePath }, normResolve(resolve));
  }),

  gitDiff: (repoPath, file, status) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitDiff", { repoPath, file, status }, resolve);
  }),

  gitShowMedia: (repoPath, file, ref = "HEAD") => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitShowMedia", { repoPath, file, ref }, resolve);
  }),

  searchFiles: (workspace, query) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("searchFiles", { workspace, query }, normResolve(resolve));
  }),

  gitDiscard: (repoPath, file, status) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitDiscard", { repoPath, file, status }, resolve);
  }),

  searchInFiles: (workspace, query, options = {}) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    const { caseSensitive = false, regex = false, includeGlob = "", excludeGlob = "" } = options;
    bus.emit("searchInFiles", { workspace, query, caseSensitive, regex, includeGlob, excludeGlob }, normResolve(resolve));
  }),

  replaceInFiles: (workspace, query, replacement, options = {}, files = []) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    const { caseSensitive = false, regex = false, includeGlob = "", excludeGlob = "" } = options;
    bus.emit("replaceInFiles", { workspace, query, replacement, caseSensitive, regex, includeGlob, excludeGlob, files }, resolve);
  }),

  watchDir: (dirPath) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("watchDir", { dirPath }, resolve);
  }),

  unwatchDir: (dirPath) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("unwatchDir", { dirPath }, resolve);
  }),

  onFileChange: (handler) => {
    const state = useConnectionStore.getState();
    const bus = state.busRef?.current || state.bus;
    if (!bus) return () => {};
    bus.on("fileChange", handler);
    return () => bus.off("fileChange", handler);
  },

  revealInOS: (filePath) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("revealInOS", { filePath }, resolve);
  }),

  openInTerminal: (dirPath) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("openInTerminal", { dirPath }, resolve);
  }),

  getFileTree: (dirPath, depth = 1, showHidden = false) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("getFileTree", { dirPath, depth, showHidden }, normResolve(resolve));
  }),

  gitBranch: (repoPath) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitBranch", { repoPath }, resolve);
  }),

  gitScanRepos: (rootPath, maxDepth) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitScanRepos", { rootPath, maxDepth }, resolve);
  }),

  gitWorkspaceChangedCount: (rootPath, maxDepth) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitWorkspaceChangedCount", { rootPath, maxDepth }, resolve);
  }),

  gitRefreshRepos: (rootPath) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitRefreshRepos", { rootPath }, resolve);
  }),

  gitWorktreeList: (repoPath) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitWorktreeList", { repoPath }, resolve);
  }),

  gitWorktreeAdd: (repoPath, worktreePath, branch, newBranch) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitWorktreeAdd", { repoPath, worktreePath, branch, newBranch }, resolve);
  }),

  gitWorktreeRemove: (repoPath, worktreePath, opts = {}) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitWorktreeRemove", { repoPath, worktreePath, ...opts }, resolve);
  }),

  gitBranchList: (repoPath) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitBranchList", { repoPath }, resolve);
  }),

  gitBranchCheckout: (repoPath, branch, create) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitBranchCheckout", { repoPath, branch, create }, resolve);
  }),

  gitAdd: (repoPath, files) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitAdd", { repoPath, files }, resolve);
  }),

  gitReset: (repoPath, files) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitReset", { repoPath, files }, resolve);
  }),

  gitCommit: (repoPath, message) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitCommit", { repoPath, message }, resolve);
  }),

  gitPush: (repoPath) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitPush", { repoPath }, resolve);
  }),

  gitPull: (repoPath) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitPull", { repoPath }, resolve);
  }),

  gitLog: (repoPath, limit = 50) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitLog", { repoPath, limit }, normResolve(resolve));
  }),

  uploadFiles: (targetDir, items, callbacks) => {
    const bus = getBus();
    if (!bus) {
      callbacks?.onError?.(null, new Error("Not connected"));
      return Promise.resolve();
    }
    return transferUpload({
      bus,
      protocolRef: getProtocol(),
      targetDir,
      items,
      callbacks
    });
  },

  downloadFile: (filePath, callbacks) => {
    const bus = getBus();
    if (!bus) {
      callbacks?.onError?.(new Error("Not connected"));
      return Promise.resolve();
    }
    return transferDownload({
      bus,
      protocolRef: getProtocol(),
      filePath,
      ...callbacks
    });
  },

  streamMedia: (filePath, callbacks) => {
    const bus = getBus();
    if (!bus) {
      callbacks?.onError?.(new Error("Not connected"));
      return { cancel: () => {} };
    }
    return transferStream({
      bus,
      filePath,
      ...callbacks
    });
  },

  previewStart: (filePath) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("preview:start", { filePath }, resolve);
  }),

  previewEnd: (sessionId) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false });
    bus.emit("preview:end", { sessionId }, resolve);
  })
}));
