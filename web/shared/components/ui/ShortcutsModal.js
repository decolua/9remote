"use client";

import { useEffect } from "react";
import { X } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { SHORTCUT_ROWS, shortcutKeys, SHORTCUT_KEY_CLS } from "@/features/terminal/constants/shortcuts";

export default function ShortcutsModal({ isOpen, onClose }) {
  const { t } = useI18n();

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px] animate-in fade-in duration-200"
        onClick={onClose}
      />
      <div className="relative card-elev max-w-md w-full max-h-[90dvh] flex flex-col animate-in zoom-in-95 duration-200">
        <div className="px-5 py-4 flex items-center justify-between flex-shrink-0">
          <h3 className="text-lg font-semibold text-text">{t("shortcuts.title")}</h3>
          <button
            onClick={onClose}
            className="p-2 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-all duration-150 ease-out"
            aria-label={t("common.close")}
          >
            <X size={20} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto modal-scrollable px-5 pb-5">
          <ul className="flex flex-col divide-y divide-border-subtle/40">
            {SHORTCUT_ROWS.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between gap-4 py-2 first:pt-1">
                <span className="text-sm text-text min-w-0 truncate">{t(`shortcuts.${entry.id}`)}</span>
                <span className="inline-flex items-center gap-1 flex-shrink-0">
                  {shortcutKeys(entry).map((key) => (
                    <kbd key={key} className={SHORTCUT_KEY_CLS}>{key}</kbd>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
