"use client";

import { useEffect } from "react";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { useFleetStore } from "@/shared/stores/fleetStore";
import { AGENT_CLIS_TTL_MS } from "@/features/terminal/constants/terminalConfig";

// TUI agent CLIs detected on the host's PATH, cached per host in the terminal
// store. Fetches when a modal mounts and that host's cache is stale/empty.
export function useAgentClis(busRef, hostKey = "main") {
  const agentClis = useTerminalStore((s) => s.agentClisBy[hostKey]?.list);
  // A lazy bus opens after mount — the status flip is what retriggers the fetch.
  const hostStatus = useFleetStore((s) => s.hosts[hostKey]?.status || null);

  useEffect(() => {
    const entry = useTerminalStore.getState().agentClisBy[hostKey];
    if (entry && Date.now() - entry.at < AGENT_CLIS_TTL_MS) return;
    busRef?.current?.emit("getAgentClis", (result) => {
      const agents = Array.isArray(result?.agents) ? result.agents : (Array.isArray(result) ? result : null);
      if (agents) useTerminalStore.getState().setAgentClis(hostKey, agents);
    });
  }, [busRef, hostKey, hostStatus]);

  return agentClis;
}
