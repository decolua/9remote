"use client";

import { useEffect } from "react";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { AGENT_HISTORY_TTL_MS } from "@/features/terminal/constants/terminalConfig";

// Past conversations the agent CLIs (Claude Code, Codex, OpenCode, …) kept for
// this directory. Refetches when the terminal moves to another cwd, and on a
// TTL tick while it stays: a conversation held in the terminal above is being
// written to its store right now, and should appear without a reload.
export function useAgentSessions(socketRef, cwd) {
  const entry = useTerminalStore((s) => (cwd ? s.agentHistory[cwd] : null));

  useEffect(() => {
    if (!cwd) return;
    const fetchNow = () => {
      socketRef?.current?.emit("getAgentSessions", { cwd }, (result) => {
        if (Array.isArray(result?.sessions)) useTerminalStore.getState().setAgentHistory(cwd, result.sessions);
      });
    };
    const cached = useTerminalStore.getState().agentHistory[cwd];
    if (!cached || Date.now() - cached.at >= AGENT_HISTORY_TTL_MS) fetchNow();
    const timer = setInterval(fetchNow, AGENT_HISTORY_TTL_MS);
    return () => clearInterval(timer);
  }, [socketRef, cwd]);

  return entry?.sessions || null;
}
