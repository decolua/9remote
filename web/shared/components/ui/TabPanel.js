"use client";

import { useEffect, useRef, useState } from "react";

/**
 * One dock tab's panel.
 *
 * Tabs are siblings: the outgoing one disappears the instant the switch happens (the
 * way 9love's tab bar does it — it never shows two half-visible screens) and the
 * incoming one slides in from the side it moved toward. That direction is the whole
 * point: a tab sitting to the right of the current one arrives from the right, so the
 * motion says where you went.
 *
 * The slide is a keyframe, not a transition: these panels stay mounted, so there is no
 * previous position for a transition to travel from after the first switch.
 */
export default function TabPanel({ active = false, dir = "forward", className = "", children }) {
  const [anim, setAnim] = useState("");
  const wasActive = useRef(active);
  const prevDir = useRef(dir);

  useEffect(() => {
    const becameActive = active && !wasActive.current;
    wasActive.current = active;
    // Direction changes while already active (a second tab press) still replay.
    const dirChanged = active && prevDir.current !== dir;
    prevDir.current = dir;
    if (!becameActive && !dirChanged) return;
    setAnim(dir === "back" ? "tab-in-back" : "tab-in-forward");
  }, [active, dir]);

  return (
    <div
      className={`absolute inset-0 ${anim} ${
        active ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
      } ${className}`}
      aria-hidden={!active}
      inert={!active}
      onAnimationEnd={(e) => {
        // Cleared so the next switch replays it; the base styles already match the
        // keyframe's end, so dropping the class changes nothing visually.
        if (e.target === e.currentTarget) setAnim("");
      }}
    >
      {children}
    </div>
  );
}
