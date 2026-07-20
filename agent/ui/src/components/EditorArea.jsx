import { useState, useCallback } from "preact/hooks";
import Icon from "./Icon";
import EditorTabs from "./EditorTabs";
import Breadcrumbs from "./Breadcrumbs";
import EmbeddedEditor from "./EmbeddedEditor";
import ImageViewer, { isImageFile } from "./ImageViewer";
import MediaViewer from "./MediaViewer";
import PdfViewer from "./PdfViewer";
import DiffView from "./DiffView";
import { isDiffPath, isVideoFile, isAudioFile, isPdfFile } from "../lib/fileExplorer/constants";

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
  onEditorStateChange,
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
          <Icon name="folderOpen" size={64} className="opacity-40" />
          <div className="text-sm">Open a file from the Explorer to get started</div>
          <div className="text-xs flex items-center gap-2">
            <kbd className="px-2 py-0.5 bg-surface-2 border border-border rounded text-text-subtle font-mono">Cmd/Ctrl+P</kbd>
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
        {isDiffPath(activeFile) ? (
          <DiffView key={activeFile} diffPath={activeFile} workspace={workspace} fileSocket={fileSocket} onOpenFile={onOpenFile} />
        ) : isPdfFile(activeFile) ? (
          <PdfViewer key={activeFile} filePath={activeFile} fileSocket={fileSocket} />
        ) : isVideoFile(activeFile) || isAudioFile(activeFile) ? (
          <MediaViewer key={activeFile} filePath={activeFile} fileSocket={fileSocket} />
        ) : isImageFile(activeFile) ? (
          <ImageViewer key={activeFile} filePath={activeFile} fileSocket={fileSocket} />
        ) : (
          <EmbeddedEditor
            key={activeFile}
            filePath={activeFile}
            fileSocket={fileSocket}
            workspace={workspace}
            onEditorStateChange={onEditorStateChange}
            onDirtyChange={handleDirtyChange}
          />
        )}
      </div>
    </div>
  );
}
