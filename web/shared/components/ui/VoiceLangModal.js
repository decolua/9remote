"use client";

import { useEffect } from "react";
import { X, Check } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { SUPPORTED_LOCALES } from "@/shared/i18n/config";
import { SPEECH_LANG } from "@/shared/hooks/useVoiceInput";
import { VOICE_FREE_STT_ENABLED } from "@/shared/lib/voiceStt";

// Only locales with a known speech tag can be dictated.
const VOICE_LOCALES = SUPPORTED_LOCALES.filter((l) => SPEECH_LANG[l.code]);

export default function VoiceLangModal({ isOpen, value, onSelect, onClose }) {
  const { t } = useI18n();

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSelect = (code) => {
    vibrate();
    onSelect(code);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px] animate-in fade-in duration-200"
        onClick={onClose}
      />
      <div className="relative card-elev max-w-lg w-full max-h-[90dvh] flex flex-col animate-in zoom-in-95 duration-200">
        <div className="px-5 py-4 flex items-center justify-between flex-shrink-0">
          <h3 className="text-lg font-semibold text-text">{t("voice.language")}</h3>
          <button
            onClick={onClose}
            className="p-2 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-all duration-150 ease-out"
            aria-label={t("common.close")}
          >
            <X size={20} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto modal-scrollable p-3">
          {VOICE_FREE_STT_ENABLED && (
            <button
              onClick={() => handleSelect("auto")}
              className={`w-full px-2 py-2 mb-2 rounded-brand flex items-center gap-2 transition-all duration-150 ease-out active:scale-[0.97] ${
                value === "auto" ? "bg-brand-500 text-white dark:bg-white dark:text-black" : "text-text hover:bg-surface-2"
              }`}
            >
              <span className="w-[17px] text-center flex-shrink-0 text-sm">🌐</span>
              <span className="flex-1 text-sm font-medium text-left">Auto detect</span>
              {value === "auto" && <Check size={14} className="flex-shrink-0" />}
            </button>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {VOICE_LOCALES.map((l) => {
              const active = l.code === value;
              return (
                <button
                  key={l.code}
                  onClick={() => handleSelect(l.code)}
                  className={`px-2 py-2 rounded-brand flex items-center gap-2 transition-all duration-150 ease-out active:scale-[0.97] min-w-0 ${
                    active ? "bg-brand-500 text-white dark:bg-white dark:text-black" : "text-text hover:bg-surface-2"
                  }`}
                >
                  <img src={`https://flagcdn.com/w40/${l.country}.png`} alt={l.label} className="w-[17px] h-[12px] object-cover rounded-[2px] flex-shrink-0" loading="lazy" />
                  <span className="flex-1 text-sm font-medium truncate text-left">{l.label}</span>
                  {active && <Check size={14} className="flex-shrink-0" />}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
