"use client";

import { THEME } from "../constants/landingConfig";

export default function AnimatedBackground() {
  return (
    <div className="fixed inset-0 z-0 overflow-hidden pointer-events-none" style={{ background: THEME.bg }}>
      {/* Subtle grid — softer on mobile to reduce orange overload */}
      <div
        className="absolute inset-0 opacity-[0.02] sm:opacity-[0.04] animate-grid-shift"
        style={{
          backgroundImage: `
            linear-gradient(to right, ${THEME.accent} 1px, transparent 1px),
            linear-gradient(to bottom, ${THEME.accent} 1px, transparent 1px)
          `,
          backgroundSize: "40px 40px"
        }}
      />

      {/* Orange ambient glow top-left — smaller + dimmer on mobile */}
      <div
        className="absolute animate-pulse-glow w-[360px] h-[360px] sm:w-[700px] sm:h-[700px]"
        style={{
          top: "-10%",
          left: "-5%",
          borderRadius: "50%",
          background: "rgba(255,87,10,0.09)",
          filter: "blur(120px)"
        }}
      />

      {/* Deep bottom-right glow — smaller + dimmer on mobile */}
      <div
        className="absolute animate-pulse-glow w-[420px] h-[420px] sm:w-[800px] sm:h-[800px]"
        style={{
          bottom: "-15%",
          right: "-10%",
          borderRadius: "50%",
          background: "rgba(255,87,10,0.06)",
          filter: "blur(140px)",
          animationDelay: "1.5s"
        }}
      />

      {/* Vignette */}
      <div
        className="absolute inset-0"
        style={{ background: "radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.6) 100%)" }}
      />
    </div>
  );
}
