"use client";

import { useFleetStore, fleetBusOf } from "@/shared/stores/fleetStore";

/**
 * The same action set the main host gets from nav/useAgentBus, implemented over a
 * fleet background bus — the DRY seam: a tree never learns which kind of host it
 * draws, it just consumes these. Emits use the host's RAW ids (the agent knows its
 * own); optimistic patches keep the tree responsive until the agent's
 * sessionsChanged broadcast refetch lands.
 */
export function makeFleetActions(host, { onSelectSession = null } = {}) {
  const bus = () => fleetBusOf(host.key);

  const patchSessions = (fn) => {
    const st = useFleetStore.getState();
    const cur = st.hosts[host.key]?.sessions || [];
    st._patchHost(host.key, { sessions: fn(cur) });
  };

  return {
    // Selecting is also the lazy-connect door: a tap opens the host's bus if it
    // is not up yet (side effects belong here, never in a render path).
    selectSession: (sessionId) => {
      useFleetStore.getState().ensureHost(host.key);
      onSelectSession?.(sessionId);
    },
    createSession: (name, workspaceId, shellId, cwd, agent, yolo, nameIsAuto, callback) => {
      // The modal hands the picked OPTION object; the wire and the tree want its id.
      const agentId = typeof agent === "string" ? agent : (agent?.id || null);
      const b = bus();
      // Bus not up yet (lazy): open it and give up silently — the next press lands.
      if (!b) { useFleetStore.getState().ensureHost(host.key); return; }
      b.emit("createSession",
        { name, shellId, workspaceId, cwd, nameIsAuto, agent: agentId },
        (res) => {
          if (res?.success && res.sessionId) {
            patchSessions((prev) => prev.some((s) => s.id === res.sessionId) ? prev : [...prev, {
              id: res.sessionId, name: res.name || name || "", createdAt: Date.now(),
              cwd: res.cwd || cwd || null, workspaceId: workspaceId || null,
              shellId: res.shellId || shellId || null, agent: agentId
            }]);
            onSelectSession?.(res.sessionId);
          }
          callback?.(res);
        });
    },
    renameSession: (sessionId, name) => {
      bus()?.emit("renameSession", { sessionId, name }, () => {});
      patchSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, name } : s)));
    },
    deleteSession: (sessionId) => {
      bus()?.emit("deleteSession", sessionId, () => {});
      patchSessions((prev) => prev.filter((s) => s.id !== sessionId));
    },
    reorderSession: (orderedIds) => {
      bus()?.emit("reorderSession", { orderedIds }, () => {});
      const rank = new Map(orderedIds.map((id, i) => [id, i]));
      patchSessions((prev) => [...prev].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity)));
    },
    renameWorkspace: (workspaceId, name) => {
      bus()?.emit("renameWorkspace", { workspaceId, name }, () => {});
    },
    deleteWorkspace: (workspaceId) => {
      bus()?.emit("deleteWorkspace", { workspaceId }, () => {});
    }
  };
}
