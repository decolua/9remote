"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { DEFAULT_THEME, STORAGE_KEY, THEME_KEYS } from "./themeConfig";

const ThemeContext = createContext({ theme: DEFAULT_THEME, setTheme: () => {}, toggleTheme: () => {} });

const applyClass = (theme) => {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(theme);
};

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(DEFAULT_THEME);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = localStorage.getItem(STORAGE_KEY);
    const initial = THEME_KEYS.includes(saved) ? saved : DEFAULT_THEME;
    setThemeState(initial);
    applyClass(initial);
  }, []);

  const setTheme = useCallback((next) => {
    if (!THEME_KEYS.includes(next)) return;
    setThemeState(next);
    applyClass(next);
    if (typeof window !== "undefined") localStorage.setItem(STORAGE_KEY, next);
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
