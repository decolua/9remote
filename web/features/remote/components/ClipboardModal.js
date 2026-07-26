"use client";

import { useState } from "react";
import { X, ClipboardPaste, Check } from "@/shared/components/ui/Icon";

// Modal showing the host's current clipboard. Copy button = user gesture so
// navigator.clipboard.writeText succeeds (background/no-gesture writes are rejected).
export default function ClipboardModal({ text, onClose }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Silent fail — some browsers (iOS Safari) block even gesture-driven writes
      // without permission; user can still long-press to select the text manually.
    }
  };

  return (
    <div
      className="fixed inset-x-0 top-0 h-[var(--app-height,100dvh)] z-50 bg-black/60 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="card-elev max-w-lg w-full max-h-full flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <ClipboardPaste size={16} className="text-brand-400" />
            <h2 className="text-text text-base font-semibold">Clipboard</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-surface-2 text-text-muted hover:text-text transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-4 overflow-y-auto flex-1">
          <pre className="text-text text-sm whitespace-pre-wrap break-all bg-bg rounded p-3 font-mono min-h-[120px] max-h-[55dvh] overflow-y-auto scroll-thin">
            {text || ""}
          </pre>
        </div>

        <div className="flex justify-end gap-2 p-4 border-t border-border">
          <button
            onClick={copy}
            disabled={!text}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-brand bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white text-sm font-semibold transition-colors"
          >
            {copied ? <Check size={14} /> : <ClipboardPaste size={14} />}
            Copy
          </button>
        </div>
      </div>
    </div>
  );
}
