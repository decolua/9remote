"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";

const PREFIX = "9remote_nav:";

// Build full URL (path + query) from Next router primitives
function buildUrl(pathname, searchParams) {
  if (!pathname) return "";
  const qs = searchParams?.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

export const saveLastRoute = (apiKey, url) => {
  if (typeof window === "undefined" || !apiKey || !url) return;
  try { localStorage.setItem(PREFIX + apiKey, url); } catch {}
};

export const getLastRoute = (apiKey) => {
  if (typeof window === "undefined" || !apiKey) return null;
  try { return localStorage.getItem(PREFIX + apiKey); } catch { return null; }
};

export const clearLastRoute = (apiKey) => {
  if (typeof window === "undefined" || !apiKey) return;
  try { localStorage.removeItem(PREFIX + apiKey); } catch {}
};

/**
 * Persists the current workspace URL under the given apiKey on every route change.
 * Only tracks routes under /workspace — login/admin are not session state to restore.
 */
export function useLastRoute(apiKey) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!apiKey || !pathname?.startsWith("/workspace")) return;
    const url = buildUrl(pathname, searchParams);
    if (url) saveLastRoute(apiKey, url);
  }, [apiKey, pathname, searchParams]);
}
