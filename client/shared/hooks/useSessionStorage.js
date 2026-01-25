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
    
    const apiKey = sessionStorage.getItem("apiKey");
    const tunnelUrl = sessionStorage.getItem("tunnelUrl");
    const mode = sessionStorage.getItem("mode");
    const tempKey = sessionStorage.getItem("tempKey");
    
    if (!apiKey || !tunnelUrl) return null;
    
    // Ensure cookie is set when reading auth (in case page was refreshed)
    setAuthCookie(apiKey);
    
    return { apiKey, tunnelUrl, mode, tempKey };
  }, []);

  const setAuth = useCallback((data) => {
    if (typeof window === "undefined") return;
    
    sessionStorage.setItem("apiKey", data.apiKey);
    sessionStorage.setItem("tunnelUrl", data.tunnelUrl);
    sessionStorage.setItem("mode", data.mode || "remote");
    
    if (data.tempKey) {
      sessionStorage.setItem("tempKey", data.tempKey);
    }
    
    // Set cookie for proxy auth
    setAuthCookie(data.apiKey);
  }, []);

  const clearAuth = useCallback(() => {
    if (typeof window === "undefined") return;
    sessionStorage.clear();
    clearAuthCookie();
  }, []);

  return { getAuth, setAuth, clearAuth };
}
