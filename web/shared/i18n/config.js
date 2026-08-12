// i18n configuration - single source of truth for supported locales
// Add new locales here + create matching file in ./locales/
export const SUPPORTED_LOCALES = [
  { code: "en", label: "English", flag: "🇺🇸", country: "us" },
  { code: "vi", label: "Tiếng Việt", flag: "🇻🇳", country: "vn" },
  { code: "zh", label: "中文", flag: "🇨🇳", country: "cn" },
  { code: "es", label: "Español", flag: "🇪🇸", country: "es" },
  { code: "hi", label: "हिन्दी", flag: "🇮🇳", country: "in" },
  { code: "ar", label: "العربية", flag: "🇸🇦", country: "sa" },
  { code: "pt", label: "Português", flag: "🇧🇷", country: "br" },
  { code: "ru", label: "Русский", flag: "🇷🇺", country: "ru" },
  { code: "ja", label: "日本語", flag: "🇯🇵", country: "jp" },
  { code: "de", label: "Deutsch", flag: "🇩🇪", country: "de" },
  { code: "fr", label: "Français", flag: "🇫🇷", country: "fr" },
  { code: "ko", label: "한국어", flag: "🇰🇷", country: "kr" },
  { code: "it", label: "Italiano", flag: "🇮🇹", country: "it" },
  { code: "tr", label: "Türkçe", flag: "🇹🇷", country: "tr" },
  { code: "id", label: "Bahasa Indonesia", flag: "🇮🇩", country: "id" },
  { code: "th", label: "ไทย", flag: "🇹🇭", country: "th" },
  { code: "pl", label: "Polski", flag: "🇵🇱", country: "pl" },
  { code: "nl", label: "Nederlands", flag: "🇳🇱", country: "nl" },
  { code: "uk", label: "Українська", flag: "🇺🇦", country: "ua" },
  { code: "fa", label: "فارسی", flag: "🇮🇷", country: "ir" },
  { code: "ms", label: "Bahasa Melayu", flag: "🇲🇾", country: "my" },
  { code: "sv", label: "Svenska", flag: "🇸🇪", country: "se" },
  { code: "el", label: "Ελληνικά", flag: "🇬🇷", country: "gr" },
  { code: "he", label: "עברית", flag: "🇮🇱", country: "il" }
];

export const DEFAULT_LOCALE = "en";

export const LOCALE_STORAGE_KEY = "9remote_locale";
