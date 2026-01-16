import { useCallback } from "react";

// Type-safe session storage for auth data
export function useSessionStorage() {
  const getAuth = useCallback(() => {
    if (typeof window === "undefined") return null;
    
    const apiKey = sessionStorage.getItem("apiKey");
    const tunnelUrl = sessionStorage.getItem("tunnelUrl");
    const mode = sessionStorage.getItem("mode");
    
    if (!apiKey || !tunnelUrl) return null;
    
    return { apiKey, tunnelUrl, mode };
  }, []);

  const setAuth = useCallback((data) => {
    if (typeof window === "undefined") return;
    
    sessionStorage.setItem("apiKey", data.apiKey);
    sessionStorage.setItem("tunnelUrl", data.tunnelUrl);
    sessionStorage.setItem("mode", data.mode || "remote");
  }, []);

  const clearAuth = useCallback(() => {
    if (typeof window === "undefined") return;
    sessionStorage.clear();
  }, []);

  return { getAuth, setAuth, clearAuth };
}
