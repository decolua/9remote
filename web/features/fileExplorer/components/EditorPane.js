"use client";

import { useEffect, useState } from "react";
import { Save, Eye, FileCode } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { isDiffPath, isHtmlFile } from "../constants/fileExplorer.js";
import CodeEditor from "./CodeEditor.js";
import DiffView from "./DiffView.js";
import FilePreview, { isPreviewable } from "./FilePreview.js";
import HtmlViewer from "./HtmlViewer.js";
import { useFileDocument } from "../hooks/useFileDocument.js";

/**
 * One opened file, whatever kind it is: a diff, a previewable binary, or text to edit.
 * A component per file rather than one shared instance, because each keeps its own
 * loaded content and dirty flag — that is what lets the tab strip mark exactly the tabs
 * with unsaved work, and close them one at a time.
 *
 * The unsaved-edit dialog belongs to EditorArea, not here: a close starts at the tab
 * strip, and a hidden tab has no chrome of its own to put a dialog in.
 */
export default function EditorPane({
  filePath, workspace, fileSocket, isActive,
  onCursorChange, onDirtyChange, onRegisterSaver, previewSeq = 0
}) {
  const { t } = useI18n();
  const editable = !isDiffPath(filePath) && !isPreviewable(filePath);
  const doc = useFileDocument({ filePath: editable ? filePath : "", fileSocket });

  // HTML files can flip between source and rendered view; one file = one mode.
  const canPreviewHtml = editable && isHtmlFile(filePath);
  // A pane mounted by a Preview click starts rendered; every other one starts as source.
  const [htmlPreview, setHtmlPreview] = useState(!!previewSeq && canPreviewHtml);
  const [saveSeq, setSaveSeq] = useState(0);
  const [lastPath, setLastPath] = useState(filePath);
  const [prevSaved, setPrevSaved] = useState(false);
  const [lastPreviewSeq, setLastPreviewSeq] = useState(previewSeq);
  // Adjust during render (not in an effect) — the sanctioned reset-on-prop pattern.
  if (lastPath !== filePath) {
    setLastPath(filePath);
    setHtmlPreview(false);
  }
  // A Preview asked for from the explorer opens rendered, even on an already-open tab.
  else if (lastPreviewSeq !== previewSeq) {
    setLastPreviewSeq(previewSeq);
    if (previewSeq && canPreviewHtml) setHtmlPreview(true);
  }
  // Edge-trigger justSaved into a counter the preview can reload on.
  if (doc.justSaved !== prevSaved) {
    setPrevSaved(doc.justSaved);
    if (doc.justSaved) setSaveSeq((s) => s + 1);
  }

  useEffect(() => {
    onDirtyChange?.(filePath, editable && doc.dirty);
  }, [filePath, editable, doc.dirty, onDirtyChange]);

  // Publish this file's save so the tab strip can call it, and withdraw both on unmount
  // so a closed tab leaves neither a dirty dot nor a stale saver behind.
  useEffect(() => {
    if (!editable) return;
    onRegisterSaver?.(filePath, doc.save);
    return () => {
      onRegisterSaver?.(filePath, null);
      onDirtyChange?.(filePath, false);
    };
  }, [filePath, editable, doc.save, onRegisterSaver, onDirtyChange]);

  // Cmd/Ctrl+S while the editor surface itself does not have focus.
  useEffect(() => {
    if (!isActive || !editable) return;
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        doc.save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isActive, editable, doc]);

  if (isDiffPath(filePath)) {
    return <DiffView diffPath={filePath} workspace={workspace} fileSocket={fileSocket} />;
  }
  if (isPreviewable(filePath)) {
    return <FilePreview filePath={filePath} fileSocket={fileSocket} />;
  }

  return (
    <div className="h-full flex flex-col">
      {doc.error && (
        <div className="px-4 py-2 text-sm text-red-400 bg-red-500/15 border-b border-red-500/40 break-words">
          {doc.error}
        </div>
      )}

      {/* HTML preview toggle rides its own slim bar — there is no other chrome here. */}
      {canPreviewHtml && (
        <div className="px-3 py-1.5 flex items-center justify-end bg-surface border-b border-border-subtle flex-shrink-0">
          <button
            onClick={() => { vibrate(); setHtmlPreview((v) => !v); }}
            title={htmlPreview ? t("editor.editCode") : t("editor.preview")}
            className="p-1 text-text-muted hover:text-text rounded-[3px] hover:bg-surface-2 transition-colors"
          >
            {htmlPreview ? <FileCode size={13} /> : <Eye size={13} />}
          </button>
        </div>
      )}

      {/* A save bar, not a timer: it appears only when there is something to save. */}
      {doc.dirty && (
        <div className="px-3 py-1.5 flex items-center gap-2 bg-surface border-b border-border-subtle flex-shrink-0">
          <span className="flex-1 text-[11px] text-text-muted">{t("editor.unsaved")}</span>
          <button
            onClick={() => { vibrate(); doc.save(); }}
            disabled={doc.saving}
            className="px-2.5 py-1 flex items-center gap-1.5 text-[11px] font-medium text-white bg-brand-500 hover:bg-brand-600 rounded-brand disabled:opacity-50 transition-colors"
          >
            <Save size={12} /> {doc.saving ? t("editor.saving") : t("editor.save")}
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0">
        {htmlPreview && canPreviewHtml ? (
          <HtmlViewer filePath={filePath} fileSocket={fileSocket} reloadKey={saveSeq} />
        ) : doc.loading ? (
          <div className="h-full flex items-center justify-center text-text-muted text-sm">{t("common.loading")}</div>
        ) : (
          <CodeEditor
            filePath={filePath}
            content={doc.content}
            onTextChanged={doc.onTextChanged}
            onRegisterView={doc.register}
            onSave={doc.save}
            onCursorChange={onCursorChange}
          />
        )}
      </div>
    </div>
  );
}
