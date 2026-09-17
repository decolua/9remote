// Theme tokens resolve via CSS vars (semantic theme aware)
export const THEME = {
  bg: "var(--color-bg)",
  bgElevated: "var(--color-surface)",
  bgPanel: "var(--color-surface-2)",
  border: "var(--color-border)",
  borderStrong: "var(--color-border)",
  borderAccent: "color-mix(in srgb, var(--color-accent) 35%, transparent)",
  text: "var(--color-text)",
  textDim: "var(--color-text-muted)",
  textMuted: "var(--color-text-subtle)",
  accent: "var(--color-accent)",
  accentGlow: "color-mix(in srgb, var(--color-accent) 40%, transparent)",
  accentSoft: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
  success: "var(--color-success)",
  warn: "#F59E0B",
  err: "var(--color-danger)"
};

// Desktop installers — version-less GitHub asset names so links survive releases
const RELEASES = "https://github.com/decolua/9remote/releases/latest/download";
const RELEASES_PAGE = "https://github.com/decolua/9remote/releases/latest";

// Desktop installer for the visitor's OS; falls back to the releases page when unknown
export const releaseFor = (os) =>
  os === "macos" ? `${RELEASES}/9Remote-macos-universal.dmg`
    : os === "windows" ? `${RELEASES}/9Remote-windows-x64-setup.exe`
      : RELEASES_PAGE;

// The two halves of the product — the host holds your code, the client is where you sit
export const HALVES = [
  {
    role: "Host",
    title: "On your machine",
    desc: "Serves your terminals, screen and files."
  },
  {
    role: "Client",
    title: "With you anywhere",
    desc: "Same session on any screen — nothing to sync."
  }
];
