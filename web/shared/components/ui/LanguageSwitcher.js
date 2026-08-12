"use client";

import { useState } from "react";
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
        className={`flex items-center gap-1.5 bg-surface-2 hover:bg-surface-3 rounded-brand text-text text-sm px-2 py-1 transition-all duration-150 ease-out active:scale-[0.96] ${className}`}
        title={current.label}
      >
        <img
          src={`https://flagcdn.com/w40/${current.country}.png`}
          alt={current.label}
          className="w-[17px] h-[12px] object-cover rounded-[2px]"
          loading="lazy"
        />
        {showLabel && <span className="hidden sm:inline">{current.code.toUpperCase()}</span>}
      </button>
      <LanguageModal isOpen={open} onClose={() => setOpen(false)} />
    </>
  );
}
