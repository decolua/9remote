"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, Copy, GitBranch, Loader2, Save, X, Eye, FileCode } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import CodeEditor from "./CodeEditor.js";
import DiffBody from "./DiffBody.js";
import FilePreview, { isPreviewable } from "./FilePreview.js";
import HtmlViewer from "./HtmlViewer.js";
import UnsavedDialog from "./UnsavedDialog.js";
import { isHtmlFile } from "../constants/fileExplorer.js";
import { useFileDocument } from "../hooks/useFileDocument.js";
import { useUnsavedGuard } from "../hooks/useUnsavedGuard.js";
import EditorKeyBar from "./EditorKeyBar.js";

// Mobile full-screen editor. The editing itself is CodeEditor + useFileDocument, the same
// pair the desktop tabs and the terminal panel use; what is special here is the chrome —
// a key bar, because a phone keyboard has no Esc, Tab or arrows.
export default function FileEditor({ filePath, fileSocket, onBack, line, column, workspace, diffStatus, preview = false }) {
  const { t } = useI18n();
  const previewOnly = isPreviewable(filePath);
  // Opened from a git entry — this overlay exists to show the diff, not the file.
  const diffOnly = !!diffStatus;
  const fileName = filePath.split("/").pop();

  const doc = useFileDocument({ filePath: !diffOnly && !previewOnly ? filePath : "", fileSocket });
  const guard = useUnsavedGuard({ dirty: !diffOnly && !previewOnly && doc.dirty, onSave: doc.save });

  const viewRef = useRef(null);
  const [copied, setCopied] = useState(false);
  const [gitStatus, setGitStatus] = useState(null);
  const [diff, setDiff] = useState(null);   // null = hidden
  const [diffLoading, setDiffLoading] = useState(false);

  // HTML files can flip between source and rendered view; one file = one mode.
  const canPreviewHtml = !diffOnly && !previewOnly && isHtmlFile(filePath);
  // Opened by a Preview click, this starts rendered; every other open starts as source.
  const [htmlPreview, setHtmlPreview] = useState(preview && canPreviewHtml);
  const [saveSeq, setSaveSeq] = useState(0);
  const [lastPath, setLastPath] = useState(filePath);
  const [prevSaved, setPrevSaved] = useState(false);
  // Adjust during render (not in an effect) — the sanctioned reset-on-prop pattern.
  if (lastPath !== filePath) {
    setLastPath(filePath);
    setHtmlPreview(preview && canPreviewHtml);
  }
  // Edge-trigger justSaved into a counter the preview can reload on.
  if (doc.justSaved !== prevSaved) {
    setPrevSaved(doc.justSaved);
    if (doc.justSaved) setSaveSeq((s) => s + 1);
  }

  const registerView = useCallback((readText, view) => { viewRef.current = view; }, []);

  useEffect(() => {
    if (diffOnly || !workspace || !filePath) return;
    let cancelled = false;
    fileSocket.gitFileStatus(workspace, filePath).then((r) => {
      if (cancelled) return;
      setGitStatus(r?.success && r.status ? r : null);
    });
    return () => { cancelled = true; };
  }, [filePath, workspace, fileSocket]);

  const showDiff = async () => {
    if (!gitStatus || !workspace) return;
    setDiffLoading(true);
    const r = await fileSocket.gitDiff(workspace, gitStatus.file, gitStatus.status);
    setDiffLoading(false);
    if (r?.success) setDiff(r.diff || "");
  };

  // Opened from a git entry with its status known — show the diff overlay straight away
  // instead of waiting for the GitBranch tap. X reveals the editor underneath.
  useEffect(() => {
    if (!diffStatus || !workspace || !filePath) return;
    let cancelled = false;
    // Deferred a tick so the loading flag is not set synchronously inside the effect.
    const id = setTimeout(async () => {
      setDiffLoading(true);
      const r = await fileSocket.gitDiff(workspace, filePath, diffStatus);
      if (cancelled) return;
      setDiffLoading(false);
      if (r?.success) setDiff(r.diff || "");
    }, 0);
    return () => { cancelled = true; clearTimeout(id); };
  }, [diffStatus, workspace, filePath, fileSocket]);

  const copyContent = async () => {
    const text = viewRef.current?.state.doc.toString();
    if (text == null) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  return (
    <div className="h-full bg-bg flex flex-col">
      <div className="bg-surface px-4 py-3 flex items-center gap-2 flex-shrink-0">
        <button
          onClick={() => { vibrate(); guard.guard(onBack); }}
          className="p-2 bg-surface-2 hover:bg-surface-3 text-text rounded-brand transition-all duration-150 ease-out active:scale-[0.96]"
        >
          <ChevronLeft size={20} />
        </button>

        <div className="flex-1 flex items-center gap-2 min-w-0">
          <span className="text-text font-medium truncate">{fileName}</span>
          {doc.dirty && (
            <span className="w-2 h-2 bg-yellow-400 rounded-full flex-shrink-0" title={t("editor.unsaved")} />
          )}
          {doc.justSaved && <span className="text-green-400 text-xs flex-shrink-0">{t("editor.saved")}</span>}
          {copied && <span className="text-green-400 text-xs flex-shrink-0">{t("editor.copied", { defaultValue: "Copied" })}</span>}
        </div>

        {gitStatus && (
          <button
            onClick={() => { vibrate(); showDiff(); }}
            disabled={diffLoading}
            className="p-2 bg-surface-2 hover:bg-surface-3 text-orange-400 rounded-brand transition-all duration-150 ease-out active:scale-[0.96]"
            title={t("editor.gitDiff")}
          >
            {diffLoading ? <Loader2 className="animate-spin" size={16} /> : <GitBranch size={16} />}
          </button>
        )}

        {canPreviewHtml && (
          <button
            onClick={() => { vibrate(); setHtmlPreview((v) => !v); }}
            title={htmlPreview ? t("editor.editCode") : t("editor.preview")}
            className="p-2 bg-surface-2 hover:bg-surface-3 text-text rounded-brand transition-all duration-150 ease-out active:scale-[0.96]"
          >
            {htmlPreview ? <FileCode size={16} /> : <Eye size={16} />}
          </button>
        )}

        {!previewOnly && !diffOnly && (
          <button
            onClick={() => { vibrate(); copyContent(); }}
            className="p-2 bg-surface-2 hover:bg-surface-3 text-text rounded-brand transition-all duration-150 ease-out active:scale-[0.96]"
            title={t("editor.copy", { defaultValue: "Copy" })}
          >
            <Copy size={16} />
          </button>
        )}

        {!previewOnly && !diffOnly && (
          <button
            onClick={() => { vibrate(); doc.save(); }}
            disabled={!doc.dirty || doc.saving}
            className={`px-3 py-2 rounded-brand transition-all duration-150 ease-out flex items-center gap-1 ${
              doc.dirty && !doc.saving
                ? "bg-brand-500 hover:bg-brand-600 text-white shadow-sm active:scale-[0.97]"
                : "bg-surface-2 text-text-muted cursor-not-allowed"
            }`}
          >
            {doc.saving ? <Loader2 className="animate-spin" size={16} /> : <Save size={16} />}
            <span className="hidden sm:inline">{t("editor.save")}</span>
          </button>
        )}
      </div>

      {doc.error && !previewOnly && (
        <div className="bg-red-500/20 border-b border-red-500/50 px-4 py-2 text-red-400 text-sm break-words">
          {doc.error}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-hidden">
        {diffOnly ? (
          <div className="h-full overflow-auto p-2">
            {diffLoading ? (
              <div className="h-full flex items-center justify-center text-text-muted">{t("common.loading")}</div>
            ) : diff ? <DiffBody diff={diff} /> : (
              <div className="h-32 flex items-center justify-center text-text-muted text-sm">{t("git.noChanges")}</div>
            )}
          </div>
        ) : previewOnly ? (
          <FilePreview filePath={filePath} fileSocket={fileSocket} />
        ) : htmlPreview && canPreviewHtml ? (
          <HtmlViewer filePath={filePath} fileSocket={fileSocket} reloadKey={saveSeq} />
        ) : doc.loading ? (
          <div className="h-full flex items-center justify-center text-text-muted">{t("common.loading")}</div>
        ) : (
          <CodeEditor
            filePath={filePath}
            content={doc.content}
            onTextChanged={doc.onTextChanged}
            onRegisterView={(readText, view) => { doc.register(readText); registerView(readText, view); }}
            onSave={doc.save}
            line={line}
            column={column}
          />
        )}
      </div>

      {/* Git diff, over the editor rather than beside it — there is no room beside it. */}
      {!diffOnly && diff !== null && (
        <div className="absolute inset-0 z-30 bg-bg flex flex-col">
          <div className="bg-surface-2 px-4 py-3 flex items-center justify-between flex-shrink-0">
            <span className="text-text font-medium truncate">{t("editor.gitDiff")}</span>
            <button
              onClick={() => { vibrate(); setDiff(null); }}
              className="p-2 text-text-muted hover:text-text rounded-brand"
            >
              <X size={18} />
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-auto p-2">
            {diff ? <DiffBody diff={diff} /> : (
              <div className="h-32 flex items-center justify-center text-text-muted text-sm">{t("git.noChanges")}</div>
            )}
          </div>
        </div>
      )}

      {!previewOnly && !diffOnly && !doc.loading && !htmlPreview && <EditorKeyBar viewRef={viewRef} />}

      <UnsavedDialog
        isOpen={guard.asking}
        fileName={fileName}
        onSave={guard.saveThenLeave}
        onDiscard={guard.discardAndLeave}
        onCancel={guard.cancel}
      />
    </div>
  );
}
