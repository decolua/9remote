"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Save, X, ExternalLink, Eye, FileCode } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { PANEL_HEADER_HEIGHT } from "@/shared/constants/layout";
import { EDITOR_PANEL_WIDTH } from "../constants/terminalConfig";
import { resolveFileIcon } from "@/features/fileExplorer/constants/fileIcons";
import { isDiffPath, parseRepoDiffPath, makeDiffPath, GIT_STATUS_COLORS, isHtmlFile, isMermaidFile, FILE_WATCH } from "@/features/fileExplorer/constants/fileExplorer";
import { isPreviewable } from "@/features/fileExplorer/components/FilePreview";
import { useFileDocument } from "@/features/fileExplorer/hooks/useFileDocument";
import { useUnsavedGuard } from "@/features/fileExplorer/hooks/useUnsavedGuard";
import { useDirWatch, usePageVisible } from "@/features/fileExplorer/hooks/useDirWatch";
import UnsavedDialog from "@/features/fileExplorer/components/UnsavedDialog";

const CodeEditor = dynamic(() => import("@/features/fileExplorer/components/CodeEditor"), { ssr: false });
const FilePreview = dynamic(() => import("@/features/fileExplorer/components/FilePreview"), { ssr: false });
const HtmlViewer = dynamic(() => import("@/features/fileExplorer/components/HtmlViewer"), { ssr: false });
const MermaidViewer = dynamic(() => import("@/features/fileExplorer/components/MermaidViewer"), { ssr: false });
const DiffView = dynamic(() => import("@/features/fileExplorer/components/DiffView"), { ssr: false });

// A file opened from the tree, edited without leaving the terminal. Narrow on purpose —
// this is for a quick read or fix, not a replacement for the full editor view.
export default function TerminalEditorPanel({
  filePath, workspace, fileSocket, width, onResize, onClose, onOpenFull, isDesktop = true,
  previewSeq = 0
}) {
  const { t } = useI18n();

  // The Git tab opens a "git-diff:…" tab id, not a path on disk — reading it as one is
  // what produced "file not found". It carries the repo the path belongs to, since the
  // panel lists nested repos and worktrees alongside the workspace root.
  const isDiff = isDiffPath(filePath);
  const diff = isDiff ? parseRepoDiffPath(filePath) : null;
  const diffRepo = diff?.repoPath || workspace;
  const displayPath = isDiff ? diff.filePath : filePath;
  const editable = !!filePath && !isDiff && !isPreviewable(filePath);

  const doc = useFileDocument({ filePath: editable ? filePath : "", fileSocket });
  // The watch callback must not be rebuilt on every keystroke — doc is a new object each
  // render, so it is read through a ref instead of captured. Synced in an effect, the
  // same shape useDirWatch uses for its own callback ref.
  const docRef = useRef(doc);
  useEffect(() => { docRef.current = doc; }, [doc]);
  const guard = useUnsavedGuard({ dirty: editable && doc.dirty, onSave: doc.save });

  // Some text files have a rendered form as well as their source; the eye button flips
  // between the two. One entry per kind — adding a renderer is adding a line here.
  const previewKind = !editable ? null
    : isHtmlFile(filePath) ? "html"
    : isMermaidFile(filePath) ? "mermaid"
    : null;
  const [showRendered, setShowRendered] = useState(false);
  const [saveSeq, setSaveSeq] = useState(0);
  const [lastPath, setLastPath] = useState(filePath);
  const [prevSaved, setPrevSaved] = useState(false);
  const [lastPreviewSeq, setLastPreviewSeq] = useState(previewSeq);
  // Adjust during render (not in an effect) — the sanctioned reset-on-prop pattern.
  if (lastPath !== filePath) {
    setLastPath(filePath);
    setShowRendered(false);
  }
  // A Preview asked for from the tree opens rendered; runs after the path reset above.
  if (lastPreviewSeq !== previewSeq) {
    setLastPreviewSeq(previewSeq);
    if (previewSeq && previewKind) setShowRendered(true);
  }
  // Edge-trigger justSaved into a counter the preview can reload on.
  if (doc.justSaved !== prevSaved) {
    setPrevSaved(doc.justSaved);
    if (doc.justSaved) setSaveSeq((s) => s + 1);
  }

  // Escape closes, but goes through the guard so it cannot throw away unsaved edits.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") guard.guard(onClose); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [guard, onClose]);

  // Follow the file on disk. A panel showing yesterday's render while the terminal
  // reports a rewrite is worse than no panel at all. The watcher reports the whole
  // directory, so the file is picked out here; a rendered preview reloads outright,
  // while the code view defers to useFileDocument, which protects unsaved edits.
  const fileDir = filePath && !isDiff ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
  const watchDirs = useMemo(() => (fileDir ? [fileDir] : []), [fileDir]);
  const pageVisible = usePageVisible();
  const onDiskChanged = useCallback(() => {
    setSaveSeq((seq) => seq + 1);
    docRef.current?.onChangedOnDisk();
  }, []);
  useDirWatch({
    dirs: watchDirs,
    fileSocket,
    enabled: !!fileDir && pageVisible,
    debounceMs: FILE_WATCH.PREVIEW_DEBOUNCE_MS,
    onDirsChanged: onDiskChanged
  });

  if (!filePath) return null;

  const name = displayPath.split("/").pop();
  // Path relative to its own repo reads better than the absolute one in a tooltip.
  const relPath = workspace && displayPath.startsWith(workspace)
    ? displayPath.slice(workspace.length).replace(/^\//, "")
    : displayPath;

  const startResize = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev) => onResize?.(startW - (ev.clientX - startX));
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  return (
    <div
      className="h-full flex flex-col bg-bg border-l border-border-subtle relative shrink min-w-0"
      style={isDesktop ? { width, flexBasis: width, minWidth: EDITOR_PANEL_WIDTH.min } : undefined}
    >
      <div style={{ height: PANEL_HEADER_HEIGHT }}
        className="px-2 flex items-center gap-1.5 border-b border-border-subtle flex-shrink-0">
        <span className="flex-shrink-0">{resolveFileIcon({ name, type: "file" }, 14)}</span>
        <span className="flex-1 min-w-0 truncate text-[12px] text-text" title={relPath}>{name}</span>

        {isDiff && (
          <span className={`text-[10px] font-bold flex-shrink-0 ${GIT_STATUS_COLORS[diff.status] || "text-text-muted"}`}>
            {diff.status}
          </span>
        )}

        {previewKind && (
          <button
            onClick={() => { vibrate(); setShowRendered((v) => !v); }}
            title={showRendered ? t("editor.editCode") : t("editor.preview")}
            className="p-1 text-text-muted hover:text-text rounded-[3px] hover:bg-surface-2 transition-colors"
          >
            {showRendered ? <FileCode size={13} /> : <Eye size={13} />}
          </button>
        )}

        {editable && (
          <button
            onClick={() => { vibrate(); doc.save(); }}
            disabled={!doc.dirty || doc.saving}
            title={t("editor.save")}
            className={`p-1 rounded-[3px] transition-colors disabled:opacity-30 ${
              doc.dirty ? "text-brand-500 hover:bg-surface-2" : "text-text-muted"
            }`}
          >
            <Save size={13} />
          </button>
        )}

        {/* Mobile renders this panel full-screen already — "open full" is desktop-only */}
        {onOpenFull && isDesktop && (
          <button
            onClick={() => { vibrate(); onOpenFull(filePath); }}
            title={t("editor.openFull")}
            className="p-1 text-text-muted hover:text-text rounded-[3px] hover:bg-surface-2 transition-colors"
          >
            <ExternalLink size={13} />
          </button>
        )}

        <button
          onClick={() => { vibrate(); guard.guard(onClose); }}
          className="p-1 text-text-muted hover:text-text rounded-[3px] hover:bg-surface-2 transition-colors"
        >
          <X size={13} />
        </button>
      </div>

      {doc.error && editable && (
        <div className="px-3 py-1.5 text-[11px] text-red-500 bg-red-500/10 border-b border-border-subtle break-words">
          {doc.error}
        </div>
      )}

      {/* Something else rewrote the file while edits were in progress. The choice is the
          user's: taking the new text automatically would throw their work away. */}
      {doc.staleOnDisk && (
        <div className="px-3 py-1.5 flex items-center gap-2 text-[11px] text-amber-500 bg-amber-500/10 border-b border-border-subtle">
          <span className="flex-1 min-w-0 truncate">{t("editor.changedOnDisk")}</span>
          <button
            onClick={() => { vibrate(); doc.reload(); }}
            className="shrink-0 px-1.5 py-0.5 rounded-[3px] hover:bg-amber-500/20 font-medium transition-colors"
          >
            {t("editor.reloadFromDisk")}
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-hidden">
        {isDiff ? (
          <DiffView diffPath={makeDiffPath(diff.status, diff.filePath)} workspace={diffRepo} fileSocket={fileSocket} compact />
        ) : isPreviewable(filePath) ? (
          <FilePreview filePath={filePath} fileSocket={fileSocket} />
        ) : showRendered && previewKind === "html" ? (
          <HtmlViewer filePath={filePath} fileSocket={fileSocket} reloadKey={saveSeq} />
        ) : showRendered && previewKind === "mermaid" ? (
          <MermaidViewer content={doc.content} reloadKey={saveSeq} />
        ) : doc.loading ? (
          <div className="h-full flex items-center justify-center text-text-muted text-xs">{t("common.loading")}</div>
        ) : (
          <CodeEditor
            filePath={filePath}
            content={doc.content}
            onTextChanged={doc.onTextChanged}
            onRegisterView={doc.register}
            onSave={doc.save}
            compact
          />
        )}
      </div>

      <UnsavedDialog
        isOpen={guard.asking}
        fileName={name}
        onSave={guard.saveThenLeave}
        onDiscard={guard.discardAndLeave}
        onCancel={guard.cancel}
      />

      {isDesktop && (
        <div
          onPointerDown={startResize}
          className="absolute top-0 left-0 bottom-0 w-1 cursor-col-resize hover:bg-brand-500/40 transition-colors z-20"
        />
      )}
    </div>
  );
}
