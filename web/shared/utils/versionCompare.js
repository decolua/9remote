// Semver-ish x.y.z comparison (host's own isNewerVersion mirror). Used to keep
// a reported update honest: it only means something when the offered version is
// actually ahead of the one the host is running.
export function isNewer(latest, current) {
  if (!latest || !current) return false;
  const a = String(latest).split(".").map(Number);
  const b = String(current).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}
