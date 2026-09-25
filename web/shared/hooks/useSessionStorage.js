import { useCallback } from "react";
import { useConnectionStore } from "@/shared/stores/connectionStore";

const AUTH_COOKIE_NAME = "9remote_auth";

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

    if (!apiKey) return null; // RTC-first: tunnelUrl optional (fallback only)

    // Ensure cookie is set when reading auth (in case page was refreshed)
    setAuthCookie(apiKey);
    
    return { apiKey, tunnelUrl, mode, tempKey, localIp };
  }, []);

  const setAuth = useCallback((data) => setAuthData(data), []);

  const clearAuth = useCallback(() => {
    if (typeof window === "undefined") return;
    try { sessionStorage.clear(); } catch {}
    clearAuthCookie();
  }, []);

  return { getAuth, setAuth, clearAuth };
}
