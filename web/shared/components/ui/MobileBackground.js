"use client";

/**
 * Mobile background - renders as fixed background layer with dot grid pattern
 * Does NOT wrap children to avoid re-render issues
 */
export default function MobileBackgroundImage() {
  return (
    <div 
      className="fixed inset-0 -z-10 pointer-events-none dot-grid-bg"
    />
  );
}
