"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FolderOpen } from "@/shared/components/ui/Icon";
import EditorTabs from "./EditorTabs.js";
import Breadcrumbs from "./Breadcrumbs.js";
import EditorPane from "./EditorPane.js";
import UnsavedDialog from "./UnsavedDialog.js";

export default function EditorArea({
  workspace,
  fileSocket,
  openedFiles,
  activeFile,
  onActivateFile,
  onCloseFile,
  onCloseOthers,
  onCloseAll,
  onOpenFile,
  onEditorStateChange
}) {
  const [dirtyFiles, setDirtyFiles] = useState(() => new Set());
  // Path awaiting an answer about its unsaved edits. Held here rather than in the pane:
  // the tab strip is what initiates a close, and this is where the dirty set lives.
  const [confirming, setConfirming] = useState(null);
  // Save handlers by path, published by each pane — the tab strip can then save a file
  // whose editor is not the visible one.
  const saversRef = useRef(new Map());

  // Closing the browser tab bypasses every in-app close path, so it is guarded here.
  useEffect(() => {
    if (!dirtyFiles.size || typeof window === "undefined") return;
    const onBeforeUnload = (e) => {
      e.preventDefault();
      // Browsers show their own wording; returning a value is what triggers the prompt.
      e.returnValue = "";
      return "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirtyFiles.size]);

  const handleDirtyChange = useCallback((path, isDirty) => {
    setDirtyFiles((prev) => {
      if (prev.has(path) === isDirty) return prev;
      const next = new Set(prev);
      if (isDirty) next.add(path); else next.delete(path);
      return next;
    });
  }, []);

  const registerSaver = useCallback((path, save) => {
    if (save) saversRef.current.set(path, save);
    else saversRef.current.delete(path);
  }, []);

  const requestClose = useCallback((path) => {
    if (!dirtyFiles.has(path)) return onCloseFile?.(path);
    setConfirming(path);
  }, [dirtyFiles, onCloseFile]);

  // Close-others and close-all can take unsaved files with them, so they save first
  // rather than ask once per file — a dialog per tab would be worse than the loss it
  // prevents. Anything that fails to write keeps its tab open.
  const closeMany = useCallback(async (keepPath) => {
    const doomed = openedFiles.filter((p) => p !== keepPath && dirtyFiles.has(p));
    for (const path of doomed) {
      const ok = await saversRef.current.get(path)?.();
      if (ok === false) return;
    }
    if (keepPath) onCloseOthers?.(keepPath);
    else onCloseAll?.();
  }, [openedFiles, dirtyFiles, onCloseOthers, onCloseAll]);

  const saveThenClose = useCallback(async () => {
    const path = confirming;
    const ok = await saversRef.current.get(path)?.();
    // A failed write keeps the dialog open — closing now would discard the very edits
    // the save was meant to keep.
    if (ok === false) return;
    setConfirming(null);
    onCloseFile?.(path);
  }, [confirming, onCloseFile]);

  const discardAndClose = useCallback(() => {
    const path = confirming;
    setConfirming(null);
    onCloseFile?.(path);
  }, [confirming, onCloseFile]);

  if (!activeFile) {
    return (
      <div className="flex-1 flex flex-col bg-bg min-h-0">
        <div className="flex-1 flex flex-col items-center justify-center text-text-muted gap-3 p-6">
          <FolderOpen size={64} className="opacity-40" />
          <div className="text-sm">Open a file from the Explorer to get started</div>
          <div className="text-xs flex items-center gap-2">
            <kbd className="px-2 py-0.5 bg-surface-2 border border-border rounded text-text-subtle font-mono">
              Cmd/Ctrl+P
            </kbd>
            <span>Quick Open</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-bg min-h-0">
      <EditorTabs
        openedFiles={openedFiles}
        activeFile={activeFile}
        dirtyFiles={dirtyFiles}
        onActivate={onActivateFile}
        onClose={requestClose}
        onCloseOthers={(path) => closeMany(path)}
        onCloseAll={() => closeMany(null)}
      />
      <Breadcrumbs workspace={workspace} filePath={activeFile} />
      <div className="flex-1 min-h-0 overflow-hidden">
        {openedFiles.map((path) => (
          <div key={path} className={path === activeFile ? "h-full" : "hidden"}>
            <EditorPane
              filePath={path}
              workspace={workspace}
              fileSocket={fileSocket}
              isActive={path === activeFile}
              onCursorChange={onEditorStateChange}
              onDirtyChange={handleDirtyChange}
              onRegisterSaver={registerSaver}
            />
          </div>
        ))}
      </div>

      <UnsavedDialog
        isOpen={!!confirming}
        fileName={confirming?.split("/").pop()}
        onSave={saveThenClose}
        onDiscard={discardAndClose}
        onCancel={() => setConfirming(null)}
      />
    </div>
  );
}
