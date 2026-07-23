"use client";

import { useEffect, useRef, useState } from "react";
import { Copy, X, Check, Trash2 } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";
import { useSessionNote } from "@/features/terminal/hooks/useSessionNote";

// Overlay editor for a terminal session's note.
// `appendOnOpen` (string|null): if set, append to the note once on open (from selection menu).
export default function NotePanel({ socket, sessionId, appendOnOpen, onClose }) {
  const { t } = useI18n();
  const { text, setText, loaded } = useSessionNote(socket, sessionId);
  const appendedRef = useRef(false);
  const [copied, setCopied] = useState(false);

  // Append selection text once after load
  useEffect(() => {
    if (!loaded || appendedRef.current) return;
    if (appendOnOpen) {
      // Ensure the append starts on a new line: if note has content not ending in newline,
      // finish the current line first (don't append mid-line).
      const sep = text && !text.endsWith("\n") ? "\n" : "";
      const next = `${text}${sep}${appendOnOpen}`;
      setText(next);
    }
    appendedRef.current = true;
  }, [loaded, appendOnOpen, text, setText]);

  const handleCopy = async () => {
    vibrate();
    try {
      await navigator.clipboard?.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  };

  const handleClear = () => {
    vibrate();
    setText("");
  };

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
      onMouseDown={(e) => { e.preventDefault(); onClose(); }}
    >
      <div
        className="card-elev w-full max-w-lg h-[70vh] flex flex-col overflow-hidden"
        onMouseDown={(e) => { e.stopPropagation(); }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-surface">
          <span className="text-text text-sm font-medium">{t("note.title")}</span>
          <div className="flex items-center gap-1">
            <button onClick={handleCopy} disabled={!text}
              className="p-2 hover:bg-surface-2 text-text rounded-brand transition-colors disabled:opacity-40"
              title={t("note.copy")}>
              {copied ? <Check size={16} className="text-green-400" /> : <Copy size={16} />}
            </button>
            <button onClick={handleClear} disabled={!text}
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
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("note.placeholder")}
          autoFocus
          className="flex-1 w-full resize-none bg-transparent text-text text-sm p-4 outline-none placeholder:text-text-muted"
        />
      </div>
    </div>
  );
}
