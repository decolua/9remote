"use client";

import { useCallback, useRef } from "react";

// Shared cursor for "jump to next waiting terminal" (the ⌥A chord and the mobile
// badge tap): advances through blocked/done sessions in display order (allSessions,
// top-to-bottom), wrapping; a vanished id restarts at the top.
export function useAttentionCycle(sessionStatus, allSessions, onSelect) {
  const cursorRef = useRef(null);
  return useCallback(() => {
    const waiting = allSessions.filter((s) => {
      const st = sessionStatus[s.id]?.state;
      return st === "blocked" || st === "done";
    });
    if (!waiting.length) return null;
    const idx = waiting.findIndex((s) => s.id === cursorRef.current);
    const next = waiting[(idx + 1) % waiting.length];
    cursorRef.current = next.id;
    onSelect?.(next.id);
    return next.id;
  }, [sessionStatus, allSessions, onSelect]);
}
