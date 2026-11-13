"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { SHORTCUT_ROWS, shortcutKeys, SHORTCUT_KEY_CLS } from "@/features/terminal/constants/shortcuts";

export default function ShortcutsModal({ isOpen, onClose }) {
  const { t } = useI18n();
  const closeBtnRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return;

    // Disengage focus from terminal xterm and bring it to the modal
    document.activeElement?.blur?.();
    const timer = requestAnimationFrame(() => {
      closeBtnRef.current?.focus();
    });

    const handleEscape = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };

    window.addEventListener("keydown", handleEscape, true);
    return () => {
      cancelAnimationFrame(timer);
      window.removeEventListener("keydown", handleEscape, true);
    };
  }, [isOpen, onClose]);

  if (!isOpen || typeof document === "undefined") return null;

  // Portaled: opened from the drawer panel, whose slide-in animation leaves a
  // transform behind — a fixed overlay would be jailed inside that panel.
  return createPortal(
    <div className="modal-overlay z-[60]">
      <div
        className="absolute inset-0 scrim fade-in"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className="relative card-elev max-w-md w-full my-auto flex flex-col pop-in outline-none"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 flex items-center justify-between flex-shrink-0">
          <h3 className="text-lg font-semibold text-text">{t("shortcuts.title")}</h3>
          <button
            ref={closeBtnRef}
            onClick={onClose}
            className="p-2 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-all duration-150 ease-out focus:outline-none focus:ring-2 focus:ring-brand-500/40"
            aria-label={t("common.close")}
          >
            <X size={20} />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto modal-scrollable px-5 pb-5">
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
    </div>,
    document.body
  );
}
