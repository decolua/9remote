// Quota tracker tunables — endpoints, timeouts, cache TTL, window lengths.

export const QUOTA_TTL_MS = 60_000; // cache aggregate result; web polls at the same cadence
export const API_TIMEOUT_MS = 10_000;

export const SESSION_WINDOW_MINUTES = 300; // 5h rolling window (Claude/Codex/Kimi)
export const WEEKLY_WINDOW_MINUTES = 10_080; // 7d
export const MONTHLY_WINDOW_MINUTES = 43_200; // 30d (Grok unified billing)

// Claude Code (Pro/Max OAuth)
export const CLAUDE_OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CLAUDE_OAUTH_BETA_HEADER = "oauth-2025-04-20";
export const CLAUDE_USER_AGENT = "claude-code/2.1.0";
export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

// Codex (ChatGPT plan) — JSON-RPC over `codex app-server`
export const CODEX_RPC_ARGS = ["-s", "read-only", "-a", "untrusted", "app-server"];
export const CODEX_RPC_INIT_TIMEOUT_MS = 30_000; // cold app-server start incl. token refresh
export const CODEX_RPC_TIMEOUT_MS = 10_000;
// Tolerate the one-minute drift older Codex builds report for bucket lengths.
export const CODEX_WINDOW_TOLERANCE_MINUTES = 1;

// Kimi Code
export const KIMI_BASE_URL = process.env.KIMI_CODE_BASE_URL ?? "https://api.kimi.com/coding/v1";

// Grok CLI
export const GROK_CLI_PROXY_BASE =
  process.env.GROK_CLI_CHAT_PROXY_BASE_URL?.trim().replace(/\/$/, "") ||
  "https://cli-chat-proxy.grok.com/v1";
export const GROK_BILLING_CREDITS_URL = `${GROK_CLI_PROXY_BASE}/billing?format=credits`;
export const GROK_BILLING_DEFAULT_URL = `${GROK_CLI_PROXY_BASE}/billing`;
export const GROK_AUTH_HEADER = "xai-grok-cli";
