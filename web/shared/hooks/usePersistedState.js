"use client";

import { useState, useEffect, useCallback, useRef } from "react";

// Generic useState wrapper that persists value to localStorage under `key`.
// Safely handles SSR (no window) and JSON parse errors.
export function usePersistedState(key, initialValue) {
  const [value, setValue] = useState(initialValue);
  // The persist effect runs its FIRST pass on the same commit as the hydrate read —
  // before that read has re-rendered — so writing then would clobber the stored value
  // with initialValue (lost for good if the component unmounts first). Skip one pass
  // per key instead: the first write only happens once a real change follows hydration.
  const skipNextWrite = useRef(true);
  const keyRef = useRef(key);

  // Hydrate from localStorage on mount
  useEffect(() => {
    if (typeof window === "undefined") return;
    // A reused instance switching keys restarts the skip cycle for the same reason
    if (keyRef.current !== key) { keyRef.current = key; skipNextWrite.current = true; }
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
    if (skipNextWrite.current) { skipNextWrite.current = false; return; }
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      console.warn(`usePersistedState: failed to write "${key}"`, err);
    }
  }, [key, value]);

  const reset = useCallback(() => setValue(initialValue), [initialValue]);

  return [value, setValue, reset];
}
