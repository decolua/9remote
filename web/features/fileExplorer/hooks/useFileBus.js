"use client";

import { useCallback, useMemo } from "react";
import { normalizePathsResponse } from "../constants/fileExplorer.js";
import { uploadFiles as transferUpload, downloadFile as transferDownload, streamMedia as transferStream } from "../lib/fileTransfer.js";

// Wrap a bus callback so path fields in the response are normalized to POSIX
// (agent sends OS-native separators — \\ on Windows — which break web path helpers).
const normResolve = (resolve) => (res) => {
  resolve(normalizePathsResponse(res));
};

// File Explorer bus hook - uses existing bus from useSocket.
// protocolRef (optional) enables binary file transfer over the FILE channel.
export function useFileBus(busRef, protocolRef) {
  // Get system info (OS, drives)
  const getSystemInfo = useCallback(() => {
    return new Promise((resolve) => {
      if (!busRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      busRef.current.emit("getSystemInfo", resolve);
    });
  }, [busRef]);

  // Get files in directory
  const getFiles = useCallback((dirPath, showHidden = false) => {
    return new Promise((resolve) => {
      if (!busRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      busRef.current.emit("getFiles", { dirPath, showHidden }, normResolve(resolve));
    });
  }, [busRef]);

  // Read file content
  const readFile = useCallback((filePath) => {
    return new Promise((resolve) => {
      if (!busRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      busRef.current.emit("readFile", { filePath }, resolve);
    });
  }, [busRef]);

  // Read image as data URL
  const readImage = useCallback((filePath) => {
    return new Promise((resolve) => {
      if (!busRef?.current) { resolve({ success: false, error: "Not connected" }); return; }
      busRef.current.emit("readImage", { filePath }, resolve);
    });
  }, [busRef]);

  // Read any previewable media (image/video/audio/pdf) as a data URL
  const readMedia = useCallback((filePath) => {
    return new Promise((resolve) => {
      if (!busRef?.current) { resolve({ success: false, error: "Not connected" }); return; }
      busRef.current.emit("readMedia", { filePath }, resolve);
    });
  }, [busRef]);

  // Write file content
  const writeFile = useCallback((filePath, content) => {
    return new Promise((resolve) => {
      if (!busRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      busRef.current.emit("writeFile", { filePath, content }, resolve);
    });
  }, [busRef]);

  // Create file or folder
  const createItem = useCallback((itemPath, type) => {
    return new Promise((resolve) => {
      if (!busRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      busRef.current.emit("createItem", { itemPath, type }, resolve);
    });
  }, [busRef]);

  // Delete file or folder
  const deleteItem = useCallback((itemPath) => {
    return new Promise((resolve) => {
      if (!busRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      busRef.current.emit("deleteItem", { itemPath }, resolve);
    });
  }, [busRef]);

  // Rename file or folder
  const renameItem = useCallback((oldPath, newPath) => {
    return new Promise((resolve) => {
      if (!busRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      busRef.current.emit("renameItem", { oldPath, newPath }, resolve);
    });
  }, [busRef]);

  const copyItem = useCallback((srcPath, destPath) => {
    return new Promise((resolve) => {
      if (!busRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      busRef.current.emit("copyItem", { srcPath, destPath }, resolve);
    });
  }, [busRef]);

  // Git status
  const gitStatus = useCallback((repoPath) => {
    return new Promise((resolve) => {
      if (!busRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      busRef.current.emit("gitStatus", { repoPath }, normResolve(resolve));
    });
  }, [busRef]);

  // Git changed-file count only (badge) - avoids transferring the full file list
  const gitChangedCount = useCallback((repoPath) => {
    return new Promise((resolve) => {
      if (!busRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      busRef.current.emit("gitChangedCount", { repoPath }, resolve);
    });
  }, [busRef]);

  // Git file status - check single file
  const gitFileStatus = useCallback((repoPath, filePath) => {
    return new Promise((resolve) => {
      if (!busRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      busRef.current.emit("gitFileStatus", { repoPath, filePath }, normResolve(resolve));
    });
  }, [busRef]);

  // Git diff
  const gitDiff = useCallback((repoPath, file, status) => {
    return new Promise((resolve) => {
      if (!busRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      busRef.current.emit("gitDiff", { repoPath, file, status }, resolve);
    });
  }, [busRef]);

  // Git show media (HEAD version of an image or media file)
  const gitShowMedia = useCallback((repoPath, file, ref = "HEAD") => {
    return new Promise((resolve) => {
      if (!busRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      busRef.current.emit("gitShowMedia", { repoPath, file, ref }, resolve);
    });
  }, [busRef]);

  // Search files
  const searchFiles = useCallback((workspace, query) => {
    return new Promise((resolve) => {
      if (!busRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      busRef.current.emit("searchFiles", { workspace, query }, normResolve(resolve));
    });
  }, [busRef]);

  // Git discard changes
  const gitDiscard = useCallback((repoPath, file, status) => {
    return new Promise((resolve) => {
      if (!busRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      busRef.current.emit("gitDiscard", { repoPath, file, status }, resolve);
    });
  }, [busRef]);

  const searchInFiles = useCallback((workspace, query, options = {}) => {
    return new Promise((resolve) => {
      if (!busRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      const {
        caseSensitive = false,
        regex = false,
        includeGlob = "",
        excludeGlob = ""
      } = options;
      busRef.current.emit(
        "searchInFiles",
        { workspace, query, caseSensitive, regex, includeGlob, excludeGlob },
        normResolve(resolve)
      );
    });
  }, [busRef]);

  const replaceInFiles = useCallback((workspace, query, replacement, options = {}, files = []) => {
    return new Promise((resolve) => {
      if (!busRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      const {
        caseSensitive = false,
        regex = false,
        includeGlob = "",
        excludeGlob = ""
      } = options;
      busRef.current.emit(
        "replaceInFiles",
        { workspace, query, replacement, caseSensitive, regex, includeGlob, excludeGlob, files },
        resolve
      );
    });
  }, [busRef]);

  const watchDir = useCallback((dirPath) => {
    return new Promise((resolve) => {
      if (!busRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      busRef.current.emit("watchDir", { dirPath }, resolve);
    });
  }, [busRef]);

  const unwatchDir = useCallback((dirPath) => {
    return new Promise((resolve) => {
      if (!busRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      busRef.current.emit("unwatchDir", { dirPath }, resolve);
    });
  }, [busRef]);

  // Subscribe to the agent's watcher stream. Returns an unsubscribe function; the bus
  // instance is read at call time so a reconnect re-subscribes on the live bus.
  const onFileChange = useCallback((handler) => {
    const bus = busRef?.current;
    if (!bus) return () => {};
    bus.on("fileChange", handler);
    return () => bus.off("fileChange", handler);
  }, [busRef]);

  const revealInOS = useCallback((filePath) => {
    return new Promise((resolve) => {
      if (!busRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      busRef.current.emit("revealInOS", { filePath }, resolve);
    });
  }, [busRef]);

  const openInTerminal = useCallback((dirPath) => {
    return new Promise((resolve) => {
      if (!busRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      busRef.current.emit("openInTerminal", { dirPath }, resolve);
    });
  }, [busRef]);

  const getFileTree = useCallback((dirPath, depth = 1, showHidden = false) => {
    return new Promise((resolve) => {
      if (!busRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      busRef.current.emit("getFileTree", { dirPath, depth, showHidden }, normResolve(resolve));
    });
  }, [busRef]);

  const gitBranch = useCallback((repoPath) => {
    return new Promise((resolve) => {
      if (!busRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      busRef.current.emit("gitBranch", { repoPath }, resolve);
    });
  }, [busRef]);

  // Workspace-level git: nested repos, worktrees, branches
  const emitGit = useCallback((event, payload) => {
    return new Promise((resolve) => {
      if (!busRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      busRef.current.emit(event, payload, resolve);
    });
  }, [busRef]);

  const gitScanRepos = useCallback((rootPath, maxDepth) => emitGit("gitScanRepos", { rootPath, maxDepth }), [emitGit]);
  const gitWorkspaceChangedCount = useCallback((rootPath, maxDepth) => emitGit("gitWorkspaceChangedCount", { rootPath, maxDepth }), [emitGit]);
  const gitRefreshRepos = useCallback((rootPath) => emitGit("gitRefreshRepos", { rootPath }), [emitGit]);
  const gitWorktreeList = useCallback((repoPath) => emitGit("gitWorktreeList", { repoPath }), [emitGit]);
  const gitWorktreeAdd = useCallback((repoPath, worktreePath, branch, newBranch) => emitGit("gitWorktreeAdd", { repoPath, worktreePath, branch, newBranch }), [emitGit]);
  const gitWorktreeRemove = useCallback((repoPath, worktreePath, opts = {}) => emitGit("gitWorktreeRemove", { repoPath, worktreePath, ...opts }), [emitGit]);
  const gitBranchList = useCallback((repoPath) => emitGit("gitBranchList", { repoPath }), [emitGit]);
  const gitBranchCheckout = useCallback((repoPath, branch, create) => emitGit("gitBranchCheckout", { repoPath, branch, create }), [emitGit]);

  const gitAdd = useCallback((repoPath, files) => {
    return new Promise((resolve) => {
      if (!busRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      busRef.current.emit("gitAdd", { repoPath, files }, resolve);
    });
  }, [busRef]);

  const gitReset = useCallback((repoPath, files) => {
    return new Promise((resolve) => {
      if (!busRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      busRef.current.emit("gitReset", { repoPath, files }, resolve);
    });
  }, [busRef]);

  const gitCommit = useCallback((repoPath, message) => {
    return new Promise((resolve) => {
      if (!busRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      busRef.current.emit("gitCommit", { repoPath, message }, resolve);
    });
  }, [busRef]);

  const gitPush = useCallback((repoPath) => {
    return new Promise((resolve) => {
      if (!busRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      busRef.current.emit("gitPush", { repoPath }, resolve);
    });
  }, [busRef]);

  const gitPull = useCallback((repoPath) => {
    return new Promise((resolve) => {
      if (!busRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      busRef.current.emit("gitPull", { repoPath }, resolve);
    });
  }, [busRef]);

  const gitLog = useCallback((repoPath, limit = 50) => {
    return new Promise((resolve) => {
      if (!busRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      busRef.current.emit("gitLog", { repoPath, limit }, normResolve(resolve));
    });
  }, [busRef]);

  // Copy files/folders from client into a target dir on the agent (OS-like:
  // byte-identical, preserves structure + mtime, asks Skip/Replace on conflict).
  const uploadFiles = useCallback((targetDir, items, callbacks) => {
    return transferUpload({
      bus: busRef?.current,
      protocolRef,
      targetDir,
      items,
      callbacks
    });
  }, [busRef, protocolRef]);

  // Download a file from the agent into a client-side Blob.
  const downloadFile = useCallback((filePath, callbacks) => {
    return transferDownload({
      bus: busRef?.current,
      protocolRef,
      filePath,
      ...callbacks
    });
  }, [busRef, protocolRef]);

  // Stream media for progressive playback (MSE). Returns a cancel() fn.
  const streamMedia = useCallback((filePath, callbacks) => {
    return transferStream({
      bus: busRef?.current,
      filePath,
      ...callbacks
    });
  }, [busRef, protocolRef]);

  // HTML preview: mint/end a static-serving session on the agent's HTTP server.
  const previewStart = useCallback((filePath) => {
    return new Promise((resolve) => {
      if (!busRef?.current) { resolve({ success: false, error: "Not connected" }); return; }
      busRef.current.emit("preview:start", { filePath }, resolve);
    });
  }, [busRef]);

  const previewEnd = useCallback((sessionId) => {
    return new Promise((resolve) => {
      if (!busRef?.current) { resolve({ success: false }); return; }
      busRef.current.emit("preview:end", { sessionId }, resolve);
    });
  }, [busRef]);

  // Memoize the returned object so the ref stays stable across renders.
  // Without this, consumers' effects keyed on `fileBus` re-run every render
  // (e.g. TerminalPane re-runs git/watch setup on every keystroke → agent git spawn storm).
  return useMemo(() => ({
    getSystemInfo,
    getFiles,
    readFile,
    readImage,
    readMedia,
    writeFile,
    createItem,
    deleteItem,
    renameItem,
    copyItem,
    gitStatus,
    gitChangedCount,
    gitFileStatus,
    gitDiff,
    gitShowMedia,
    gitDiscard,
    searchFiles,
    searchInFiles,
    replaceInFiles,
    watchDir,
    unwatchDir,
    onFileChange,
    revealInOS,
    openInTerminal,
    getFileTree,
    gitBranch,
    gitScanRepos,
    gitWorkspaceChangedCount,
    gitRefreshRepos,
    gitWorktreeList,
    gitWorktreeAdd,
    gitWorktreeRemove,
    gitBranchList,
    gitBranchCheckout,
    gitAdd,
    gitReset,
    gitCommit,
    gitPush,
    gitPull,
    gitLog,
    uploadFiles,
    downloadFile,
    streamMedia,
    previewStart,
    previewEnd
  }), [getSystemInfo, getFiles, readFile, readImage, readMedia, writeFile, createItem, deleteItem,
    renameItem, copyItem, gitStatus, gitChangedCount, gitFileStatus, gitDiff, gitShowMedia, gitDiscard, searchFiles,
    searchInFiles, replaceInFiles, watchDir, unwatchDir, onFileChange, revealInOS, openInTerminal,
    getFileTree, gitBranch, gitScanRepos, gitWorkspaceChangedCount, gitRefreshRepos, gitWorktreeList, gitWorktreeAdd,
    gitWorktreeRemove, gitBranchList, gitBranchCheckout, gitAdd, gitReset, gitCommit, gitPush, gitPull, gitLog,
    uploadFiles, downloadFile, streamMedia, previewStart, previewEnd]);
}
