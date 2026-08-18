"use client";

import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";

// Three answers, laid out the way every desktop OS lays them out: the safe default on
// the right and emphasised, the destructive one leftmost and quiet, Cancel between them.
// Three stacked buttons in three different colours reads as three warnings.
export default function UnsavedDialog({ isOpen, fileName, onSave, onDiscard, onCancel }) {
  const { t } = useI18n();
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
            onClick={() => { vibrate(); onDiscard(); }}
            className="px-3 py-2 text-[13px] text-text-muted hover:text-red-500 transition-colors"
          >
            {t("editor.discard")}
          </button>
          <div className="flex-1" />
          <button
            onClick={onCancel}
            className="px-4 py-2 text-[13px] text-text bg-surface-2 hover:bg-surface-3 rounded-brand transition-colors"
          >
            {t("common.cancel")}
          </button>
          <button
            onClick={() => { vibrate(); onSave(); }}
            autoFocus
            className="px-4 py-2 text-[13px] font-semibold text-white bg-brand-500 hover:bg-brand-600 rounded-brand transition-colors"
          >
            {t("editor.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
