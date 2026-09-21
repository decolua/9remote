"use client";
import { useEffect, useState } from "react";

// Lock app to portrait on mobile phones only. Tablets and desktops are left
// alone. Native orientation.lock only works on Android PWA in fullscreen; iOS
// Safari ignores it, so an overlay covers the rest.
export default function RotateOverlay() {
  const [isMobile, setIsMobile] = useState(false);
  const [landscape, setLandscape] = useState(false);

  useEffect(() => {
    // pointer:coarse + short edge excludes desktop/laptop-with-touch and
    // large tablets, targeting phones.
    const mobileMq = window.matchMedia("(pointer: coarse) and (max-width: 900px)");
    const orientMq = window.matchMedia("(orientation: landscape)");

    const sync = () => {
      setIsMobile(mobileMq.matches);
      setLandscape(orientMq.matches);
    };
    sync();
    mobileMq.addEventListener("change", sync);
    orientMq.addEventListener("change", sync);
    return () => {
      mobileMq.removeEventListener("change", sync);
      orientMq.removeEventListener("change", sync);
    };
  }, []);

  // Best-effort portrait lock, mobile only. Throws on iOS / non-fullscreen /
  // desktop — expected, caught silently. Skip if inside Expo native app.
  useEffect(() => {
    const isExpo = typeof window !== "undefined" && (
      !!window.ReactNativeWebView || /9Remote-Mobile/i.test(navigator.userAgent)
    );
    if (!isMobile || isExpo) return;
    let locked = false;
    const tryLock = async () => {
      try {
        await window.screen?.orientation?.lock?.("portrait");
        locked = true;
      } catch {
        // Overlay fallback handles unsupported cases.
      }
    };
    tryLock();
    return () => {
      if (locked) window.screen?.orientation?.unlock?.();
    };
  }, [isMobile]);

  // No overlay: Android PWA stays locked via screen.orientation above; other
  // mobile browsers (iOS, Chrome) are free to rotate.
  return null;
}
