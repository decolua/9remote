"use client";

import { useState } from "react";
import { Globe } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { SUPPORTED_LOCALES } from "@/shared/i18n/config";
import LanguageModal from "./LanguageModal";

// Compact button that opens LanguageModal - reusable in login, header, etc.
export default function LanguageSwitcher({ className = "", showLabel = true }) {
  const { locale } = useI18n();
  const [open, setOpen] = useState(false);
  const current = SUPPORTED_LOCALES.find((l) => l.code === locale) || SUPPORTED_LOCALES[0];

  return (
    <>
      <button
        onClick={() => { vibrate(); setOpen(true); }}
        className={`flex items-center gap-1.5 bg-dark-700 border border-dark-400 hover:border-brand-500 rounded-brand text-white text-sm px-2 py-1 transition-colors ${className}`}
        title={current.label}
      >
        <Globe size={14} className="text-brand-500" />
        <span>{current.flag}</span>
        {showLabel && <span className="hidden sm:inline">{current.code.toUpperCase()}</span>}
      </button>
      <LanguageModal isOpen={open} onClose={() => setOpen(false)} />
    </>
  );
}
