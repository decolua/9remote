"use client";

import { useEffect, useMemo } from "react";
import { useI18nStore } from "../stores/i18nStore.js";
import { LOCALES } from "./locales/index.js";
import { DEFAULT_LOCALE } from "./config.js";

// Resolve "a.b.c" dot-path inside a nested dict
function resolvePath(dict, path) {
  if (!dict) return undefined;
  return path.split(".").reduce((acc, key) => (acc == null ? acc : acc[key]), dict);
}

// Replace {var} placeholders with provided params
function interpolate(template, params) {
  if (typeof template !== "string" || !params) return template;
  return template.replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? params[k] : `{${k}}`));
}

export function useI18n() {
  const { locale, hydrated, hydrate, setLocale } = useI18nStore();

  // Hydrate locale from localStorage/navigator after mount (avoid SSR mismatch)
  useEffect(() => { if (!hydrated) hydrate(); }, [hydrated, hydrate]);

  const t = useMemo(() => {
    const dict = LOCALES[locale] || LOCALES[DEFAULT_LOCALE];
    const fallback = LOCALES[DEFAULT_LOCALE];
    return (key, params) => {
      const value = resolvePath(dict, key) ?? resolvePath(fallback, key) ?? key;
      return interpolate(value, params);
    };
  }, [locale]);

  return { t, locale, setLocale, hydrated };
}
