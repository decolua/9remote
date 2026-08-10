import { useCallback } from "react";

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

  const setAuth = useCallback((data) => {
    if (typeof window === "undefined") return;
    
    // Storage may be unavailable (private mode / blocked cookies) — the auth
    // cookie below still carries the key, so persistence is best-effort.
    try {
      sessionStorage.setItem("apiKey", data.apiKey);
      sessionStorage.setItem("tunnelUrl", data.tunnelUrl);
      sessionStorage.setItem("mode", data.mode || "remote");

      if (data.tempKey) {
        sessionStorage.setItem("tempKey", data.tempKey);
      } else {
        sessionStorage.removeItem("tempKey");
      }

      if (data.localIp) {
        sessionStorage.setItem("localIp", data.localIp);
      } else {
        sessionStorage.removeItem("localIp");
      }
    } catch {}

    // Set cookie for proxy auth
    setAuthCookie(data.apiKey);
  }, []);

  const clearAuth = useCallback(() => {
    if (typeof window === "undefined") return;
    try { sessionStorage.clear(); } catch {}
    clearAuthCookie();
  }, []);

  return { getAuth, setAuth, clearAuth };
}
