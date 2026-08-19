"use client";

import { useEffect, useState } from "react";

// Detect primary input device: "mouse" (PC with physical mouse+keyboard) or "touch".
// Uses CSS media query `(pointer: fine) and (hover: hover)` + `navigator.maxTouchPoints`.
// Auto-updates if the user plugs/unplugs a mouse (rare, but supported).
const FINE_POINTER_QUERY = "(pointer: fine) and (hover: hover)";

export function useInputMode() {
  // Sync at init, not after mount: a "touch" default paints one wrong frame on every
  // remount — visible as the status strip flashing on desktop pane switches
  const [mode, setMode] = useState(() => {
    if (typeof window === "undefined") return "touch";
    return window.matchMedia(FINE_POINTER_QUERY).matches ? "mouse" : "touch";
  });

  useEffect(() => {
    if (typeof window === "undefined") return;

    const mm = window.matchMedia(FINE_POINTER_QUERY);
    const compute = () => {
      const hasFinePointer = mm.matches;
      setMode(hasFinePointer ? "mouse" : "touch");
    };

    compute();
    // Safari <14 uses addListener; modern browsers use addEventListener.
    if (mm.addEventListener) mm.addEventListener("change", compute);
    else mm.addListener(compute);

    return () => {
      if (mm.removeEventListener) mm.removeEventListener("change", compute);
      else mm.removeListener(compute);
    };
  }, []);

  return mode;
}
