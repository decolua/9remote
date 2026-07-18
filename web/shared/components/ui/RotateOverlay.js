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
  // desktop — expected, caught silently.
  useEffect(() => {
    if (!isMobile) return;
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

  if (!isMobile || !landscape) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        background: "#121212",
        color: "#fff",
        fontFamily: "var(--font-geist-sans, system-ui, sans-serif)",
      }}
    >
      <span style={{ fontSize: 56, animation: "rotateHint 1.6s ease-in-out infinite" }}>📱</span>
      <span style={{ fontSize: 15, opacity: 0.85 }}>Rotate your device</span>
      <style>{`@keyframes rotateHint{0%,100%{transform:rotate(0)}50%{transform:rotate(-90deg)}}`}</style>
    </div>
  );
}
