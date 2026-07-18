"use client";

import { useCallback, useMemo } from "react";

// File Explorer socket hook - uses existing socket from useSocket
export function useFileSocket(socketRef) {
  // Get system info (OS, drives)
  const getSystemInfo = useCallback(() => {
    return new Promise((resolve) => {
      if (!socketRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      socketRef.current.emit("getSystemInfo", resolve);
    });
  }, [socketRef]);

  // Get files in directory
  const getFiles = useCallback((dirPath, showHidden = false) => {
    return new Promise((resolve) => {
      if (!socketRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      socketRef.current.emit("getFiles", { dirPath, showHidden }, resolve);
    });
  }, [socketRef]);

  // Read file content
  const readFile = useCallback((filePath) => {
    return new Promise((resolve) => {
      if (!socketRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      socketRef.current.emit("readFile", { filePath }, resolve);
    });
  }, [socketRef]);

  // Read image as data URL
  const readImage = useCallback((filePath) => {
    return new Promise((resolve) => {
      if (!socketRef?.current) { resolve({ success: false, error: "Not connected" }); return; }
      socketRef.current.emit("readImage", { filePath }, resolve);
    });
  }, [socketRef]);

  // Read any previewable media (image/video/audio/pdf) as a data URL
  const readMedia = useCallback((filePath) => {
    return new Promise((resolve) => {
      if (!socketRef?.current) { resolve({ success: false, error: "Not connected" }); return; }
      socketRef.current.emit("readMedia", { filePath }, resolve);
    });
  }, [socketRef]);

  // Write file content
  const writeFile = useCallback((filePath, content) => {
    return new Promise((resolve) => {
      if (!socketRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      socketRef.current.emit("writeFile", { filePath, content }, resolve);
    });
  }, [socketRef]);

  // Create file or folder
  const createItem = useCallback((itemPath, type) => {
    return new Promise((resolve) => {
      if (!socketRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      socketRef.current.emit("createItem", { itemPath, type }, resolve);
    });
  }, [socketRef]);

  // Delete file or folder
  const deleteItem = useCallback((itemPath) => {
    return new Promise((resolve) => {
      if (!socketRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      socketRef.current.emit("deleteItem", { itemPath }, resolve);
    });
  }, [socketRef]);

  // Rename file or folder
  const renameItem = useCallback((oldPath, newPath) => {
    return new Promise((resolve) => {
      if (!socketRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      socketRef.current.emit("renameItem", { oldPath, newPath }, resolve);
    });
  }, [socketRef]);

  // Git status
  const gitStatus = useCallback((repoPath) => {
    return new Promise((resolve) => {
      if (!socketRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      socketRef.current.emit("gitStatus", { repoPath }, resolve);
    });
  }, [socketRef]);

  // Git changed-file count only (badge) - avoids transferring the full file list
  const gitChangedCount = useCallback((repoPath) => {
    return new Promise((resolve) => {
      if (!socketRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      socketRef.current.emit("gitChangedCount", { repoPath }, resolve);
    });
  }, [socketRef]);

  // Git file status - check single file
  const gitFileStatus = useCallback((repoPath, filePath) => {
    return new Promise((resolve) => {
      if (!socketRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      socketRef.current.emit("gitFileStatus", { repoPath, filePath }, resolve);
    });
  }, [socketRef]);

  // Git diff
  const gitDiff = useCallback((repoPath, file, status) => {
    return new Promise((resolve) => {
      if (!socketRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      socketRef.current.emit("gitDiff", { repoPath, file, status }, resolve);
    });
  }, [socketRef]);

  // Search files
  const searchFiles = useCallback((workspace, query) => {
    return new Promise((resolve) => {
      if (!socketRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      socketRef.current.emit("searchFiles", { workspace, query }, resolve);
    });
  }, [socketRef]);

  // Git discard changes
  const gitDiscard = useCallback((repoPath, file, status) => {
    return new Promise((resolve) => {
      if (!socketRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      socketRef.current.emit("gitDiscard", { repoPath, file, status }, resolve);
    });
  }, [socketRef]);

  const searchInFiles = useCallback((workspace, query, options = {}) => {
    return new Promise((resolve) => {
      if (!socketRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      const {
        caseSensitive = false,
        regex = false,
        includeGlob = "",
        excludeGlob = ""
      } = options;
      socketRef.current.emit(
        "searchInFiles",
        { workspace, query, caseSensitive, regex, includeGlob, excludeGlob },
        resolve
      );
    });
  }, [socketRef]);

  const replaceInFiles = useCallback((workspace, query, replacement, options = {}, files = []) => {
    return new Promise((resolve) => {
      if (!socketRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      const {
        caseSensitive = false,
        regex = false,
        includeGlob = "",
        excludeGlob = ""
      } = options;
      socketRef.current.emit(
        "replaceInFiles",
        { workspace, query, replacement, caseSensitive, regex, includeGlob, excludeGlob, files },
        resolve
      );
    });
  }, [socketRef]);

  const watchDir = useCallback((dirPath) => {
    return new Promise((resolve) => {
      if (!socketRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      socketRef.current.emit("watchDir", { dirPath }, resolve);
    });
  }, [socketRef]);

  const unwatchDir = useCallback((dirPath) => {
    return new Promise((resolve) => {
      if (!socketRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      socketRef.current.emit("unwatchDir", { dirPath }, resolve);
    });
  }, [socketRef]);

  const revealInOS = useCallback((filePath) => {
    return new Promise((resolve) => {
      if (!socketRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      socketRef.current.emit("revealInOS", { filePath }, resolve);
    });
  }, [socketRef]);

  const openInTerminal = useCallback((dirPath) => {
    return new Promise((resolve) => {
      if (!socketRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      socketRef.current.emit("openInTerminal", { dirPath }, resolve);
    });
  }, [socketRef]);

  const getFileTree = useCallback((dirPath, depth = 1, showHidden = false) => {
    return new Promise((resolve) => {
      if (!socketRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      socketRef.current.emit("getFileTree", { dirPath, depth, showHidden }, resolve);
    });
  }, [socketRef]);

  const gitBranch = useCallback((repoPath) => {
    return new Promise((resolve) => {
      if (!socketRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      socketRef.current.emit("gitBranch", { repoPath }, resolve);
    });
  }, [socketRef]);

  const gitAdd = useCallback((repoPath, files) => {
    return new Promise((resolve) => {
      if (!socketRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      socketRef.current.emit("gitAdd", { repoPath, files }, resolve);
    });
  }, [socketRef]);

  const gitReset = useCallback((repoPath, files) => {
    return new Promise((resolve) => {
      if (!socketRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      socketRef.current.emit("gitReset", { repoPath, files }, resolve);
    });
  }, [socketRef]);

  const gitCommit = useCallback((repoPath, message) => {
    return new Promise((resolve) => {
      if (!socketRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      socketRef.current.emit("gitCommit", { repoPath, message }, resolve);
    });
  }, [socketRef]);

  const gitPush = useCallback((repoPath) => {
    return new Promise((resolve) => {
      if (!socketRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      socketRef.current.emit("gitPush", { repoPath }, resolve);
    });
  }, [socketRef]);

  const gitPull = useCallback((repoPath) => {
    return new Promise((resolve) => {
      if (!socketRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      socketRef.current.emit("gitPull", { repoPath }, resolve);
    });
  }, [socketRef]);

  const gitLog = useCallback((repoPath, limit = 50) => {
    return new Promise((resolve) => {
      if (!socketRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      socketRef.current.emit("gitLog", { repoPath, limit }, resolve);
    });
  }, [socketRef]);

  // Memoize the returned object so the ref stays stable across renders.
  // Without this, consumers' effects keyed on `fileSocket` re-run every render
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
    gitStatus,
    gitChangedCount,
    gitFileStatus,
    gitDiff,
    gitDiscard,
    searchFiles,
    searchInFiles,
    replaceInFiles,
    watchDir,
    unwatchDir,
    revealInOS,
    openInTerminal,
    getFileTree,
    gitBranch,
    gitAdd,
    gitReset,
    gitCommit,
    gitPush,
    gitPull,
    gitLog
  }), [getSystemInfo, getFiles, readFile, readImage, readMedia, writeFile, createItem, deleteItem,
    renameItem, gitStatus, gitChangedCount, gitFileStatus, gitDiff, gitDiscard, searchFiles,
    searchInFiles, replaceInFiles, watchDir, unwatchDir, revealInOS, openInTerminal,
    getFileTree, gitBranch, gitAdd, gitReset, gitCommit, gitPush, gitPull, gitLog]);
}
