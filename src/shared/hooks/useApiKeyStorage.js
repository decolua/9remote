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
  // Save single API key to localStorage
  const saveKey = useCallback((apiKey) => {
    if (!apiKey) return;
    try {
      const encoded = encode(apiKey);
      localStorage.setItem(STORAGE_KEY, encoded);
    } catch (err) {
      console.error("Failed to save API key:", err);
    }
  }, []);

  // Load API key from localStorage
  const loadKey = useCallback(() => {
    try {
      const encoded = localStorage.getItem(STORAGE_KEY);
      if (!encoded) return null;
      return decode(encoded);
    } catch (err) {
      console.error("Failed to load API key:", err);
      return null;
    }
  }, []);

  // Clear saved API key
  const clearKey = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (err) {
      console.error("Failed to clear API key:", err);
    }
  }, []);

  // Check if key exists
  const hasStoredKey = useCallback(() => {
    try {
      return !!localStorage.getItem(STORAGE_KEY);
    } catch {
      return false;
    }
  }, []);

  return {
    saveKey,
    loadKey,
    clearKey,
    hasStoredKey
  };
}
