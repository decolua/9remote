"use client";

import { useRef, useState } from "react";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";

// A phone keyboard has no Esc, no Tab, no arrows, and no way to hold Ctrl — all of which
// a code editor needs. This bar supplies them, plus the bracket pairs that are slowest to
// type on a touch keyboard.
const NAV_KEYS = [
  { label: "Esc", key: "Escape" },
  { label: "Tab", key: "Tab" },
  { label: "←", key: "ArrowLeft" },
  { label: "→", key: "ArrowRight" },
  { label: "↑", key: "ArrowUp" },
  { label: "↓", key: "ArrowDown" },
  { label: "Ctrl", modifier: "ctrl" },
  { label: "Opt", modifier: "alt" }
];

const EDIT_KEYS = [
  { label: "Undo", key: "z", ctrl: true },
  { label: "Redo", key: "y", ctrl: true },
  { label: "{}", text: "{}" },
  { label: "()", text: "()" },
  { label: "[]", text: "[]" },
  { label: "\"\"", text: "\"\"" },
  { label: "=>", text: " => " },
  { label: "Aa", toggleTextInput: true }
];

export default function EditorKeyBar({ viewRef }) {
  const { t } = useI18n();
  const [ctrlPressed, setCtrlPressed] = useState(false);
  const [altPressed, setAltPressed] = useState(false);
  const [showTextInput, setShowTextInput] = useState(false);
  const [textInput, setTextInput] = useState("");
  const textInputRef = useRef(null);

  const insertText = (text) => {
    const view = viewRef.current;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
    view.focus();
  };

  // Synthesised rather than dispatched through CodeMirror's API: the keymap already binds
  // these, so replaying the event keeps one source of truth for what each key does.
  const dispatchKey = (key, { ctrl = false, alt = false } = {}) => {
    const view = viewRef.current;
    if (!view) return;
    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", {
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      ctrlKey: ctrl || ctrlPressed,
      altKey: alt || altPressed,
      metaKey: ctrl || ctrlPressed,
      bubbles: true,
      cancelable: true
    }));
    view.focus();
    setCtrlPressed(false);
    setAltPressed(false);
  };

  const keyCls = (active) =>
    `flex-1 py-2 text-text text-xs rounded-brand transition-all duration-200 border ${
      active
        ? "bg-brand-500 border-brand-400 shadow-md shadow-brand-500/30"
        : "bg-surface-2 hover:bg-surface-2 border-border hover:border-brand-500"
    }`;

  return (
    <>
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
              if (textInput.trim()) { insertText(textInput); setTextInput(""); }
              setShowTextInput(false);
            }}
            disabled={!textInput.trim()}
            className="px-4 py-2 bg-brand-500 hover:bg-brand-600 disabled:bg-surface-2 disabled:opacity-50 text-white text-sm font-medium rounded transition-all duration-150 ease-out active:scale-[0.97] shadow-sm flex-shrink-0"
          >
            {t("editor.insert")}
          </button>
        </div>
      </div>

      <div
        className="bg-surface border-t border-border px-2 pt-2 pb-safe flex flex-col gap-1 flex-shrink-0"
      >
        <div className="flex gap-1">
          {NAV_KEYS.map((item) => (
            <button
              key={item.label}
              onClick={() => {
                vibrate();
                if (item.modifier === "ctrl") { setCtrlPressed((v) => !v); setAltPressed(false); }
                else if (item.modifier === "alt") { setAltPressed((v) => !v); setCtrlPressed(false); }
                else dispatchKey(item.key);
              }}
              className={keyCls(
                (item.modifier === "ctrl" && ctrlPressed) || (item.modifier === "alt" && altPressed)
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="flex gap-1">
          {EDIT_KEYS.map((item) => (
            <button
              key={item.label}
              onClick={() => {
                vibrate();
                if (item.toggleTextInput) {
                  setShowTextInput((v) => !v);
                  if (!showTextInput) setTimeout(() => textInputRef.current?.focus(), 350);
                } else if (item.text) {
                  insertText(item.text);
                } else if (item.key) {
                  dispatchKey(item.key, { ctrl: item.ctrl, alt: item.alt });
                }
              }}
              className={keyCls(item.toggleTextInput && showTextInput)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
