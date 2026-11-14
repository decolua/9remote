"use client";

export default function AnimatedBackground() {
  return (
    <div className="fixed inset-0 -z-10 overflow-hidden pointer-events-none landing-bg">
      {/* Subtle icon tile — same hand-drawn wallpaper as the chat canvas */}
      <div className="absolute inset-0 landing-icons" />

      {/* Vignette — theme-aware */}
      <div className="absolute inset-0 landing-vignette" />
    </div>
  );
}
