import { TERMINAL_THEMES, resolveTerminalTheme, TERMINAL_THEME_OPTIONS } from "@/shared/theme/themeConfig";

// Legacy default-theme lookup (kept for any caller still indexing by mode).
export const THEMES = {
  ...TERMINAL_THEMES,
  default: TERMINAL_THEMES.dark
};

export { resolveTerminalTheme, TERMINAL_THEME_OPTIONS };
