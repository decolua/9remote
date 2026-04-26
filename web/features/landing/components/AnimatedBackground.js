"use client";

export default function AnimatedBackground() {
  return (
    <div className="fixed inset-0 -z-10 overflow-hidden pointer-events-none landing-bg">
      {/* Subtle grid — theme-aware accent lines */}
      <div className="absolute inset-0 landing-grid" />

      {/* Top-left ambient glow */}
      <div
        className="absolute w-[360px] h-[360px] sm:w-[700px] sm:h-[700px] landing-glow-1"
        style={{
          top: "-10%",
          left: "-5%",
          borderRadius: "50%",
          filter: "blur(120px)"
        }}
      />

      {/* Bottom-right deep glow */}
      <div
        className="absolute w-[420px] h-[420px] sm:w-[800px] sm:h-[800px] landing-glow-2"
        style={{
          bottom: "-15%",
          right: "-10%",
          borderRadius: "50%",
          filter: "blur(140px)"
        }}
      />

      {/* Vignette — theme-aware */}
      <div className="absolute inset-0 landing-vignette" />
    </div>
  );
}
