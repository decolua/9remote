// Duration formatting for the task strip and its modal. Seconds below a minute, because
// a sub-agent's first ten seconds are exactly what a reader is watching; above that the
// seconds stop mattering and the minutes do.

const pad2 = (n) => String(n).padStart(2, "0");

/** "12s", "1m 04s", "1h 02m" — the same span in the strip and in the modal. */
export function clockText(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${pad2(m)}m`;
  if (m > 0) return `${m}m ${pad2(s)}s`;
  return `${s}s`;
}

/** The CLI reports task usage in ms; the modal prints it as a span, not a count. */
export const usageDurationMs = (usage) => Number(usage?.duration_ms) || 0;
