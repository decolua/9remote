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
import { AUTO_SAVE_DELAY, LANGUAGE_MAP } from "../constants/fileExplorer.js";
import { ChevronLeft, Save, Loader2 } from "@/shared/components/ui/Icon";

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

export default function FileEditor({ filePath, fileSocket, onBack }) {
  const editorRef = useRef(null);
  const viewRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [content, setContent] = useState(null);
  const [error, setError] = useState("");
  const [hasChanges, setHasChanges] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedIndicator, setSavedIndicator] = useState(false);
  const originalContentRef = useRef("");
  const autoSaveTimerRef = useRef(null);

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

  // Setup editor after content is loaded and ref is available
  useEffect(() => {
    if (loading || content === null || !editorRef.current) return;

    // Create editor
    const state = EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        oneDark,
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
  }, [loading, content, filePath]);

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

  // Handle back with unsaved changes
  const handleBack = async () => {
    if (hasChanges) {
      await saveFile();
    }
    onBack();
  };

  return (
    <div className="h-full bg-dark-700 flex flex-col">
      {/* Header */}
      <div className="bg-dark-600 border-b border-dark-400 px-4 py-3 flex items-center gap-2 flex-shrink-0">
        <button
          onClick={handleBack}
          className="p-2 bg-dark-500 hover:bg-dark-400 text-white rounded-brand transition-all duration-200 border border-dark-400 hover:border-brand-500"
        >
          <ChevronLeft size={20} />
        </button>

        <div className="flex-1 flex items-center gap-2 min-w-0">
          <span className="text-white font-medium truncate">{fileName}</span>
          {hasChanges && (
            <span className="w-2 h-2 bg-yellow-400 rounded-full flex-shrink-0" title="Unsaved changes" />
          )}
          {savedIndicator && (
            <span className="text-green-400 text-xs flex-shrink-0">Saved</span>
          )}
        </div>

        <button
          onClick={saveFile}
          disabled={!hasChanges || saving}
          className={`px-3 py-2 rounded-brand transition-all duration-200 flex items-center gap-1 ${
            hasChanges && !saving
              ? "bg-brand-500 hover:bg-brand-600 text-white shadow-lg shadow-brand-500/20"
              : "bg-dark-500 text-dark-200 cursor-not-allowed"
          }`}
        >
          {saving ? (
            <Loader2 className="animate-spin" size={16} />
          ) : (
            <Save size={16} />
          )}
          <span className="hidden sm:inline">Save</span>
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
          <div className="h-full flex items-center justify-center text-dark-100">
            Loading...
          </div>
        )}
        <div 
          ref={editorRef} 
          className={`h-full overflow-auto ${loading ? "hidden" : ""}`} 
        />
      </div>

      {/* Code shortcuts toolbar */}
      <div className="bg-dark-600 border-t border-dark-400 px-2 py-2 flex gap-1 overflow-x-auto flex-shrink-0">
        {[
          { label: "Tab", text: "  " },
          { label: "{}", text: "{}" },
          { label: "()", text: "()" },
          { label: "[]", text: "[]" },
          { label: "\"\"", text: "\"\"" },
          { label: "''", text: "''" },
          { label: "``", text: "``" },
          { label: "=>", text: " => " },
          { label: ";", text: ";" },
          { label: ":", text: ": " }
        ].map((item) => (
          <button
            key={item.label}
            onClick={() => insertText(item.text)}
            className="px-3 py-2 bg-dark-500 hover:bg-dark-400 text-white text-sm rounded-brand transition-all duration-200 whitespace-nowrap border border-dark-400 hover:border-brand-500"
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}
