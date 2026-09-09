"use client";

import { useEffect } from "react";
import { useI18n } from "@/shared/i18n";
import { CornerDownLeft } from "@/shared/components/ui/Icon";

// Shared text-prompt modal (rename flows): input + confirm/cancel. autoFocus during
// commit keeps focus inside the tap's user-gesture window, so mobile keyboards open.
export default function PromptDialog({ title, value, onChange, onSubmit, onClose, confirmLabel, cancelLabel, placeholder }) {
  const { t } = useI18n();

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose?.();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[85] flex items-center justify-center px-4"
      style={{ paddingTop: "max(1rem, env(safe-area-inset-top))", paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[4px] animate-in fade-in duration-150" />
      <div className="relative card-elev w-full max-w-xs p-5 animate-in zoom-in-95 duration-150" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-[14px] font-semibold text-text mb-3">{title}</h3>
        <input
          autoFocus
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onSubmit(); if (e.key === "Escape") onClose(); }}
          className="w-full bg-surface-2 border border-border-subtle rounded-brand px-3 py-2 text-sm text-text outline-none focus:border-brand-500"
        />
        <div className="flex gap-2 mt-4">
          <button
            onClick={onSubmit}
            disabled={!value?.trim()}
            className="flex-1 py-2 text-sm font-semibold text-white bg-brand-500 rounded-brand disabled:opacity-40 flex items-center justify-center gap-1.5"
          >
            <span>{confirmLabel ?? t("common.confirm")}</span>
            <kbd className="hidden sm:inline-flex items-center justify-center w-4 h-4 rounded bg-white/20 text-white">
              <CornerDownLeft size={10} strokeWidth={2.5} />
            </kbd>
          </button>
          <button onClick={onClose} className="flex-1 py-2 text-sm text-text-muted bg-surface-2 rounded-brand flex items-center justify-center gap-1.5">
            <span>{cancelLabel ?? t("common.cancel")}</span>
            <kbd className="hidden sm:inline-flex items-center text-[10px] font-mono px-1 py-0.5 rounded bg-surface-3 text-text-muted leading-none">Esc</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}
