"use client";

import { useCallback } from "react";

async function request(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    credentials: "include"
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

export function useAdminApi() {
  const get = useCallback((url) => request(url), []);
  const post = useCallback((url, body) => request(url, { method: "POST", body: JSON.stringify(body || {}) }), []);
  const patch = useCallback((url, body) => request(url, { method: "PATCH", body: JSON.stringify(body || {}) }), []);
  const del = useCallback((url) => request(url, { method: "DELETE" }), []);
  return { get, post, patch, del };
}
