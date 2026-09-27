"use client";

import { useCallback, useEffect, useState } from "react";
import { isHostEnvironment } from "@/shared/utils/localOrigin";

// Host-local settings, reachable only on the origin the host itself serves
// (same localhost-only APIs the host dashboard uses). Outside that context
// every call is skipped and the state stays inert.
export function useHostLocalSettings() {
  const [autoStart, setAutoStart] = useState(null); // null = unknown yet
  const [unlock, setUnlock] = useState(null);       // host /api/desktop-unlock payload

  useEffect(() => {
    if (!isHostEnvironment()) return;
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

  const stopHost = useCallback(() => {
    fetch("/api/ui/stop", { method: "POST" }).catch(() => {});
  }, []);

  const shutdownHost = useCallback(() => {
    fetch("/api/ui/shutdown", { method: "POST" }).catch(() => {});
  }, []);

  return {
    autoStart,
    unlock,
    toggleAutoStart,
    toggleUnlock,
    stopHost,
    shutdownHost,
    stopAgent: stopHost,
    shutdownAgent: shutdownHost
  };
}
export const useAgentLocalSettings = useHostLocalSettings;
