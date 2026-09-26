"use client";

import { useCallback, useEffect, useState } from "react";
import { isAgentEnvironment } from "@/shared/utils/localOrigin";

// Agent-local settings, reachable only on the origin the agent itself serves
// (same localhost-only APIs the agent dashboard uses). Outside that context
// every call is skipped and the state stays inert.
export function useAgentLocalSettings() {
  const [autoStart, setAutoStart] = useState(null); // null = unknown yet
  const [unlock, setUnlock] = useState(null);       // agent /api/desktop-unlock payload

  useEffect(() => {
    if (!isAgentEnvironment()) return;
    fetch("/api/autostart", { cache: "no-store" }).then((r) => r.json())
      .then((d) => setAutoStart(!!d?.enabled)).catch(() => {});
    fetch("/api/desktop-unlock", { cache: "no-store" }).then((r) => r.json())
      .then((d) => setUnlock(d)).catch(() => {});
  }, []);

  const refreshUnlock = useCallback(() => {
    fetch("/api/desktop-unlock", { cache: "no-store" }).then((r) => r.json())
      .then((d) => setUnlock(d)).catch(() => {});
  }, []);

  // Optimistic toggle — the POST answers no payload, so rollback only on failure.
  const toggleAutoStart = useCallback((next) => {
    setAutoStart(next);
    fetch("/api/autostart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next })
    }).catch(() => setAutoStart((cur) => (cur === next ? !next : cur)));
  }, []);

  const toggleUnlock = useCallback(() => {
    const action = unlock?.enabled ? "uninstall" : "install";
    setUnlock((u) => (u ? { ...u, busy: true } : u));
    fetch(`/api/desktop-unlock/${action}`, { method: "POST" })
      .then(refreshUnlock)
      .catch(refreshUnlock);
  }, [unlock, refreshUnlock]);

  const stopAgent = useCallback(() => {
    fetch("/api/ui/stop", { method: "POST" }).catch(() => {});
  }, []);

  const shutdownAgent = useCallback(() => {
    fetch("/api/ui/shutdown", { method: "POST" }).catch(() => {});
  }, []);

  return { autoStart, unlock, toggleAutoStart, toggleUnlock, stopAgent, shutdownAgent };
}
