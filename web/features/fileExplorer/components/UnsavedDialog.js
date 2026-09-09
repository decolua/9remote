"use client";

import { useEffect, useRef } from "react";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";
import { CornerDownLeft } from "@/shared/components/ui/Icon";

// Three answers, laid out the way every desktop OS lays them out: the safe default on
// the right and emphasised, the destructive one leftmost and quiet, Cancel between them.
// Three stacked buttons in three different colours reads as three warnings.
export default function UnsavedDialog({ isOpen, fileName, onSave, onDiscard, onCancel }) {
  const { t } = useI18n();
  const saveBtnRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return;
    const timer = requestAnimationFrame(() => {
      saveBtnRef.current?.focus();
    });
    return () => cancelAnimationFrame(timer);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel?.();
      } else if (e.key === "Enter") {
        if (document.activeElement?.tagName === "BUTTON" && document.activeElement !== saveBtnRef.current) return;
        e.preventDefault();
        e.stopPropagation();
        vibrate();
        onSave?.();
      } else if ((e.key === "d" || e.key === "D") && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        vibrate();
        onDiscard?.();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [isOpen, onCancel, onSave, onDiscard]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center px-4"
      style={{ paddingTop: "max(1rem, env(safe-area-inset-top))", paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
      onClick={onCancel}
    >
      <div className="absolute inset-0 bg-black/60" />
      <div className="relative card-elev w-full max-w-sm p-5" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-[15px] font-semibold text-text mb-1.5">
          {t("editor.unsavedTitle", { name: fileName || "" })}
        </h3>
        <p className="text-[13px] text-text-muted leading-snug mb-5">
          {t("editor.unsavedBody")}
        </p>

        <div className="flex items-center gap-2">
          <button
            onClick={() => { vibrate(); onDiscard?.(); }}
            className="px-3 py-2 text-[13px] text-text-muted hover:text-red-500 transition-colors flex items-center gap-1"
          >
            <span>{t("editor.discard")}</span>
            <kbd className="hidden sm:inline-flex items-center text-[10px] font-mono px-1 py-0.5 rounded bg-surface-3 text-text-muted leading-none">D</kbd>
          </button>
          <div className="flex-1" />
          <button
            onClick={onCancel}
            className="px-4 py-2 text-[13px] text-text bg-surface-2 hover:bg-surface-3 rounded-brand transition-colors flex items-center gap-1.5"
          >
            <span>{t("common.cancel")}</span>
            <kbd className="hidden sm:inline-flex items-center text-[10px] font-mono px-1 py-0.5 rounded bg-surface-3 text-text-muted leading-none">Esc</kbd>
          </button>
          <button
            ref={saveBtnRef}
            onClick={() => { vibrate(); onSave?.(); }}
            autoFocus
            className="px-4 py-2 text-[13px] font-semibold text-white bg-brand-500 hover:bg-brand-600 rounded-brand transition-colors flex items-center gap-1.5"
          >
            <span>{t("editor.save")}</span>
            <kbd className="hidden sm:inline-flex items-center justify-center w-4 h-4 rounded bg-white/20 text-white">
              <CornerDownLeft size={10} strokeWidth={2.5} />
            </kbd>
          </button>
        </div>
      </div>
    </div>
  );
}
