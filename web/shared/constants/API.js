// API endpoints configuration
// Same-origin in the browser (dev.9remote.cc / 9remote.cc follow the deploy).
// Override with NEXT_PUBLIC_WORKER_URL to run the UI locally (npm run web:dev)
// while talking to a deployed Worker (API + DO + D1) — avoids a redeploy per change.
// SSR fallback to prod so server renders don't break.
const isBrowser = typeof location !== "undefined";
export const WORKER_API = process.env.NEXT_PUBLIC_WORKER_URL
  || (isBrowser ? location.origin : "https://9remote.cc");
export const HOMEPAGE_URL = "https://9remote.cc/";
export const DOCS_URL = "https://docs.9remote.cc/";

// Port the host serves its local API on. Mirrors host/lib/constants.js
// SERVER_PORT — the two runtimes share no module, only this number.
export const AGENT_PORT = 2208;

// The host on this machine, addressed directly. A local page talks to it
// cross-origin rather than through a dev-server rewrite: proxying would reach the
// host with a rewritten Host, which defeats its DNS-rebinding guard and exposes
// its loopback-only endpoints on whatever interface the dev server bound.
// The host admits this origin (LOCAL_UI_ORIGINS) and answers only a loopback peer.
export const LOCAL_HOST_ORIGIN = `http://127.0.0.1:${AGENT_PORT}`;
export const LOCAL_AGENT_ORIGIN = LOCAL_HOST_ORIGIN;
export const LOCAL_HOST_STATE = `${LOCAL_HOST_ORIGIN}/api/ui/state`;
export const LOCAL_AGENT_STATE = LOCAL_HOST_STATE;

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
export const TUNNEL_VERIFY_TIMEOUT_MS = 5000;
// Hard cap on /api/connect — without it a stalled request leaves the UI spinning forever
export const CONNECT_TIMEOUT_MS = 10000;
