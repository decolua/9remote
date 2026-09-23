"use client";

import { HardDrive, Laptop, Monitor, Terminal } from "@/shared/components/ui/Icon";

// The host's machine, drawn by OS family — a device, not a folder. Desktop-shaped
// glyphs on purpose: a phone glyph would read as the mobile client.
export default function PlatformGlyph({ platform, size = 15 }) {
  if (platform === "win32") return <Monitor size={size} className="text-text-muted" />;
  if (platform === "linux") return <Terminal size={size} className="text-text-muted" />;
  // Laptop's glyph fills less of its viewBox than Monitor — bump it or it reads smaller.
  if (platform === "darwin") return <Laptop size={size + 2} className="text-text-muted" />;
  return <HardDrive size={size} className="text-text-muted" />;
}
