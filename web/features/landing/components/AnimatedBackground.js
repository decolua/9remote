"use client";

export default function AnimatedBackground() {
  return (
    <div className="fixed inset-0 -z-10 overflow-hidden pointer-events-none landing-bg">
      {/* Subtle grid — theme-aware accent lines */}
      <div className="absolute inset-0 landing-grid" />

      {/* Vignette — theme-aware */}
      <div className="absolute inset-0 landing-vignette" />
    </div>
  );
}
