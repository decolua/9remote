"use client";

import { useEffect } from "react";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { AGENT_CLIS_TTL_MS } from "@/features/terminal/constants/terminalConfig";

// TUI agent CLIs detected on the host's PATH, cached per host in the terminal
// store. Fetches when a modal mounts and that host's cache is stale/empty.
export function useAgentClis(busRef, hostKey = "main") {
  const agentClis = useTerminalStore((s) => s.agentClisBy[hostKey]?.list);

  useEffect(() => {
    const entry = useTerminalStore.getState().agentClisBy[hostKey];
    if (entry && Date.now() - entry.at < AGENT_CLIS_TTL_MS) return;
    busRef?.current?.emit("getAgentClis", (result) => {
      const agents = Array.isArray(result?.agents) ? result.agents : (Array.isArray(result) ? result : null);
      if (agents) useTerminalStore.getState().setAgentClis(hostKey, agents);
    });
  }, [busRef, hostKey]);

  return agentClis;
}
