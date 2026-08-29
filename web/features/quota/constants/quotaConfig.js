// Quota tracker display config — provider labels, urgency thresholds, poll cadence.

export const QUOTA_POLL_MS = 60000; // matches agent-side QUOTA_TTL_MS

export const PROVIDER_LABELS = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  kimi: "Kimi",
  grok: "Grok"
};

// Urgency curve: quiet under 60%, warn 60-80%, alert above.
export const QUOTA_WARN_PCT = 60;
export const QUOTA_CRITICAL_PCT = 80;

export function quotaBarColor(usedPct) {
  if (usedPct < QUOTA_WARN_PCT) return "bg-text-muted/40";
  if (usedPct < QUOTA_CRITICAL_PCT) return "bg-yellow-500";
  return "bg-red-500";
}
