export const PERMISSIONS = {
  sessionView: "session.view",
  sessionDelete: "session.delete",
  modeView: "mode.view",
  modeManage: "mode.manage",
  adminView: "admin.view",
  adminManage: "admin.manage",
  otaView: "ota.view",
  otaManage: "ota.manage"
};

export const PERMISSION_LIST = Object.values(PERMISSIONS);

export const ADMIN_COOKIE_NAME = "9remote_admin_token";
export const ADMIN_TOKEN_TTL_SEC = 7 * 24 * 60 * 60;
export const SESSION_ONLINE_THRESHOLD_MS = 30 * 60 * 1000;
export const SESSION_R3_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000;
export const SESSION_R7_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_RETURN_THRESHOLD_MS = 5 * 60 * 1000;
export const SESSION_NEW_THRESHOLD_MS = 24 * 60 * 60 * 1000;
export const SESSION_MAU_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;

export const PAGE_SIZE_DEFAULT = 20;
export const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

export const SESSION_SORT_FIELDS = ["createdAt", "lastAccessAt", "expiresAt", "machineId"];
export const SORT_ORDERS = ["asc", "desc"];

// Loyalty tiers by session age (lastAccessAt - createdAt), descending threshold
export const LOYALTY_TIERS = [
  { key: "loyal", label: "Loyal", minMs: SESSION_R7_THRESHOLD_MS, color: "text-success" },
  { key: "returning", label: "Returning", minMs: SESSION_NEW_THRESHOLD_MS, color: "text-brand-500" },
  { key: "active", label: "Active", minMs: SESSION_RETURN_THRESHOLD_MS, color: "text-brand-400" },
  { key: "new", label: "New", minMs: 0, color: "text-text-muted" }
];

export const ADMIN_API = {
  login: "/api/admin/login",
  logout: "/api/admin/logout",
  me: "/api/admin/me",
  sessions: "/api/admin/sessions",
  stats: "/api/admin/stats",
  modes: "/api/admin/modes",
  admins: "/api/admin/admins",
  ota: "/api/admin/ota"
};
