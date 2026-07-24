"use client";

import { useState, useCallback } from "react";
import { FolderOpen } from "@/shared/components/ui/Icon";
import EditorTabs from "./EditorTabs.js";
import Breadcrumbs from "./Breadcrumbs.js";
import EmbeddedEditor from "./EmbeddedEditor.js";
import ImageViewer, { isImageFile } from "./ImageViewer.js";
import MediaViewer from "./MediaViewer.js";
import PdfViewer from "./PdfViewer.js";
import DiffView from "./DiffView.js";
import { isDiffPath, isVideoFile, isAudioFile, isPdfFile } from "../constants/fileExplorer.js";

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
  const [dirtyFiles, setDirtyFiles] = useState(new Set());

  const handleDirtyChange = useCallback((path, isDirty) => {
    setDirtyFiles((prev) => {
      const next = new Set(prev);
      if (isDirty) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);

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
        onClose={onCloseFile}
        onCloseOthers={onCloseOthers}
        onCloseAll={onCloseAll}
      />
      <Breadcrumbs workspace={workspace} filePath={activeFile} />
      <div className="flex-1 min-h-0 overflow-hidden">
        {openedFiles.map((path) => {
          const isActive = path === activeFile;
          return (
            <div key={path} className={isActive ? "h-full" : "hidden"}>
              {isDiffPath(path) ? (
                <DiffView diffPath={path} workspace={workspace} fileSocket={fileSocket} />
              ) : isPdfFile(path) ? (
                <PdfViewer filePath={path} fileSocket={fileSocket} />
              ) : isVideoFile(path) || isAudioFile(path) ? (
                <MediaViewer filePath={path} fileSocket={fileSocket} />
              ) : isImageFile(path) ? (
                <ImageViewer filePath={path} fileSocket={fileSocket} />
              ) : (
                <EmbeddedEditor
                  filePath={path}
                  fileSocket={fileSocket}
                  workspace={workspace}
                  onEditorStateChange={onEditorStateChange}
                  onDirtyChange={handleDirtyChange}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
