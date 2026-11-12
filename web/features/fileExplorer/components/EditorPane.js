"use client";

import { useCallback, useEffect, useState } from "react";
import { Save, Eye, FileCode, Globe } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { isDiffPath, parseRepoDiffPath, getTextPreviewKind, resolveDiffFilePath } from "../constants/fileExplorer.js";
import { openHtmlPreviewInBrowser } from "../lib/previewInBrowser.js";
import CodeEditor from "./CodeEditor.js";
import DiffView from "./DiffView.js";
import FilePreview, { isPreviewable } from "./FilePreview.js";
import TextPreview from "./TextPreview.js";
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
  filePath, workspace, fileBus, isActive,
  onCursorChange, onDirtyChange, onRegisterSaver, onOpenFile, previewSeq = 0
}) {
  const { t } = useI18n();
  const editable = !isDiffPath(filePath) && !isPreviewable(filePath);
  const doc = useFileDocument({ filePath: editable ? filePath : "", fileBus });

  // Text files with rendered forms (html, markdown, mermaid) can flip between source and preview.
  const previewKind = editable ? getTextPreviewKind(filePath) : null;
  // HTML renders in the remote browser pane, not in-place: its "preview" hands a
  // loopback preview URL to the browser view instead of swapping this pane.
  const isHtmlPreview = previewKind === "html";
  // A pane mounted by a Preview click starts rendered; every other one starts as source.
  const [showRendered, setShowRendered] = useState(!!previewSeq && !!previewKind);
  const [previewError, setPreviewError] = useState("");
  const [saveSeq, setSaveSeq] = useState(0);
  const [lastPath, setLastPath] = useState(filePath);
  const [prevSaved, setPrevSaved] = useState(false);
  const [lastPreviewSeq, setLastPreviewSeq] = useState(previewSeq);
  // Adjust during render (not in an effect) — the sanctioned reset-on-prop pattern.
  if (lastPath !== filePath) {
    setLastPath(filePath);
    setShowRendered(false);
    setPreviewError("");
  }
  // A Preview asked for from the explorer opens rendered, even on an already-open tab.
  else if (lastPreviewSeq !== previewSeq) {
    setLastPreviewSeq(previewSeq);
    if (previewSeq && previewKind) setShowRendered(true);
  }
  // Edge-trigger justSaved into a counter the preview can reload on.
  if (doc.justSaved !== prevSaved) {
    setPrevSaved(doc.justSaved);
    if (doc.justSaved) setSaveSeq((s) => s + 1);
  }

  // HTML preview opens in the remote browser pane; this pane stays on source.
  const openBrowserPreview = useCallback((path) => {
    openHtmlPreviewInBrowser(fileBus, path).then((r) => {
      if (!r.ok) setPreviewError(r.error || t("editor.previewFailed"));
    });
  }, [fileBus, t]);
  // A Preview open (context menu, AI artifact) takes HTML straight there.
  useEffect(() => {
    if (!isHtmlPreview || previewSeq <= 0) return;
    let cancelled = false;
    openHtmlPreviewInBrowser(fileBus, filePath).then((r) => {
      if (!cancelled && !r.ok) setPreviewError(r.error || t("editor.previewFailed"));
    });
    return () => { cancelled = true; };
  // t is stable enough for an error string: a locale dict landing late must not
  // re-run the open (it would spawn a duplicate tab).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHtmlPreview, previewSeq, fileBus, filePath]);

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
    // The diff body carries no chrome of its own — a slim bar gives it the same
    // open/preview actions the editor view has, so a change can jump to the file.
    const d = parseRepoDiffPath(filePath);
    const diffAbsPath = resolveDiffFilePath(filePath, workspace);
    const exists = d.status !== "D";
    const isHtml = exists && getTextPreviewKind(d.filePath) === "html";
    return (
      <div className="h-full flex flex-col">
        {previewError && (
          <div className="px-4 py-2 text-sm text-red-400 bg-red-500/15 border-b border-red-500/40 break-words">
            {previewError}
          </div>
        )}
        {(isHtml || (exists && onOpenFile)) && (
          <div className="px-3 py-1.5 flex items-center justify-end bg-surface flex-shrink-0">
            {isHtml && (
              <button
                onClick={() => { vibrate(); openBrowserPreview(diffAbsPath); }}
                title={t("editor.previewInBrowser")}
                className="p-1 text-text-muted hover:text-text rounded-[3px] hover:bg-surface-2 transition-colors"
              >
                <Globe size={13} />
              </button>
            )}
            {exists && onOpenFile && (
              <button
                onClick={() => { vibrate(); onOpenFile(diffAbsPath); }}
                title={t("git.openFile")}
                className="p-1 text-text-muted hover:text-text rounded-[3px] hover:bg-surface-2 transition-colors"
              >
                <FileCode size={13} />
              </button>
            )}
          </div>
        )}
        <div className="flex-1 min-h-0">
          <DiffView diffPath={filePath} workspace={workspace} fileBus={fileBus} />
        </div>
      </div>
    );
  }
  if (isPreviewable(filePath)) {
    return <FilePreview filePath={filePath} fileBus={fileBus} />;
  }

  return (
    <div className="h-full flex flex-col">
      {doc.error && (
        <div className="px-4 py-2 text-sm text-red-400 bg-red-500/15 border-b border-red-500/40 break-words">
          {doc.error}
        </div>
      )}
      {previewError && (
        <div className="px-4 py-2 text-sm text-red-400 bg-red-500/15 border-b border-red-500/40 break-words">
          {previewError}
        </div>
      )}

      {/* Preview toggle rides its own slim bar — there is no other chrome here. */}
      {previewKind && (
        <div className="px-3 py-1.5 flex items-center justify-end bg-surface flex-shrink-0">
          {isHtmlPreview ? (
            <button
              onClick={() => { vibrate(); openBrowserPreview(filePath); }}
              title={t("editor.previewInBrowser")}
              className="p-1 text-text-muted hover:text-text rounded-[3px] hover:bg-surface-2 transition-colors"
            >
              <Globe size={13} />
            </button>
          ) : (
            <button
              onClick={() => { vibrate(); setShowRendered((v) => !v); }}
              title={showRendered ? t("editor.editCode") : t("editor.preview")}
              className="p-1 text-text-muted hover:text-text rounded-[3px] hover:bg-surface-2 transition-colors"
            >
              {showRendered ? <FileCode size={13} /> : <Eye size={13} />}
            </button>
          )}
        </div>
      )}

      {/* A save bar, not a timer: it appears only when there is something to save. */}
      {doc.dirty && (
        <div className="px-3 py-1.5 flex items-center gap-2 bg-surface flex-shrink-0">
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
        {showRendered && previewKind && !isHtmlPreview ? (
          <TextPreview kind={previewKind} filePath={filePath} fileBus={fileBus} content={doc.content} reloadKey={saveSeq} />
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
