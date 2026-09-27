// Identifying the terminal behind an MCP call
export const CALLER_SESSION = {
  HEADER: "x-9remote-session",
  // The PTY's shell is at most a few processes above the CLI (npx/sh/sandbox wrappers)
  MAX_PARENT_HOPS: 8,
  PROBE_TIMEOUT_MS: 3000,
};
