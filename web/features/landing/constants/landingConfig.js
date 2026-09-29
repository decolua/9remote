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

// Desktop installers — assets are addressed by release tag, so every version stays reachable
const REPO = "https://github.com/decolua/9remote";

export const APP_STORE_URL = "https://apps.apple.com/us/app/9remote/id6796664210";
export const PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=cc.remote9.app&pli=1";
export const DOWNLOADS_PATH = "/download";
export const GITHUB_REPO_URL = REPO;

// Enough to pick an installer; iPadOS reports as Mac, which the .dmg does not serve
export function detectOs() {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return "other";
  if (/Mac/.test(ua)) return "macos";
  if (/Win/.test(ua)) return "windows";
  return "other";
}

// Every installer each release ships, in the order /download lists them
export const INSTALLERS = [
  { id: "dmg", os: "macOS", short: "macOS", label: "Universal · Intel + Apple silicon", ext: ".dmg", asset: "9Remote-macos-universal.dmg" },
  { id: "setup", os: "Windows", short: "Win setup", label: "Installer · x64", ext: ".exe", asset: "9Remote-windows-x64-setup.exe" },
  { id: "portable", os: "Windows", short: "Win portable", label: "Portable · no install", ext: ".exe", asset: "9Remote-windows-x64-portable.exe" }
];

// Newest first — /download lists every entry, so a release is one line here.
// ponytail: hand-kept list; swap for a cached GitHub API read when releases outpace edits.
export const DESKTOP_RELEASES = [
  { tag: "v3.0.31", date: "2026-09-28" },
  { tag: "v3.0.3", date: "2026-09-21" },
  { tag: "v3.0.0", date: "2026-09-20" },
  { tag: "v3.5.9", date: "2026-09-15" }
];

export const downloadUrl = (tag, asset) => `${REPO}/releases/download/${tag}/${asset}`;

// Newest build, linked directly until its release carries the canonical asset names
export const LATEST_BUILD = {
  tag: "v3.0.31",
  assets: {
    dmg: `${REPO}/releases/download/v3.0.31/9Remote-macos-universal.dmg`,
    setup: `${REPO}/releases/download/v3.0.31/9Remote-windows-x64-setup.exe`,
    portable: `${REPO}/releases/download/v3.0.31/9Remote-windows-x64-portable.exe`,
    // Linux unchanged in 3.0.31 — keep serving the 3.0.30 build
    debAmd64: `${REPO}/releases/download/v3.0.30/9Remote-linux-amd64.deb`,
    debArm64: `${REPO}/releases/download/v3.0.30/9Remote-linux-arm64.deb`,
    appImageArm64: `${REPO}/releases/download/v3.0.30/9Remote-linux-arm64.AppImage`
  }
};

// "v3.0.3" → "3.0.3": tags carry the v, labels should not double it
export const versionOf = (tag) => tag.replace(/^v/, "");

// Newest first — neither source guarantees the order (GitHub returns newest first
// today, the list above is hand-kept), so both go through here.
export const byNewest = (releases) => [...releases].sort((a, b) => b.date.localeCompare(a.date));

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
