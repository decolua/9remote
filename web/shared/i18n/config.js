// i18n configuration - single source of truth for supported locales
// Add new locales here + create matching file in ./locales/
export const SUPPORTED_LOCALES = [
  { code: "en", label: "English", flag: "🇺🇸" },
  { code: "vi", label: "Tiếng Việt", flag: "🇻🇳" },
  { code: "zh", label: "中文", flag: "🇨🇳" },
  { code: "es", label: "Español", flag: "🇪🇸" },
  { code: "hi", label: "हिन्दी", flag: "🇮🇳" },
  { code: "ar", label: "العربية", flag: "🇸🇦" },
  { code: "pt", label: "Português", flag: "🇧🇷" },
  { code: "ru", label: "Русский", flag: "🇷🇺" },
  { code: "ja", label: "日本語", flag: "🇯🇵" },
  { code: "de", label: "Deutsch", flag: "🇩🇪" },
  { code: "fr", label: "Français", flag: "🇫🇷" },
  { code: "ko", label: "한국어", flag: "🇰🇷" },
  { code: "it", label: "Italiano", flag: "🇮🇹" },
  { code: "tr", label: "Türkçe", flag: "🇹🇷" },
  { code: "id", label: "Bahasa Indonesia", flag: "🇮🇩" },
  { code: "th", label: "ไทย", flag: "🇹🇭" },
  { code: "pl", label: "Polski", flag: "🇵🇱" },
  { code: "nl", label: "Nederlands", flag: "🇳🇱" },
  { code: "uk", label: "Українська", flag: "🇺🇦" },
  { code: "fa", label: "فارسی", flag: "🇮🇷" },
  { code: "ms", label: "Bahasa Melayu", flag: "🇲🇾" },
  { code: "sv", label: "Svenska", flag: "🇸🇪" },
  { code: "el", label: "Ελληνικά", flag: "🇬🇷" },
  { code: "he", label: "עברית", flag: "🇮🇱" }
];

export const DEFAULT_LOCALE = "en";

export const LOCALE_STORAGE_KEY = "9remote_locale";
