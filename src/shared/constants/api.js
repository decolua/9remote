// API endpoints configuration

export const WORKER_API = "https://remote.9router.com";

export const API_ENDPOINTS = {
  connect: `${WORKER_API}/api/connect`,
  tempKeyCreate: `${WORKER_API}/api/temp-key/create`,
  tempKeyVerify: `${WORKER_API}/api/temp-key/verify`,
  tempKeyRemove: `${WORKER_API}/api/temp-key/remove`,
  localSites: "/api/local-sites"
};
