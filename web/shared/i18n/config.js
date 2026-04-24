// i18n configuration - single source of truth for supported locales
// Add new locales here + create matching file in ./locales/
export const SUPPORTED_LOCALES = [
  { code: "en", label: "English", flag: "🇺🇸" },
  { code: "vi", label: "Tiếng Việt", flag: "🇻🇳" }
];

export const DEFAULT_LOCALE = "en";

export const LOCALE_STORAGE_KEY = "9remote_locale";
