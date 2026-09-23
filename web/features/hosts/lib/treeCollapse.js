"use client";

import { useCallback, useState } from "react";

// Tree collapse state, persisted per device (localStorage) and per host — a
// workspace the user closed stays closed across reloads. Default is open.
const KEY = "9remote_tree_collapsed";
export const TREE_ROOT = "_root";

function loadAll() {
  if (typeof window === "undefined") return {};
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}

export function useTreeCollapse(hostKey = "") {
  const [collapsed, setCollapsed] = useState(() => new Set(loadAll()[hostKey] || []));

  const toggle = useCallback((id) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      const all = loadAll();
      all[hostKey] = [...next];
      try { localStorage.setItem(KEY, JSON.stringify(all)); } catch {}
      return next;
    });
  }, [hostKey]);

  const isCollapsed = useCallback((id) => collapsed.has(id), [collapsed]);
  return { isCollapsed, toggle };
}
