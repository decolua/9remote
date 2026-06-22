// API endpoints configuration

export const WORKER_API = "https://9remote.cc";
export const HOMEPAGE_URL = "https://9remote.cc/";
export const DOCS_URL = "https://docs.9remote.cc/";

// Command to update the agent to latest version
export const AGENT_UPDATE_COMMAND = "npm i -g 9remote@latest";

export const API_ENDPOINTS = {
  connect: `${WORKER_API}/api/connect`,
  tempKeyCreate: `${WORKER_API}/api/temp-key/create`,
  tempKeyVerify: `${WORKER_API}/api/temp-key/verify`,
  tempKeyRemove: `${WORKER_API}/api/temp-key/remove`,
  localSites: "/api/local-sites",
  turnCredentials: `${WORKER_API}/api/webrtc/turn-credentials`
};

// Retry config when tunnel not reachable yet after /api/connect succeeds
export const TUNNEL_VERIFY_RETRY_MAX = 5;
export const TUNNEL_VERIFY_RETRY_INTERVAL_MS = 2000;
