"use client";

import { useCallback } from "react";

// File Explorer socket hook - uses existing socket from useSocket
export function useFileSocket(socketRef) {
  // Get files in directory
  const getFiles = useCallback((dirPath) => {
    return new Promise((resolve) => {
      if (!socketRef?.current) {
        resolve({ success: false, error: "Not connected" });
        return;
      }
      socketRef.current.emit("getFiles", { dirPath }, resolve);
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

  return {
    getFiles,
    readFile,
    writeFile,
    createItem,
    deleteItem,
    renameItem,
    gitStatus,
    gitDiff,
    gitDiscard,
    searchFiles
  };
}
