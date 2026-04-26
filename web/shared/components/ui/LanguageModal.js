"use client";

import { useEffect } from "react";
import { X, Check } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { SUPPORTED_LOCALES } from "@/shared/i18n/config";

export default function LanguageModal({ isOpen, onClose }) {
  const { t, locale, setLocale } = useI18n();

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSelect = (code) => {
    vibrate();
    setLocale(code);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px] animate-in fade-in duration-200"
        onClick={onClose}
      />
      <div className="relative card-elev max-w-md w-full max-h-[80vh] flex flex-col animate-in zoom-in-95 duration-200">
        <div className="px-5 py-4 flex items-center justify-between flex-shrink-0">
          <h3 className="text-lg font-semibold text-text">{t("menu.language")}</h3>
          <button
            onClick={onClose}
            className="p-2 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-all duration-150 ease-out"
            aria-label={t("common.close")}
          >
            <X size={20} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto modal-scrollable p-2">
          {SUPPORTED_LOCALES.map((l) => {
            const active = l.code === locale;
            return (
              <button
                key={l.code}
                onClick={() => handleSelect(l.code)}
                className={`w-full px-4 py-3 rounded-brand text-left flex items-center gap-3 transition-all duration-150 ease-out active:scale-[0.99] ${
                  active ? "bg-brand-500 text-white" : "text-text hover:bg-surface-2"
                }`}
              >
                <span className="text-2xl flex-shrink-0">{l.flag}</span>
                <span className="flex-1 font-medium">{l.label}</span>
                {active && <Check size={20} />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
