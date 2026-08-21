"use client";

import { useState, useCallback, useEffect, useRef } from "react";
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
  // Batches can overlap (a second drop while the first is still uploading), and
  // they share one progress slot: without a stamp the older batch's completion
  // would clear the newer batch's UI, and its progress events would fight for
  // the same bar. Only the newest batch may write.
  const uploadSeqRef = useRef(0);
  const startUpload = useCallback(async (items) => {
    if (!items.length || !fileSocket.uploadFiles) return;
    const seq = ++uploadSeqRef.current;
    const isCurrent = () => seq === uploadSeqRef.current;
    setTransfer({ total: items.length, done: 0, current: items[0]?.file?.name || "", ratio: 0 });
    await fileSocket.uploadFiles(currentPath, items, {
      onConflict: ({ file }, relativePath) => new Promise((resolve) => {
        setConflict({ name: relativePath || file.name, resolve });
      }),
      onProgress: (file, ratio) => { if (isCurrent()) setTransfer((p) => p ? { ...p, current: file.name, ratio } : p); },
      onFileDone: (file) => { if (isCurrent()) setTransfer((p) => p ? { ...p, done: p.done + 1 } : p); }
    });
    if (isCurrent()) setTransfer(null);
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
  // Same single-slot problem as uploads: a second download started while one is
  // running would share the progress bar, and whichever finished first would
  // clear it for both.
  const downloadSeqRef = useRef(0);
  const handleDownload = useCallback((file) => {
    if (!fileSocket.downloadFile) return;
    const seq = ++downloadSeqRef.current;
    const isCurrent = () => seq === downloadSeqRef.current;
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
        if (isCurrent()) setDownloadState(null);
      },
      onProgress: (ratio) => { if (isCurrent()) setDownloadState((p) => p ? { ...p, ratio } : p); },
      onError: (e) => { onError?.(e.message || "Download failed"); if (isCurrent()) setDownloadState(null); }
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
