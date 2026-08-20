"use client";

import { useState, useCallback, useEffect } from "react";
import { dataTransferToItems } from "@/features/fileExplorer/lib/dataTransfer";
import { vibrate } from "@/shared/utils/vibration";

// Upload (drop / paste) and download plumbing for the mobile explorer: progress
// state, the overwrite prompt, and drag-over highlighting.
// Extracted verbatim from FileExplorer.
export function useFileTransfer({ fileSocket, currentPath, isBrowsing, onDone, onError }) {
  const [transfer, setTransfer] = useState(null);      // { total, done, current, ratio }
  const [dragOver, setDragOver] = useState(false);
  const [conflict, setConflict] = useState(null);      // { name, resolve }
  const [downloadState, setDownloadState] = useState(null); // { name, ratio }

  // Kick off an upload batch into the current directory.
  const startUpload = useCallback(async (items) => {
    if (!items.length || !fileSocket.uploadFiles) return;
    setTransfer({ total: items.length, done: 0, current: items[0]?.file?.name || "", ratio: 0 });
    await fileSocket.uploadFiles(currentPath, items, {
      onConflict: ({ file }, relativePath) => new Promise((resolve) => {
        setConflict({ name: relativePath || file.name, resolve });
      }),
      onProgress: (file, ratio) => setTransfer((p) => p ? { ...p, current: file.name, ratio } : p),
      onFileDone: (file) => setTransfer((p) => p ? { ...p, done: p.done + 1 } : p)
    });
    setTransfer(null);
    onDone?.(currentPath);
  }, [fileSocket, currentPath, onDone]);

  const handleDrop = useCallback(async (e) => {
    e.preventDefault();
    setDragOver(false);
    if (isBrowsing) return;
    const items = await dataTransferToItems(e.dataTransfer);
    if (items.length) { vibrate(); startUpload(items); }
  }, [isBrowsing, startUpload]);

  const handleDragOver = useCallback((e) => { e.preventDefault(); if (!isBrowsing) setDragOver(true); }, [isBrowsing]);
  const handleDragLeave = useCallback((e) => { e.preventDefault(); setDragOver(false); }, []);

  // Paste files from OS clipboard (folders aren't exposed via clipboard — files only).
  useEffect(() => {
    if (isBrowsing) return;
    const onPaste = async (e) => {
      const files = Array.from(e.clipboardData?.files || []);
      if (!files.length) return;
      const items = files.map((f) => ({ file: f, relativePath: f.name }));
      vibrate();
      startUpload(items);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [isBrowsing, startUpload]);

  // Trigger a browser save for a file or folder (folder arrives as .zip).
  const handleDownload = useCallback((file) => {
    if (!fileSocket.downloadFile) return;
    setDownloadState({ name: file.name, ratio: 0 });
    fileSocket.downloadFile(file.path, {
      onSave: (blob, meta) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = meta?.fileName || file.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(a.href);
        setDownloadState(null);
      },
      onProgress: (ratio) => setDownloadState((p) => p ? { ...p, ratio } : p),
      onError: (e) => { onError?.(e.message || "Download failed"); setDownloadState(null); }
    });
  }, [fileSocket, onError]);

  // Mirrors the original inline handler: resolve THEN clear, never inside an
  // updater (StrictMode would double-invoke it and answer the prompt twice).
  const resolveConflict = useCallback((choice) => {
    conflict?.resolve(choice);
    setConflict(null);
  }, [conflict]);

  return {
    transfer, dragOver, conflict, downloadState,
    startUpload, handleDrop, handleDragOver, handleDragLeave, handleDownload, resolveConflict
  };
}
