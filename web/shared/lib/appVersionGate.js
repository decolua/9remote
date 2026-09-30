// Pure helpers for the mobile-app update gate (AppUpdateGate). DOM-free so
// tests drive them directly.

// The expo shell identifies itself as "9Remote-Mobile/<version>" in the UA —
// every store build so far carries its version there.
const APP_UA_RE = /9Remote-Mobile\/(\d+(?:\.\d+){0,2})/i;
const SEMVER_RE = /^\d+(?:\.\d+){0,2}$/;

export function isMobileAppUA(userAgent) {
  return APP_UA_RE.test(String(userAgent || ""));
}

// deviceInfo is the shell's DEVICE_INFO bridge (newer builds); the UA is the
// fallback that reaches every older build. null = unrecognized.
export function appVersionOf(userAgent, deviceInfo) {
  const v = deviceInfo?.version;
  if (typeof v === "string" && SEMVER_RE.test(v)) return v;
  const m = APP_UA_RE.exec(String(userAgent || ""));
  return m ? m[1] : null;
}

// Numeric compare of up-to-3-part versions. An unparsable minimum fails open —
// a typo on the server must not brick every installed app.
export function isVersionBelow(version, minimum) {
  if (!SEMVER_RE.test(String(version)) || !SEMVER_RE.test(String(minimum))) return false;
  const a = String(version).split(".").map(Number);
  const b = String(minimum).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d !== 0) return d < 0;
  }
  return false;
}
