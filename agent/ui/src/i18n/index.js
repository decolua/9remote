import { useState, useEffect } from "preact/hooks";
import { LOCALES } from "./locales";
import { DEFAULT_LOCALE, STORAGE_KEY } from "./config";

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

function detectLocale() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY) || localStorage.getItem("agentLocale");
    if (saved && LOCALES[saved]) return saved;
  } catch {}
  return DEFAULT_LOCALE;
}

// Module-level shared store so locale changes re-render every subscriber
let currentLocale = detectLocale();
const listeners = new Set();

function setLocale(next) {
  if (next === currentLocale || !LOCALES[next]) return;
  currentLocale = next;
  try { localStorage.setItem(STORAGE_KEY, next); } catch {}
  listeners.forEach((fn) => fn(next));
}

export function translate(locale, key, params) {
  const dict = LOCALES[locale] || LOCALES[DEFAULT_LOCALE];
  const fallback = LOCALES[DEFAULT_LOCALE];
  const value = resolvePath(dict, key) ?? resolvePath(fallback, key) ?? key;
  return interpolate(value, params);
}

export function useI18n() {
  const [locale, setLocaleLocal] = useState(currentLocale);

  useEffect(() => {
    const fn = (next) => setLocaleLocal(next);
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);

  const t = (key, params) => translate(locale, key, params);
  return { t, locale, setLocale };
}
