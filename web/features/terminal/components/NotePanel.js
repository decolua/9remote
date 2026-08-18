"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import { Copy, X, Check, Trash2 } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { useTheme } from "@/shared/theme/ThemeProvider";
import { vibrate } from "@/shared/utils/vibration";

const SAVE_DEBOUNCE_MS = 500;

// Overlay markdown editor for a terminal session's note. CodeMirror is the single
// source of truth: load once on mount, save directly to the socket on each edit.
// No two-way echo → no keystroke race.
export default function NotePanel({ socket, sessionId, appendOnOpen, onClose }) {
  const { t } = useI18n();
  const { theme } = useTheme();
  const editorRef = useRef(null);
  const viewRef = useRef(null);
  const saveTimerRef = useRef(null);
  const pendingAppendRef = useRef(appendOnOpen);
  const [copied, setCopied] = useState(false);
  const [hasText, setHasText] = useState(false);

  const save = useCallback(() => {
    if (!socket || !sessionId) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      const view = viewRef.current;
      if (!view) return;
      // Ack-style emit matches useFileSocket — keeps the proxy control channel reliable
      socket.emit("saveNote", { sessionId, text: view.state.doc.toString() }, () => {});
    }, SAVE_DEBOUNCE_MS);
  }, [socket, sessionId]);

  // Load note once, build the editor with that content. Append selection text if requested.
  useEffect(() => {
    if (!socket || !sessionId || !editorRef.current) return;
    let view;
    let cancelled = false;
    socket.emit("getNote", { sessionId }, (res) => {
      if (cancelled) return;
      let initial = res?.success ? (res.text || "") : "";
      if (pendingAppendRef.current) {
        const sep = initial && !initial.endsWith("\n") ? "\n" : "";
        initial = `${initial}${sep}${pendingAppendRef.current}`;
        pendingAppendRef.current = null;
      }
      const isDark = theme !== "light";
      const updateListener = EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          setHasText(u.state.doc.length > 0);
          save();
        }
      });
      const state = EditorState.create({
        doc: initial,
        extensions: [
          basicSetup,
          markdown(),
          EditorView.lineWrapping,
          updateListener,
          EditorView.theme({
            "&": { height: "100%", fontSize: "13px" },
            ".cm-scroller": { fontFamily: "ui-monospace, monospace" },
            ".cm-content": { padding: "12px" },
            ".cm-url, .cm-link, .cm-formatting-link": { textDecoration: "none" }
          }),
          ...(isDark ? [oneDark] : [])
        ]
      });
      view = new EditorView({ state, parent: editorRef.current });
      viewRef.current = view;
      setHasText(initial.length > 0);
      // If append produced new content, persist it
      if (initial !== (res?.success ? (res.text || "") : "")) save();
    });
    return () => {
      cancelled = true;
      // Flush pending save on unmount
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        if (view) socket?.emit("saveNote", { sessionId, text: view.state.doc.toString() }, () => {});
      }
      view?.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, sessionId]);

  const handleCopy = async () => {
    vibrate();
    const txt = viewRef.current?.state.doc.toString() || "";
    try {
      await navigator.clipboard?.writeText(txt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  };

  const handleClear = () => {
    vibrate();
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "" } });
    setHasText(false);
  };

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-[60] p-4"
      onMouseDown={(e) => { e.preventDefault(); onClose(); }}
    >
      <div
        className="card-elev w-full max-w-lg h-[55dvh] min-h-[300px] flex flex-col overflow-hidden"
        onMouseDown={(e) => { e.stopPropagation(); }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-surface flex-shrink-0">
          <span className="text-text text-sm font-medium">{t("note.title")}</span>
          <div className="flex items-center gap-1">
            <button onClick={handleCopy} disabled={!hasText}
              className="p-2 hover:bg-surface-2 text-text rounded-brand transition-colors disabled:opacity-40"
              title={t("note.copy")}>
              {copied ? <Check size={16} className="text-green-400" /> : <Copy size={16} />}
            </button>
            <button onClick={handleClear} disabled={!hasText}
              className="p-2 hover:bg-surface-2 text-red-400 rounded-brand transition-colors disabled:opacity-40"
              title={t("note.clear")}>
              <Trash2 size={16} />
            </button>
            <button onClick={onClose}
              className="p-2 hover:bg-surface-2 text-text rounded-brand transition-colors"
              title="Close">
              <X size={16} />
            </button>
          </div>
        </div>
        <div ref={editorRef} className="flex-1 min-h-0 overflow-hidden note-cm" />
      </div>
      <style jsx global>{`
        .note-cm .cm-editor{height:100%}
        .note-cm .cm-scroller{overflow:auto}
        .note-cm .cm-gutters{border-right:1px solid var(--border,#262e3a);background:transparent}
      `}</style>
    </div>
  );
}
