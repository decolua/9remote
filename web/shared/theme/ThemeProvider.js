"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { DEFAULT_THEME, STORAGE_KEY, THEME_KEYS } from "./themeConfig";

const ThemeContext = createContext({ theme: DEFAULT_THEME, setTheme: () => {}, toggleTheme: () => {} });

const applyClass = (theme) => {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(theme);
  root.style.colorScheme = theme;
  try {
    const win = window.__TAURI__?.window?.getCurrentWindow?.();
    if (win) {
      win.setTheme?.(theme)?.catch?.(() => {});
      win.setBackgroundColor?.(theme === "light" ? "#e7e7e9" : "#2a2a2a")?.catch?.(() => {});
    }
  } catch {}
};

// Notify native shell (Expo WebView) so status bar / safe area match current theme
const notifyNative = (theme) => {
  if (typeof window === "undefined") return;
  if (!window.ReactNativeWebView) return;
  try {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: "THEME_CHANGE", theme }));
  } catch (e) { /* ignore */ }
};

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(DEFAULT_THEME);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = localStorage.getItem(STORAGE_KEY) || localStorage.getItem("9remote-theme");
    const initial = THEME_KEYS.includes(saved) ? saved : DEFAULT_THEME;
    setThemeState(initial);
    applyClass(initial);
    notifyNative(initial);
  }, []);

  const setTheme = useCallback((next) => {
    if (!THEME_KEYS.includes(next)) return;
    setThemeState(next);
    applyClass(next);
    notifyNative(next);
    if (typeof window !== "undefined") {
      localStorage.setItem(STORAGE_KEY, next);
      localStorage.setItem("9remote-theme", next);
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [theme, setTheme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);
