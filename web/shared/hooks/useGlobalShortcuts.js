"use client";

import { useEffect, useRef } from "react";
import { matchShortcut } from "@/features/terminal/constants/shortcuts";

// Single capture-phase listener for the workspace shell's Mod+Shift chords.
// `enabled` is false on mobile, where there is no physical keyboard to serve.
export function useGlobalShortcuts(handlers, enabled = true) {
  // Ref so the listener registers once and still calls the latest handlers.
  const ref = useRef(handlers);
  useEffect(() => { ref.current = handlers; });

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e) => {
      const match = matchShortcut(e);
      if (!match) return;
      const fn = ref.current?.[match.id];
      if (!fn) return;
      e.preventDefault();
      e.stopPropagation();
      fn(match.index);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [enabled]);
}
