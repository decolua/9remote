import { useCallback } from "react";

const STORAGE_KEY = "9remote_api_key";

// Simple base64 encoding for basic obfuscation (not cryptographic security)
function encode(str) {
  try {
    return btoa(str);
  } catch {
    return str;
  }
}

function decode(str) {
  try {
    return atob(str);
  } catch {
    return str;
  }
}

export function useApiKeyStorage() {
  // Check if running in browser
  const isBrowser = typeof window !== "undefined";

  // Save single API key to localStorage
  const saveKey = useCallback((apiKey) => {
    if (!apiKey || !isBrowser) return;
    try {
      const encoded = encode(apiKey);
      localStorage.setItem(STORAGE_KEY, encoded);
    } catch (err) {
      console.error("Failed to save API key:", err);
    }
  }, [isBrowser]);

  // Load API key from localStorage
  const loadKey = useCallback(() => {
    if (!isBrowser) return null;
    try {
      const encoded = localStorage.getItem(STORAGE_KEY);
      if (!encoded) return null;
      return decode(encoded);
    } catch (err) {
      console.error("Failed to load API key:", err);
      return null;
    }
  }, [isBrowser]);

  // Clear saved API key
  const clearKey = useCallback(() => {
    if (!isBrowser) return;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (err) {
      console.error("Failed to clear API key:", err);
    }
  }, [isBrowser]);

  // Check if key exists
  const hasStoredKey = useCallback(() => {
    if (!isBrowser) return false;
    try {
      return !!localStorage.getItem(STORAGE_KEY);
    } catch {
      return false;
    }
  }, [isBrowser]);

  return {
    saveKey,
    loadKey,
    clearKey,
    hasStoredKey
  };
}
