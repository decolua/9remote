import { useState, useEffect, useRef, useCallback } from "preact/hooks";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import { search } from "@codemirror/search";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { indentWithTab } from "@codemirror/commands";
import { keymap } from "@codemirror/view";
import {
  AUTO_SAVE_DELAY,
  AUTO_SAVE_MODES,
  STORAGE_KEYS,
  EDITOR_FONT_DEFAULT,
  LANGUAGE_MAP,
} from "../lib/fileExplorer/constants";
import { usePersistedState } from "../lib/usePersistedState";
import Icon from "./Icon";

const languageExtensions = {
  javascript: javascript(),
  html: html(),
  css: css(),
  json: json(),
  markdown: markdown(),
};

function getLanguageInfo(filePath) {
  const ext = "." + (filePath.split(".").pop() || "").toLowerCase();
  const lang = LANGUAGE_MAP[ext] || "plaintext";
  return { lang, extension: languageExtensions[lang] || [] };
}

// Read current theme from DOM attribute (agent sets data-theme on <html>).
function readTheme() {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

export default function EmbeddedEditor({ filePath, fileSocket, onEditorStateChange, line, column, onDirtyChange }) {
  const editorRef = useRef(null);
  const viewRef = useRef(null);
  const originalContentRef = useRef("");
  const autoSaveTimerRef = useRef(null);
  const onEditorStateChangeRef = useRef(onEditorStateChange);
  const onDirtyChangeRef = useRef(onDirtyChange);

  const [loading, setLoading] = useState(true);
  const [content, setContent] = useState(null);
  const [error, setError] = useState("");
  const [hasChanges, setHasChanges] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [theme, setTheme] = useState(readTheme);

  const [autoSaveMode] = usePersistedState(STORAGE_KEYS.autoSaveMode, AUTO_SAVE_MODES.afterDelay);
  const [fontSize] = usePersistedState(STORAGE_KEYS.editorFontSize, EDITOR_FONT_DEFAULT);
  const [wordWrap] = usePersistedState(STORAGE_KEYS.wordWrap, true);

  const { lang, extension: langExtension } = getLanguageInfo(filePath);

  useEffect(() => { onEditorStateChangeRef.current = onEditorStateChange; }, [onEditorStateChange]);
  useEffect(() => { onDirtyChangeRef.current = onDirtyChange; }, [onDirtyChange]);

  // Sync theme from DOM (agent toggles data-theme externally)
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(readTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  const saveFile = useCallback(async () => {
    if (!viewRef.current || saving) return;
    const currentContent = viewRef.current.state.doc.toString();
    if (currentContent === originalContentRef.current) return;

    setSaving(true);
    const result = await fileSocket.writeFile(filePath, currentContent);
    setSaving(false);

    if (result.success) {
      originalContentRef.current = currentContent;
      setHasChanges(false);
      onDirtyChangeRef.current?.(filePath, false);
    } else {
      setError(result.error);
    }
  }, [filePath, fileSocket, saving]);

  const saveFileRef = useRef(saveFile);
  useEffect(() => { saveFileRef.current = saveFile; }, [saveFile]);

  const scheduleAutoSave = useCallback(() => {
    if (autoSaveMode !== AUTO_SAVE_MODES.afterDelay) return;
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => saveFileRef.current?.(), AUTO_SAVE_DELAY);
  }, [autoSaveMode]);

  // Load file content
  useEffect(() => {
    let cancelled = false;
    const loadFile = async () => {
      setLoading(true);
      setError("");
      const result = await fileSocket.readFile(filePath);
      if (cancelled) return;
      if (!result.success) { setError(result.error); setLoading(false); return; }
      originalContentRef.current = result.content;
      setContent(result.content);
      setLoaded(true);
      setLoading(false);
    };
    loadFile();
    return () => { cancelled = true; if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current); };
  }, [filePath, fileSocket]);

  const emitEditorState = useCallback((view) => {
    if (!view) return;
    const head = view.state.selection.main.head;
    const lineObj = view.state.doc.lineAt(head);
    onEditorStateChangeRef.current?.({
      line: lineObj.number,
      column: head - lineObj.from + 1,
      language: lang,
      encoding: "UTF-8",
    });
  }, [lang]);

  // Setup CodeMirror
  useEffect(() => {
    if (loading || content === null || !editorRef.current) return;

    const state = EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        ...(theme === "dark" ? [oneDark] : []),
        langExtension,
        ...(wordWrap ? [EditorView.lineWrapping] : []),
        search(),
        autocompletion(),
        closeBrackets(),
        keymap.of([...closeBracketsKeymap, ...completionKeymap, indentWithTab]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const currentContent = update.state.doc.toString();
            const changed = currentContent !== originalContentRef.current;
            setHasChanges(changed);
            onDirtyChangeRef.current?.(filePath, changed);
            if (changed) scheduleAutoSave();
          }
          if (update.selectionSet || update.docChanged) emitEditorState(update.view);
        }),
        EditorView.theme({
          "&": { height: "100%", fontSize: `${fontSize}px` },
          ".cm-scroller": { overflow: "auto" },
          ".cm-content": { minHeight: "100%" },
        }),
      ],
    });

    if (viewRef.current) viewRef.current.destroy();
    viewRef.current = new EditorView({ state, parent: editorRef.current });
    emitEditorState(viewRef.current);

    return () => { if (viewRef.current) { viewRef.current.destroy(); viewRef.current = null; } };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, content, filePath, theme, wordWrap, fontSize]);

  // Jump to line/column
  useEffect(() => {
    if (!viewRef.current || !line) return;
    const view = viewRef.current;
    const doc = view.state.doc;
    const targetLine = Math.max(1, Math.min(line, doc.lines));
    const lineObj = doc.line(targetLine);
    const targetColumn = column || 0;
    const position = lineObj.from + Math.min(targetColumn, lineObj.length);
    view.dispatch({ selection: { anchor: position, head: position }, scrollIntoView: true });
    view.focus();
  }, [line, column]);

  // Ctrl/Cmd+S
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); saveFileRef.current?.(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="h-full flex flex-col" style={{ background: "var(--bg-body)" }}>
      <div className="bg-surface border-b border-border px-3 py-1 flex items-center gap-2 text-xs">
        <span className="truncate flex-1 text-text-muted">{(filePath.split("/").pop() || "")}</span>
        {hasChanges && <span className="w-2 h-2 bg-yellow-400 rounded-full" title="Unsaved" />}
        {saving && <Icon name="loader2" size={12} className="animate-spin text-text-muted" />}
        {!hasChanges && !saving && loaded && <span className="text-green-400">Saved</span>}
        <button
          onClick={() => saveFile()}
          disabled={!hasChanges || saving}
          className={`px-2 py-0.5 rounded flex items-center gap-1 ${hasChanges && !saving ? "bg-brand-500 text-white" : "bg-surface-2 text-text-muted cursor-not-allowed"}`}
        >
          <Icon name="save" size={12} /> Save
        </button>
      </div>
      <div className="flex-1 min-h-0 relative">
        <div ref={editorRef} className={`h-full overflow-auto ${loading ? "hidden" : ""}`} />
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center text-text-muted text-sm">Loading…</div>
        )}
        {error && (
          <div className="absolute top-0 left-0 right-0 bg-red-500/20 border-b border-red-500/50 px-4 py-2 text-red-400 text-sm">{error}</div>
        )}
      </div>
    </div>
  );
}
