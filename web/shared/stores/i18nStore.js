"use client";

import { create } from "zustand";
import { DEFAULT_LOCALE, LOCALE_STORAGE_KEY, SUPPORTED_LOCALES } from "../i18n/config.js";
import en from "../i18n/locales/en.js";

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

// Locale dictionaries are lazy: only `en` (the fallback, also what SSR renders) ships in
// the main bundle; the other 22 load on demand as separate chunks. Until one arrives,
// `t()` keeps resolving against en — same behaviour as an untranslated key.
const inflight = new Map();
const ensureDict = (locale, set) => {
  if (!supportedCodes.includes(locale) || locale === DEFAULT_LOCALE) return;
  if (useI18nStore.getState().dicts[locale] || inflight.has(locale)) return;
  const load = import(`../i18n/locales/${locale}.js`).then((mod) => {
    inflight.delete(locale);
    const dict = mod.default;
    // Another setLocale may have run while loading — merge, never replace
    set((state) => ({ dicts: { ...state.dicts, [locale]: dict } }));
    return dict;
  }).catch(() => { inflight.delete(locale); });
  inflight.set(locale, load);
};

export const useI18nStore = create((set) => ({
  locale: DEFAULT_LOCALE,
  dicts: { [DEFAULT_LOCALE]: en },
  hydrated: false,
  hydrate: () => {
    const locale = detectLocale();
    ensureDict(locale, set);
    set({ locale, hydrated: true });
  },
  setLocale: (locale) => {
    if (!supportedCodes.includes(locale)) return;
    if (typeof window !== "undefined") {
      try { window.localStorage.setItem(LOCALE_STORAGE_KEY, locale); } catch {}
    }
    ensureDict(locale, set);
    set({ locale });
  }
}));
