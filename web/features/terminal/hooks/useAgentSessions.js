"use client";

import { useEffect } from "react";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { AGENT_HISTORY_TTL_MS } from "@/features/terminal/constants/terminalConfig";
import { pollWhileVisible } from "@/shared/utils/visibilityPoll";

// One poller per cwd, however many panels read it. The sidebar and the new-terminal
// modal show the same list side by side on desktop; a poller each would double the
// `getAgentSessions` round-trips over the tunnel for one answer.
const pollers = new Map(); // cwd -> { count, stop }

function acquirePoller(busRef, cwd) {
  const existing = pollers.get(cwd);
  if (existing) {
    existing.count += 1;
    return existing;
  }
  // Invalidation backdates every cwd at once, so each reader would ask on the same
  // tick. One request answers all of them.
  let inFlight = false;
  const fetchNow = () => {
    if (inFlight) return;
    inFlight = true;
    busRef?.current?.emit("getAgentSessions", { cwd }, (result) => {
      inFlight = false;
      if (Array.isArray(result?.sessions)) useTerminalStore.getState().setAgentHistory(cwd, result.sessions);
    });
  };
  const entry = { count: 1, fetchNow, stop: pollWhileVisible(fetchNow, AGENT_HISTORY_TTL_MS) };
  pollers.set(cwd, entry);
  return entry;
}

function releasePoller(cwd) {
  const entry = pollers.get(cwd);
  if (!entry) return;
  entry.count -= 1;
  if (entry.count > 0) return;
  entry.stop();
  pollers.delete(cwd);
}

// Past conversations the agent CLIs (Claude Code, Codex, OpenCode, …) kept for
// this directory. Refetches when the terminal moves to another cwd, and on a
// TTL tick while it stays: a conversation started in the terminal above is being
// written to its store right now, and should appear without a reload.
export function useAgentSessions(busRef, cwd) {
  const entry = useTerminalStore((s) => (cwd ? s.agentHistory[cwd] : null));
  // Closing a terminal backdates every cwd's rows; refetching on that timestamp
  // is what turns the invalidation into a refresh instead of a 30s wait.
  const staleAt = entry?.at ?? 0;

  useEffect(() => {
    if (!cwd) return;
    const poller = acquirePoller(busRef, cwd);
    // A second reader joining an already-warm poller must not re-ask on its own —
    // only a cache that has actually aged out is worth a fetch.
    const cached = useTerminalStore.getState().agentHistory[cwd];
    if (!cached || Date.now() - cached.at >= AGENT_HISTORY_TTL_MS) poller.fetchNow();
    return () => releasePoller(cwd);
  }, [busRef, cwd, staleAt]);

  return entry?.sessions || null;
}
