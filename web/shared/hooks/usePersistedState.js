"use client";

import { useState, useEffect, useCallback } from "react";

// Generic useState wrapper that persists value to localStorage under `key`.
// Safely handles SSR (no window) and JSON parse errors.
export function usePersistedState(key, initialValue) {
  const [value, setValue] = useState(initialValue);

  // Hydrate from localStorage on mount
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(key);
      if (raw !== null) setValue(JSON.parse(raw));
    } catch (err) {
      console.warn(`usePersistedState: failed to read "${key}"`, err);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Persist on change
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      console.warn(`usePersistedState: failed to write "${key}"`, err);
    }
  }, [key, value]);

  const reset = useCallback(() => setValue(initialValue), [initialValue]);

  return [value, setValue, reset];
}
