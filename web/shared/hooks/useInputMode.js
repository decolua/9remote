"use client";

import { useEffect, useState } from "react";

// Detect primary input device: "mouse" (PC with physical mouse+keyboard) or "touch".
// Uses CSS media query `(pointer: fine) and (hover: hover)` + `navigator.maxTouchPoints`.
// Auto-updates if the user plugs/unplugs a mouse (rare, but supported).
export function useInputMode() {
  const [mode, setMode] = useState("touch");

  useEffect(() => {
    if (typeof window === "undefined") return;

    const mm = window.matchMedia("(pointer: fine) and (hover: hover)");
    const compute = () => {
      const hasFinePointer = mm.matches;
      const hasTouch = (navigator.maxTouchPoints || 0) > 0;
      // Treat as mouse only when fine pointer AND no touch (hybrid laptops → prefer touch UX).
      setMode(hasFinePointer && !hasTouch ? "mouse" : "touch");
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
