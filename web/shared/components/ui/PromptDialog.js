"use client";

import { useI18n } from "@/shared/i18n";

// Shared text-prompt modal (rename flows): input + confirm/cancel. autoFocus during
// commit keeps focus inside the tap's user-gesture window, so mobile keyboards open.
export default function PromptDialog({ title, value, onChange, onSubmit, onClose, confirmLabel, cancelLabel, placeholder }) {
  const { t } = useI18n();
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
            className="flex-1 py-2 text-sm font-semibold text-white bg-brand-500 rounded-brand disabled:opacity-40"
          >
            {confirmLabel ?? t("common.confirm")}
          </button>
          <button onClick={onClose} className="flex-1 py-2 text-sm text-text-muted bg-surface-2 rounded-brand">
            {cancelLabel ?? t("common.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
