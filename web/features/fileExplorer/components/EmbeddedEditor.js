"use client";

import { useState, useEffect, useRef, useCallback } from "react";
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
  LANGUAGE_MAP
} from "../constants/fileExplorer.js";
import { useTheme } from "@/shared/theme/ThemeProvider";
import { usePersistedState } from "@/shared/hooks/usePersistedState";

const languageExtensions = {
  javascript: javascript(),
  html: html(),
  css: css(),
  json: json(),
  markdown: markdown()
};

function getLanguageInfo(filePath) {
  const ext = "." + filePath.split(".").pop()?.toLowerCase();
  const lang = LANGUAGE_MAP[ext] || "plaintext";
  return { lang, extension: languageExtensions[lang] || [] };
}

export default function EmbeddedEditor({ filePath, fileSocket, workspace, onEditorStateChange, line, column, onDirtyChange }) {
  const { theme } = useTheme();
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

  const [autoSaveMode] = usePersistedState(STORAGE_KEYS.autoSaveMode, AUTO_SAVE_MODES.afterDelay);
  const [fontSize] = usePersistedState(STORAGE_KEYS.editorFontSize, EDITOR_FONT_DEFAULT);
  const [wordWrap] = usePersistedState(STORAGE_KEYS.wordWrap, true);

  const { lang, extension: langExtension } = getLanguageInfo(filePath);

  useEffect(() => { onEditorStateChangeRef.current = onEditorStateChange; }, [onEditorStateChange]);
  useEffect(() => { onDirtyChangeRef.current = onDirtyChange; }, [onDirtyChange]);

  // Save file
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
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("fileExplorer:fileSaved", { detail: { filePath } }));
      }
    } else {
      setError(result.error);
    }
  }, [filePath, fileSocket, saving]);

  const saveFileRef = useRef(saveFile);
  useEffect(() => { saveFileRef.current = saveFile; }, [saveFile]);

  // Schedule auto-save based on mode
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
      if (!result.success) {
        setError(result.error);
        setLoading(false);
        return;
      }
      originalContentRef.current = result.content;
      setContent(result.content);
      setLoading(false);
    };
    loadFile();
    return () => {
      cancelled = true;
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    };
  }, [filePath, fileSocket]);

  // Compute line/column from selection head
  const emitEditorState = useCallback((view) => {
    if (!view) return;
    const head = view.state.selection.main.head;
    const lineObj = view.state.doc.lineAt(head);
    onEditorStateChangeRef.current?.({
      line: lineObj.number,
      column: head - lineObj.from + 1,
      language: lang,
      encoding: "UTF-8"
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
          if (update.selectionSet || update.docChanged) {
            emitEditorState(update.view);
          }
        }),
        EditorView.theme({
          "&": { height: "100%", fontSize: `${fontSize}px` },
          ".cm-scroller": { overflow: "auto" },
          ".cm-content": { minHeight: "100%" }
        })
      ]
    });

    if (viewRef.current) viewRef.current.destroy();
    viewRef.current = new EditorView({ state, parent: editorRef.current });
    emitEditorState(viewRef.current);

    return () => {
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
    };
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

  // Listen save event from parent
  useEffect(() => {
    const handler = () => saveFileRef.current?.();
    window.addEventListener("fileExplorer:save", handler);
    return () => window.removeEventListener("fileExplorer:save", handler);
  }, []);

  // Auto-save on focus change (blur)
  useEffect(() => {
    if (autoSaveMode !== AUTO_SAVE_MODES.onFocusChange) return;
    const handler = () => { if (hasChanges) saveFileRef.current?.(); };
    window.addEventListener("blur", handler);
    return () => window.removeEventListener("blur", handler);
  }, [autoSaveMode, hasChanges]);

  return (
    <div className="h-full relative">
      <div ref={editorRef} className={`h-full overflow-auto ${loading ? "hidden" : ""}`} />
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center text-text-muted text-sm">
          Loading...
        </div>
      )}
      {error && (
        <div className="absolute top-0 left-0 right-0 bg-red-500/20 border-b border-red-500/50 px-4 py-2 text-red-400 text-sm">
          {error}
        </div>
      )}
    </div>
  );
}
