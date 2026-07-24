import { useEffect, useRef, useState, useCallback } from "preact/hooks";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import Icon from "./Icon";
import { useI18n } from "../i18n";
import { vibrate } from "../lib/vibrate";

const SAVE_DEBOUNCE_MS = 500;

// Overlay markdown editor for a terminal session's note (mirrors web NotePanel).
// CodeMirror is the single source of truth: load once on mount, save to socket on each edit.
export default function NotePanel({ socket, sessionId, appendOnOpen, onClose, theme = "dark" }) {
  const { t } = useI18n();
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
      socket.emit("saveNote", { sessionId, text: view.state.doc.toString() }, () => {});
    }, SAVE_DEBOUNCE_MS);
  }, [socket, sessionId]);

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
      if (initial !== (res?.success ? (res.text || "") : "")) save();
    });
    return () => {
      cancelled = true;
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
      className="fixed inset-0 z-[90] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onMouseDown={(e) => { e.preventDefault(); onClose(); }}
    >
      <div
        className="w-full max-w-lg h-[55dvh] min-h-[300px] flex flex-col overflow-hidden"
        style={{ background: "var(--surface)", borderRadius: "var(--radius-brand-lg, 16px)", boxShadow: "var(--shadow-elev, 0 10px 30px rgba(0,0,0,0.3))" }}
        onMouseDown={(e) => { e.stopPropagation(); }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 flex-shrink-0" style={{ borderBottom: "1px solid var(--border)", background: "var(--surface)" }}>
          <span className="text-sm font-medium" style={{ color: "var(--text-main)" }}>{t("note.title")}</span>
          <div className="flex items-center gap-1">
            <button onClick={handleCopy} disabled={!hasText}
              className="p-2 rounded-lg transition-colors disabled:opacity-40 card-act"
              style={{ color: "var(--text-main)" }}
              title={t("note.copy")}>
              <Icon name={copied ? "check" : "copy"} size={16} color={copied ? "#4ade80" : undefined} />
            </button>
            <button onClick={handleClear} disabled={!hasText}
              className="p-2 rounded-lg transition-colors disabled:opacity-40 card-act"
              style={{ color: "#f87171" }}
              title={t("note.clear")}>
              <Icon name="trash" size={16} />
            </button>
            <button onClick={onClose}
              className="p-2 rounded-lg transition-colors card-act"
              style={{ color: "var(--text-main)" }}
              title={t("common.close")}>
              <Icon name="x" size={16} />
            </button>
          </div>
        </div>
        <div ref={editorRef} className="flex-1 min-h-0 overflow-hidden note-cm" />
      </div>
      <style>{`
        .note-cm .cm-editor{height:100%;background:var(--surface)}
        .note-cm .cm-scroller{background:var(--surface);overflow:auto}
        .note-cm .cm-gutters{border-right:1px solid var(--border);background:transparent}
      `}</style>
    </div>
  );
}
