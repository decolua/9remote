"use client";

import { useCallback, useEffect, useState } from "react";
import {
  GITHUB_API,
  GITHUB_ENDPOINTS,
  DEVCONTAINER_PATH,
  DEVCONTAINER_TEMPLATE,
  NREMOTE_SECRET_NAME,
  CODESPACE_POLL_INTERVAL_MS,
  CODESPACE_POLL_MAX_ATTEMPTS,
  CODESPACE_STATE
} from "@/shared/constants/github";
import { encryptForGithub, generateApiKey } from "../lib/encryptSecret";

const GITHUB_TOKEN_STORAGE_KEY = "9remote_github_token";
const TOKEN_CHANGE_EVENT = "9remote:githubTokenChange";

function authHeaders(token) {
  return {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
}

async function ghFetch(token, endpoint, options = {}) {
  const res = await fetch(`${GITHUB_API}${endpoint}`, {
    ...options,
    headers: { ...authHeaders(token), ...(options.headers || {}) }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub ${res.status}: ${text || res.statusText}`);
  }
  return res.status === 204 ? null : res.json();
}

export function useGithub() {
  const isBrowser = typeof window !== "undefined";
  const [token, setTokenState] = useState(() => {
    if (!isBrowser) return "";
    return localStorage.getItem(GITHUB_TOKEN_STORAGE_KEY) || "";
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Sync across hook instances via custom event + storage event
  useEffect(() => {
    if (!isBrowser) return;
    const handler = () => {
      setTokenState(localStorage.getItem(GITHUB_TOKEN_STORAGE_KEY) || "");
    };
    window.addEventListener(TOKEN_CHANGE_EVENT, handler);
    window.addEventListener("storage", handler);
    return () => {
      window.removeEventListener(TOKEN_CHANGE_EVENT, handler);
      window.removeEventListener("storage", handler);
    };
  }, [isBrowser]);

  const setToken = useCallback((t) => {
    setTokenState(t);
    if (isBrowser) {
      if (t) localStorage.setItem(GITHUB_TOKEN_STORAGE_KEY, t);
      else localStorage.removeItem(GITHUB_TOKEN_STORAGE_KEY);
      window.dispatchEvent(new Event(TOKEN_CHANGE_EVENT));
    }
  }, [isBrowser]);

  const clearToken = useCallback(() => {
    setToken("");
  }, [setToken]);

  const getUser = useCallback(async (t = token) => {
    return ghFetch(t, GITHUB_ENDPOINTS.user);
  }, [token]);

  const listCodespaces = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await ghFetch(token, GITHUB_ENDPOINTS.codespaces);
      return data.codespaces || [];
    } catch (e) {
      setError(e.message);
      return [];
    } finally {
      setLoading(false);
    }
  }, [token]);

  const getCodespace = useCallback(async (name) => {
    return ghFetch(token, GITHUB_ENDPOINTS.codespaceByName(name));
  }, [token]);

  const startCodespace = useCallback(async (name) => {
    return ghFetch(token, GITHUB_ENDPOINTS.startCodespace(name), { method: "POST" });
  }, [token]);

  const listRepos = useCallback(async () => {
    return ghFetch(token, GITHUB_ENDPOINTS.userReposList);
  }, [token]);

  const createCodespace = useCallback(async (owner, repo) => {
    return ghFetch(token, GITHUB_ENDPOINTS.createCodespaceForRepo(owner, repo), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
  }, [token]);

  // Set NREMOTE_API_KEY codespace secret for a specific repo
  const setApiKeySecret = useCallback(async (repoId, apiKey) => {
    const pk = await ghFetch(token, GITHUB_ENDPOINTS.codespaceSecretsPublicKey);
    const encryptedValue = await encryptForGithub(pk.key, apiKey);
    await ghFetch(token, GITHUB_ENDPOINTS.codespaceSecret(NREMOTE_SECRET_NAME), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        encrypted_value: encryptedValue,
        key_id: pk.key_id,
        selected_repository_ids: [repoId]
      })
    });
  }, [token]);

  // Ensure repo has devcontainer.json with 9remote auto-start. Skip if user already has one.
  const ensureDevcontainer = useCallback(async (owner, repo) => {
    const endpoint = GITHUB_ENDPOINTS.repoContents(owner, repo, DEVCONTAINER_PATH);
    let exists = false;
    try {
      await ghFetch(token, endpoint);
      exists = true;
    } catch {
      // not found
    }
    if (exists) return { existed: true };
    const content = JSON.stringify(DEVCONTAINER_TEMPLATE, null, 2);
    await ghFetch(token, endpoint, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Add 9remote devcontainer",
        content: btoa(unescape(encodeURIComponent(content)))
      })
    });
    return { existed: false };
  }, [token]);

  // Wait until codespace state = Available
  const waitUntilAvailable = useCallback(async (name, onProgress) => {
    for (let i = 0; i < CODESPACE_POLL_MAX_ATTEMPTS; i++) {
      const cs = await getCodespace(name);
      onProgress?.(cs.state);
      if (cs.state === CODESPACE_STATE.available) return cs;
      await new Promise((r) => setTimeout(r, CODESPACE_POLL_INTERVAL_MS));
    }
    throw new Error("Codespace start timeout");
  }, [getCodespace]);

  return {
    token,
    setToken,
    clearToken,
    loading,
    error,
    getUser,
    listCodespaces,
    getCodespace,
    startCodespace,
    waitUntilAvailable,
    listRepos,
    createCodespace,
    ensureDevcontainer,
    setApiKeySecret,
    generateApiKey
  };
}
