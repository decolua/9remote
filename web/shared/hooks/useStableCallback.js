"use client";

import { useCallback, useEffect, useRef } from "react";

// Stable identity, always-fresh body: memoized children keep one prop reference while
// the handler still sees this render's props. The ref is refreshed in an effect, so a
// call landing between render and commit sees the previous body — the handler only ever
// runs on a user event, long after that window.
export function useStableCallback(fn) {
  const ref = useRef(fn);
  useEffect(() => { ref.current = fn; });
  return useCallback((...args) => ref.current?.(...args), []);
}
