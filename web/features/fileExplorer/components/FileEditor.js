"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { undo, redo, cursorLineUp, cursorLineDown, cursorCharLeft, cursorCharRight } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import { AUTO_SAVE_DELAY, LANGUAGE_MAP } from "../constants/fileExplorer.js";
import { ChevronLeft, Save, Loader2, GitBranch } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { useTheme } from "@/shared/theme/ThemeProvider";

const languageExtensions = {
  javascript: javascript(),
  html: html(),
  css: css(),
  json: json(),
  markdown: markdown()
};

function getLanguageExtension(filePath) {
  const ext = "." + filePath.split(".").pop()?.toLowerCase();
  const lang = LANGUAGE_MAP[ext];
  return languageExtensions[lang] || [];
}

export default function FileEditor({ filePath, fileSocket, onBack, line, column, workspace }) {
  const { t } = useI18n();
  const { theme } = useTheme();
  const editorRef = useRef(null);
  const viewRef = useRef(null);
  const textInputRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [content, setContent] = useState(null);
  const [error, setError] = useState("");
  const [hasChanges, setHasChanges] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedIndicator, setSavedIndicator] = useState(false);
  const [gitStatus, setGitStatus] = useState(null);
  const [showDiff, setShowDiff] = useState(false);
  const [diffContent, setDiffContent] = useState("");
  const [loadingDiff, setLoadingDiff] = useState(false);
  const originalContentRef = useRef("");
  const autoSaveTimerRef = useRef(null);
  
  // Keyboard state
  const [ctrlPressed, setCtrlPressed] = useState(false);
  const [altPressed, setAltPressed] = useState(false);
  const [showTextInput, setShowTextInput] = useState(false);
  const [textInput, setTextInput] = useState("");

  const fileName = filePath.split("/").pop();

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
      setSavedIndicator(true);
      setTimeout(() => setSavedIndicator(false), 2000);
    } else {
      setError(result.error);
    }
  }, [filePath, fileSocket, saving]);

  // Auto-save with debounce
  const scheduleAutoSave = useCallback(() => {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
    }
    autoSaveTimerRef.current = setTimeout(saveFile, AUTO_SAVE_DELAY);
  }, [saveFile]);

  // Load file content
  useEffect(() => {
    const loadFile = async () => {
      setLoading(true);
      setError("");

      const result = await fileSocket.readFile(filePath);

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
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
      }
    };
  }, [filePath, fileSocket]);

  // Check git status for this file
  useEffect(() => {
    if (!workspace || !filePath) return;

    const checkGitStatus = async () => {
      const result = await fileSocket.gitFileStatus(workspace, filePath);
      if (result.success && result.status) {
        setGitStatus(result);
      } else {
        setGitStatus(null);
      }
    };

    checkGitStatus();
  }, [filePath, workspace, fileSocket]);

  // Show git diff
  const handleShowDiff = async () => {
    if (!gitStatus || !workspace) return;
    
    setLoadingDiff(true);
    const result = await fileSocket.gitDiff(workspace, gitStatus.file, gitStatus.status);
    setLoadingDiff(false);
    
    if (result.success) {
      setDiffContent(result.diff);
      setShowDiff(true);
    }
  };

  // Setup editor after content is loaded and ref is available
  useEffect(() => {
    if (loading || content === null || !editorRef.current) return;

    // Create editor
    const state = EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        ...(theme === "dark" ? [oneDark] : []),
        getLanguageExtension(filePath),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const currentContent = update.state.doc.toString();
            const changed = currentContent !== originalContentRef.current;
            setHasChanges(changed);
            if (changed) scheduleAutoSave();
          }
        }),
        EditorView.theme({
          "&": {
            height: "100%",
            fontSize: "14px"
          },
          ".cm-scroller": {
            overflow: "auto"
          },
          ".cm-content": {
            minHeight: "100%"
          }
        })
      ]
    });

    if (viewRef.current) {
      viewRef.current.destroy();
    }

    viewRef.current = new EditorView({
      state,
      parent: editorRef.current
    });

    return () => {
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, content, filePath, theme]);

  // Jump to line/column when line prop changes
  useEffect(() => {
    if (!viewRef.current || !line) return;

    const view = viewRef.current;
    const doc = view.state.doc;

    // Clamp line number to valid range (1-based to 0-based conversion)
    const targetLine = Math.max(1, Math.min(line, doc.lines));
    const lineObj = doc.line(targetLine);

    // Calculate position with column, clamp column to line length
    const targetColumn = column || 0;
    const position = lineObj.from + Math.min(targetColumn, lineObj.length);

    // Dispatch selection and scroll into view
    view.dispatch({
      selection: { anchor: position, head: position },
      scrollIntoView: true
    });

    view.focus();
  }, [line, column]);

  // Insert text at cursor
  const insertText = (text) => {
    if (!viewRef.current) return;
    
    const view = viewRef.current;
    const { from, to } = view.state.selection.main;
    
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length }
    });
    
    view.focus();
  };

  // Dispatch keyboard event with modifiers to CodeMirror
  const dispatchKey = (key, { ctrl = false, alt = false } = {}) => {
    if (!viewRef.current) return;
    
    const view = viewRef.current;
    const event = new KeyboardEvent("keydown", {
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      ctrlKey: ctrl || ctrlPressed,
      altKey: alt || altPressed,
      metaKey: ctrl || ctrlPressed, // For macOS compatibility
      bubbles: true,
      cancelable: true
    });
    
    view.contentDOM.dispatchEvent(event);
    view.focus();
    
    // Reset modifiers after dispatch
    setCtrlPressed(false);
    setAltPressed(false);
  };

  // Handle back with unsaved changes
  const handleBack = async () => {
    if (hasChanges) {
      await saveFile();
    }
    onBack();
  };

  return (
    <div className="h-full bg-bg flex flex-col">
      {/* Header */}
      <div className="bg-surface px-4 py-3 flex items-center gap-2 flex-shrink-0">
        <button
          onClick={() => { vibrate(); handleBack(); }}
          className="p-2 bg-surface-2 hover:bg-surface-3 text-text rounded-brand transition-all duration-150 ease-out active:scale-[0.96]"
        >
          <ChevronLeft size={20} />
        </button>

        <div className="flex-1 flex items-center gap-2 min-w-0">
          <span className="text-text font-medium truncate">{fileName}</span>
          {hasChanges && (
            <span className="w-2 h-2 bg-yellow-400 rounded-full flex-shrink-0" title={t("editor.unsaved")} />
          )}
          {savedIndicator && (
            <span className="text-green-400 text-xs flex-shrink-0">{t("editor.saved")}</span>
          )}
        </div>

        {/* Git button - only show if file has git changes */}
        {gitStatus && (
          <button
            onClick={() => { vibrate(); handleShowDiff(); }}
            disabled={loadingDiff}
            className="p-2 bg-surface-2 hover:bg-surface-3 text-orange-400 rounded-brand transition-all duration-150 ease-out active:scale-[0.96]"
            title={`Git: ${gitStatus.status === "M" ? t("editor.statusModified") : gitStatus.status === "A" ? t("editor.statusAdded") : gitStatus.status === "?" ? t("editor.statusUntracked") : gitStatus.status}`}
          >
            {loadingDiff ? <Loader2 className="animate-spin" size={16} /> : <GitBranch size={16} />}
          </button>
        )}

        <button
          onClick={() => { vibrate(); saveFile(); }}
          disabled={!hasChanges || saving}
          className={`px-3 py-2 rounded-brand transition-all duration-150 ease-out flex items-center gap-1 ${
            hasChanges && !saving
              ? "bg-brand-500 hover:bg-brand-600 text-white shadow-sm active:scale-[0.97]"
              : "bg-surface-2 text-text-muted cursor-not-allowed"
          }`}
        >
          {saving ? (
            <Loader2 className="animate-spin" size={16} />
          ) : (
            <Save size={16} />
          )}
          <span className="hidden sm:inline">{t("editor.save")}</span>
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-500/20 border-b border-red-500/50 px-4 py-2 text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Editor */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {loading && (
          <div className="h-full flex items-center justify-center text-text-muted">
            {t("common.loading")}
          </div>
        )}
        <div 
          ref={editorRef} 
          className={`h-full overflow-auto ${loading ? "hidden" : ""}`} 
        />
      </div>

      {/* Git Diff Modal */}
      {showDiff && (
        <div 
          className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4"
          onClick={() => setShowDiff(false)}
        >
          <div 
            className="card-elev w-full max-w-3xl max-h-[80vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="bg-surface-2 px-4 py-3 flex items-center justify-between">
              <span className="text-text font-medium">{t("editor.gitDiff")}: {fileName}</span>
              <button
                onClick={() => setShowDiff(false)}
                className="p-1 hover:bg-surface-2 rounded transition-colors text-text-muted hover:text-text"
              >
                ✕
              </button>
            </div>
            <pre className="flex-1 overflow-auto p-4 text-sm font-mono whitespace-pre-wrap">
              {diffContent.split("\n").map((line, i) => {
                let className = "text-text-muted";
                if (line.startsWith("+") && !line.startsWith("+++")) className = "text-green-400";
                else if (line.startsWith("-") && !line.startsWith("---")) className = "text-red-400";
                else if (line.startsWith("@@")) className = "text-blue-400";
                return <div key={i} className={className}>{line}</div>;
              })}
            </pre>
          </div>
        </div>
      )}

      {/* Text Input Panel */}
      <div className={`bg-surface transition-all duration-300 overflow-hidden ${showTextInput ? "max-h-24 opacity-100" : "max-h-0 opacity-0"}`}>
        <div className="p-2 flex gap-2 items-center">
          <textarea
            ref={textInputRef}
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            placeholder={t("editor.typeText")}
            rows={1}
            className="w-full px-3 py-2 bg-surface-2 rounded text-text text-base placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-brand-500/40 transition-all duration-150 ease-out resize-none"
          />
          <button
            onClick={() => {
              vibrate();
              if (textInput.trim()) {
                insertText(textInput);
                setTextInput("");
              }
              setShowTextInput(false);
            }}
            disabled={!textInput.trim()}
            className="px-4 py-2 bg-brand-500 hover:bg-brand-600 disabled:bg-surface-2 disabled:opacity-50 text-white text-sm font-medium rounded transition-all duration-150 ease-out active:scale-[0.97] shadow-sm flex-shrink-0"
          >
            {t("editor.insert")}
          </button>
        </div>
      </div>

      {/* Code shortcuts toolbar - 2 rows */}
      <div className="bg-surface border-t border-border px-2 py-2 flex flex-col gap-1 flex-shrink-0">
        {/* Row 1: Navigation + modifiers */}
        <div className="flex gap-1">
          {[
            { label: "Esc", key: "Escape" },
            { label: "Tab", key: "Tab" },
            { label: "←", key: "ArrowLeft" },
            { label: "→", key: "ArrowRight" },
            { label: "↑", key: "ArrowUp" },
            { label: "↓", key: "ArrowDown" },
            { label: "Ctrl", modifier: "ctrl" },
            { label: "Opt", modifier: "alt" }
          ].map((item) => (
            <button
              key={item.label}
              onClick={() => {
                vibrate();
                if (item.modifier === "ctrl") {
                  setCtrlPressed(!ctrlPressed);
                  setAltPressed(false);
                } else if (item.modifier === "alt") {
                  setAltPressed(!altPressed);
                  setCtrlPressed(false);
                } else {
                  dispatchKey(item.key);
                }
              }}
              className={`flex-1 py-2 text-text text-xs rounded-brand transition-all duration-200 border ${
                (item.modifier === "ctrl" && ctrlPressed) || (item.modifier === "alt" && altPressed)
                  ? "bg-brand-500 border-brand-400 shadow-md shadow-brand-500/30"
                  : "bg-surface-2 hover:bg-surface-2 border-border hover:border-brand-500"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        {/* Row 2: Actions + code shortcuts + text input */}
        <div className="flex gap-1">
          {[
            { label: "Undo", key: "z", ctrl: true },
            { label: "Redo", key: "y", ctrl: true },
            { label: "{}", text: "{}" },
            { label: "()", text: "()" },
            { label: "[]", text: "[]" },
            { label: "\"\"", text: "\"\"" },
            { label: "=>", text: " => " },
            { label: "Aa", toggleTextInput: true }
          ].map((item) => (
            <button
              key={item.label}
              onClick={() => {
                vibrate();
                if (item.toggleTextInput) {
                  setShowTextInput(!showTextInput);
                  if (!showTextInput) {
                    setTimeout(() => textInputRef.current?.focus(), 350);
                  }
                } else if (item.text) {
                  insertText(item.text);
                } else if (item.key) {
                  dispatchKey(item.key, { ctrl: item.ctrl, alt: item.alt });
                }
              }}
              className={`flex-1 py-2 text-text text-xs rounded-brand transition-all duration-200 border ${
                item.toggleTextInput && showTextInput
                  ? "bg-brand-500 border-brand-400 shadow-md shadow-brand-500/30"
                  : "bg-surface-2 hover:bg-surface-2 border-border hover:border-brand-500"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
