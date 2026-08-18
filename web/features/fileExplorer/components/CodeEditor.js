"use client";

import { useEffect, useRef } from "react";
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
  STORAGE_KEYS,
  EDITOR_FONT_DEFAULT,
  EDITOR_FONT_COMPACT_MIN,
  EDITOR_FONT_COMPACT_DELTA,
  LANGUAGE_MAP
} from "../constants/fileExplorer.js";
import { DESKTOP_BREAKPOINT } from "@/features/terminal/constants/terminalConfig";
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

/**
 * The one CodeMirror instance in the app. Every editor surface — the mobile screen, the
 * desktop tab area, the panel beside a terminal — wraps this rather than building its
 * own, so a keymap or theme fix lands everywhere at once.
 *
 * Owns no file state: content comes in, changes go out. Loading, saving and the dirty
 * flag belong to useFileDocument, which every shell shares too.
 */
export default function CodeEditor({
  filePath,
  content,
  onTextChanged,
  onRegisterView,
  onSave,
  onCursorChange,
  line,
  column,
  compact = false,
  className = ""
}) {
  const { theme } = useTheme();
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const changedRef = useRef(onTextChanged);
  const cursorRef = useRef(onCursorChange);
  const saveRef = useRef(onSave);

  useEffect(() => { changedRef.current = onTextChanged; }, [onTextChanged]);
  useEffect(() => { cursorRef.current = onCursorChange; }, [onCursorChange]);
  useEffect(() => { saveRef.current = onSave; }, [onSave]);

  const [userFontSize] = usePersistedState(STORAGE_KEYS.editorFontSize, EDITOR_FONT_DEFAULT);
  const [wordWrap] = usePersistedState(STORAGE_KEYS.wordWrap, true);

  // The user's own size is the baseline: the docked panel steps down from it because it
  // is only ~420px wide, while a phone steps up — read at arm's length, nothing else
  // competing for the column.
  const isPhone = typeof window !== "undefined" && window.innerWidth < DESKTOP_BREAKPOINT;
  const fontSize = compact
    ? Math.max(EDITOR_FONT_COMPACT_MIN, userFontSize - EDITOR_FONT_COMPACT_DELTA)
    : userFontSize + (isPhone ? 1 : 0);

  const { extension: langExtension } = getLanguageInfo(filePath);

  useEffect(() => {
    if (content === null || content === undefined || !hostRef.current) return;

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
        keymap.of([
          // Save is a keystroke, not a timer — see useFileDocument.
          { key: "Mod-s", preventDefault: true, run: () => { saveRef.current?.(); return true; } },
          ...closeBracketsKeymap,
          ...completionKeymap,
          indentWithTab
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) changedRef.current?.(update.state.doc.toString());
          if (update.selectionSet || update.docChanged) {
            const head = update.state.selection.main.head;
            const lineObj = update.state.doc.lineAt(head);
            cursorRef.current?.({ line: lineObj.number, column: head - lineObj.from + 1 });
          }
        }),
        EditorView.theme({
          "&": { height: "100%", fontSize: `${fontSize}px` },
          ".cm-scroller": { overflow: "auto", lineHeight: compact ? "1.35" : "" },
          ".cm-content": { minHeight: "100%" },
          ".cm-gutters": compact ? { fontSize: `${Math.max(8, fontSize - 1)}px` } : {}
        })
      ]
    });

    viewRef.current?.destroy();
    viewRef.current = new EditorView({ state, parent: hostRef.current });
    onRegisterView?.(() => viewRef.current?.state.doc.toString() ?? null, viewRef.current);

    return () => {
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  // langExtension is derived from filePath; onRegisterView is a stable setter.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, filePath, theme, wordWrap, fontSize, compact]);

  // Jump to a line/column asked for from outside (a stack trace, a search hit).
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !line) return;
    const doc = view.state.doc;
    const targetLine = Math.max(1, Math.min(line, doc.lines));
    const lineObj = doc.line(targetLine);
    const pos = Math.min(lineObj.from + Math.max(0, (column || 1) - 1), lineObj.to);
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "center" })
    });
    view.focus();
  }, [line, column, content]);

  return <div ref={hostRef} className={`h-full w-full overflow-hidden ${className}`} />;
}
