import { useCallback } from "react";
import { KEYS_CHANGED_EVENT } from "@/shared/constants/transport";

const STORAGE_KEY = "9remote_api_keys";
// Re-exported for existing importers (the workspace layout listens on it).
export { KEYS_CHANGED_EVENT };
const notifyKeysChanged = () => {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(KEYS_CHANGED_EVENT));
};

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
  const isBrowser = typeof window !== "undefined";

  // Load all saved keys
  const loadKeys = useCallback(() => {
    if (!isBrowser) return [];
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      if (!data) return [];
      const keys = JSON.parse(data);
      return keys.map((item) => ({
        ...item,
        key: decode(item.key)
      }));
    } catch (err) {
      console.error("Failed to load API keys:", err);
      return [];
    }
  }, [isBrowser]);

  // Save a new key (avoid duplicates)
  const saveKey = useCallback((apiKey, label = "") => {
    if (!apiKey || !isBrowser) return;
    try {
      const existing = loadKeys();
      // Check if key already exists - if so, update lastLoginDate
      const existingIndex = existing.findIndex((item) => item.key === apiKey);
      
      if (existingIndex !== -1) {
        // Update existing key's lastLoginDate
        const updated = existing.map((item, idx) => ({
          ...item,
          key: encode(item.key),
          lastLoginDate: idx === existingIndex ? new Date().toISOString() : item.lastLoginDate
        }));
        localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
        return;
      }
      
      const newKey = {
        id: Date.now().toString(),
        key: encode(apiKey),
        label: label || `Key ${existing.length + 1}`,
        createdAt: new Date().toISOString(),
        lastLoginDate: new Date().toISOString()
      };
      const updated = [...existing.map((item) => ({ ...item, key: encode(item.key) })), newKey];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      notifyKeysChanged();
    } catch (err) {
      console.error("Failed to save API key:", err);
    }
  }, [isBrowser, loadKeys]);

  // Remove a key by id
  const removeKey = useCallback((id) => {
    if (!isBrowser) return;
    try {
      const existing = loadKeys();
      const updated = existing
        .filter((item) => item.id !== id)
        .map((item) => ({ ...item, key: encode(item.key) }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      notifyKeysChanged();
    } catch (err) {
      console.error("Failed to remove API key:", err);
    }
  }, [isBrowser, loadKeys]);

  // Clear all saved keys
  const clearKeys = useCallback(() => {
    if (!isBrowser) return;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (err) {
      console.error("Failed to clear API keys:", err);
    }
  }, [isBrowser]);

  // Check if any keys exist
  const hasStoredKeys = useCallback(() => {
    if (!isBrowser) return false;
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      if (!data) return false;
      const keys = JSON.parse(data);
      return keys.length > 0;
    } catch {
      return false;
    }
  }, [isBrowser]);

  // Rename a key (set custom label) by id
  const renameKey = useCallback((id, label) => {
    if (!isBrowser) return;
    try {
      const existing = loadKeys();
      const updated = existing.map((item) => ({
        ...item,
        key: encode(item.key),
        label: item.id === id ? label : (item.label || "")
      }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      notifyKeysChanged();
    } catch (err) {
      console.error("Failed to rename API key:", err);
    }
  }, [isBrowser, loadKeys]);

  // Update last login date for a key
  const updateLastLogin = useCallback((apiKey) => {
    if (!apiKey || !isBrowser) return;
    try {
      const existing = loadKeys();
      const updated = existing.map((item) => ({
        ...item,
        key: encode(item.key),
        lastLoginDate: item.key === apiKey ? new Date().toISOString() : item.lastLoginDate
      }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    } catch (err) {
      console.error("Failed to update last login date:", err);
    }
  }, [isBrowser, loadKeys]);

  return {
    saveKey,
    loadKeys,
    removeKey,
    renameKey,
    clearKeys,
    hasStoredKeys,
    updateLastLogin
  };
}
