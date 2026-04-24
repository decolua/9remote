"use client";

import { create } from "zustand";
import { DEFAULT_LOCALE, LOCALE_STORAGE_KEY, SUPPORTED_LOCALES } from "../i18n/config.js";

const supportedCodes = SUPPORTED_LOCALES.map((l) => l.code);

// Detect initial locale: localStorage > navigator.language > DEFAULT_LOCALE
function detectLocale() {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  try {
    const saved = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (saved && supportedCodes.includes(saved)) return saved;
    const nav = (navigator.language || "").slice(0, 2).toLowerCase();
    if (supportedCodes.includes(nav)) return nav;
  } catch {}
  return DEFAULT_LOCALE;
}

export const useI18nStore = create((set) => ({
  locale: DEFAULT_LOCALE,
  hydrated: false,
  hydrate: () => set({ locale: detectLocale(), hydrated: true }),
  setLocale: (locale) => {
    if (!supportedCodes.includes(locale)) return;
    if (typeof window !== "undefined") {
      try { window.localStorage.setItem(LOCALE_STORAGE_KEY, locale); } catch {}
    }
    set({ locale });
  }
}));
