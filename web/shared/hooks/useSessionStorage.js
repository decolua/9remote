import { useCallback } from "react";
import { useConnectionStore } from "@/shared/stores/connectionStore";

const AUTH_COOKIE_NAME = "9remote_auth";
// Persistent mirror of the sessionStorage auth block, so closing the browser does
// not cost the user a re-login. Gated on the login page's own "remember key"
// preference — the same switch that decides whether the key is saved at all.
const REMEMBER_STORAGE_KEY = "9remote_auth_state";
const REMEMBER_PREF_KEY = "9remote_remember_key_preference";
// tempKey is deliberately absent: a one-time code is not a session worth
// resuming, and the enrollment it drives — plus the WANTS_SAVE flag that lives
// only in sessionStorage — cannot survive the tab. Re-pairing is the honest
// answer there, and mirroring the code would re-enroll on every later open.
const AUTH_FIELDS = ["apiKey", "tunnelUrl", "mode", "localIp"];

function rememberEnabled() {
  try {
    return localStorage.getItem(REMEMBER_PREF_KEY) !== "false";
  } catch {
    return false;
  }
}

// Drop the mirror without touching the live session — for the "remember key"
// switch itself, which must not log the user out of the tab they are in.
export function clearRememberedAuth() {
  try {
    localStorage.removeItem(REMEMBER_STORAGE_KEY);
  } catch {}
}

// Best-effort — storage throws in private mode / blocked-cookie modes.
function readRemembered() {
  try {
    return JSON.parse(localStorage.getItem(REMEMBER_STORAGE_KEY) || "null");
  } catch {
    return null;
  }
}

// Set auth cookie for proxy authentication
function setAuthCookie(apiKey) {
  if (typeof document === "undefined") return;
  // Cookie expires in 24 hours
  document.cookie = `${AUTH_COOKIE_NAME}=${apiKey}; path=/; max-age=86400; SameSite=Lax`;
}

// Clear auth cookie
function clearAuthCookie() {
  if (typeof document === "undefined") return;
  document.cookie = `${AUTH_COOKIE_NAME}=; path=/; max-age=0`;
}

// Plain (non-hook) auth writer for flows outside React, e.g. host switching.
export function setAuthData({ apiKey, tunnelUrl, mode = "remote", tempKey = null, localIp = null }) {
  if (typeof window === "undefined") return;
  // Nothing to remember is nothing to keep — a session rekeyed away (the fleet
  // disconnect path clears the auth block) must not leave the previous host
  // waiting on the login screen.
  if (!apiKey) {
    try { localStorage.removeItem(REMEMBER_STORAGE_KEY); } catch {}
    return;
  }
  // Storage may be unavailable (private mode / blocked cookies) — the auth
  // cookie below still carries the key, so persistence is best-effort.
  try {
    sessionStorage.setItem("apiKey", apiKey);
    sessionStorage.setItem("tunnelUrl", tunnelUrl);
    sessionStorage.setItem("mode", mode || "remote");
    if (tempKey) sessionStorage.setItem("tempKey", tempKey);
    else sessionStorage.removeItem("tempKey");
    if (localIp) sessionStorage.setItem("localIp", localIp);
    else sessionStorage.removeItem("localIp");
  } catch {}
  setAuthCookie(apiKey);
  // Fresh auth is a fresh intent to connect — a previous deliberate
  // disconnect must not swallow the next login.
  try { sessionStorage.removeItem("9remote_manual_disconnect"); } catch {}
  // localStorage may be unavailable while sessionStorage is not, so the two are
  // written independently — the session must not die with the persistence.
  try {
    if (rememberEnabled()) localStorage.setItem(REMEMBER_STORAGE_KEY, JSON.stringify({ apiKey, tunnelUrl, mode, localIp }));
    else localStorage.removeItem(REMEMBER_STORAGE_KEY);
  } catch {}
  // Reactive mirror: useBus watches this to re-key the workspace connection in
  // place — the no-reload half of host switching.
  useConnectionStore.getState().setAuthKey(apiKey);
}

// Type-safe session storage for auth data
export function useSessionStorage() {
  const getAuth = useCallback(() => {
    if (typeof window === "undefined") return null;
    
    // sessionStorage access throws in sandboxed iframes / blocked-cookie modes
    let apiKey, tunnelUrl, mode, tempKey, localIp;
    try {
      apiKey = sessionStorage.getItem("apiKey");
      tunnelUrl = sessionStorage.getItem("tunnelUrl");
      mode = sessionStorage.getItem("mode");
      tempKey = sessionStorage.getItem("tempKey");
      localIp = sessionStorage.getItem("localIp");
    } catch { return null; }

    // Closed tab: sessionStorage is empty but the remembered block survives.
    // tunnelUrl is a fallback hint only — the live route is re-resolved from the
    // Worker on connect, and the workspace's reconnect screen owns the rest.
    if (!apiKey) {
      const remembered = readRemembered();
      if (!remembered?.apiKey) return null;
      try {
        for (const field of AUTH_FIELDS) {
          if (remembered[field]) sessionStorage.setItem(field, remembered[field]);
        }
      } catch {}
      apiKey = remembered.apiKey;
      tunnelUrl = remembered.tunnelUrl ?? null;
      mode = remembered.mode ?? null;
      localIp = remembered.localIp ?? null;
    }

    // Ensure cookie is set when reading auth (in case page was refreshed)
    setAuthCookie(apiKey);

    return { apiKey, tunnelUrl, mode, tempKey, localIp };
  }, []);

  const setAuth = useCallback((data) => setAuthData(data), []);

  const clearAuth = useCallback(() => {
    if (typeof window === "undefined") return;
    try { sessionStorage.clear(); } catch {}
    try { localStorage.removeItem(REMEMBER_STORAGE_KEY); } catch {}
    clearAuthCookie();
  }, []);

  return { getAuth, setAuth, clearAuth };
}
