"use client";

import { useEffect } from "react";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { AGENT_CLIS_TTL_MS } from "@/features/terminal/constants/terminalConfig";

// TUI agent CLIs detected on the host's PATH, cached in the terminal store.
// Fetches when a modal mounts and the cache is stale/empty.
export function useAgentClis(socketRef) {
  const agentClis = useTerminalStore((s) => s.agentClis);

  useEffect(() => {
    const state = useTerminalStore.getState();
    if (state.agentClis && Date.now() - state.agentClisAt < AGENT_CLIS_TTL_MS) return;
    socketRef?.current?.emit("getAgentClis", (result) => {
      const agents = Array.isArray(result?.agents) ? result.agents : (Array.isArray(result) ? result : null);
      if (agents) useTerminalStore.getState().setAgentClis(agents);
    });
  }, [socketRef]);

  return agentClis;
}
