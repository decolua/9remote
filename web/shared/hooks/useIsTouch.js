"use client";
import { useEffect, useState } from "react";

// Hover-reveal affordances are unreachable on touch devices (no hover) —
// true when the primary pointer has no hover capability, false otherwise.
export default function useIsTouch() {
  const [isTouch, setIsTouch] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(hover: none), (pointer: coarse)");
    const sync = () => setIsTouch(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  return isTouch;
}
