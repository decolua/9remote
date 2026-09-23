import { ARTIFACT_STACK_MAX } from "@/features/terminal/constants/terminalConfig";

const dropArtifact = (bySession, sessionId, filePath) => {
  const list = bySession[sessionId];
  if (!list) return bySession;
  const next = list.filter((a) => a.path !== filePath);
  if (next.length === list.length) return bySession;
  const { [sessionId]: _, ...rest } = bySession;
  return next.length ? { ...rest, [sessionId]: next } : rest;
};

const staleAgentHistory = (history, mapRow) => {
  const next = {};
  for (const [cwd, entry] of Object.entries(history)) {
    next[cwd] = { at: 0, sessions: mapRow ? entry.sessions.map(mapRow) : entry.sessions };
  }
  return next;
};

export const createAgentSlice = (set, get) => ({
  // Agent capability flags
  agentCaps: {},
  setAgentCaps: (caps) => set({ agentCaps: caps || {} }),
  artifactEnabled: false,
  setArtifactEnabled: (enabled) => set({ artifactEnabled: !!enabled }),
  mcpClients: [],
  setMcpClients: (ids) => set({ mcpClients: Array.isArray(ids) ? ids : [] }),

  // TUI agent CLIs
  // TUI agent CLIs per host — one machine's PATH list must never show as
  // another's (the fleet's new-terminal modal reads its own host's entry).
  agentClisBy: {},
  setAgentClis: (hostKey, list) => set((state) => ({
    agentClisBy: { ...state.agentClisBy, [hostKey]: { list: Array.isArray(list) ? list : [], at: Date.now() } }
  })),

  // Past agent conversations
  agentHistory: {},
  setAgentHistory: (cwd, sessions) => set((state) => ({
    agentHistory: { ...state.agentHistory, [cwd]: { at: Date.now(), sessions: Array.isArray(sessions) ? sessions : [] } }
  })),
  invalidateAgentHistory: () => set((state) => ({ agentHistory: staleAgentHistory(state.agentHistory) })),

  // Session agent mapping
  agentBySession: {},
  setSessionAgent: (sessionId, agentId) => set((state) => {
    if (state.agentBySession[sessionId] === agentId) return state;
    return {
      agentBySession: { ...state.agentBySession, [sessionId]: agentId }
    };
  }),

  // Startup commands
  pendingStartup: {},
  queueStartup: (sessionId, cmd) => set((state) => ({
    pendingStartup: { ...state.pendingStartup, [sessionId]: cmd }
  })),
  consumeStartup: (sessionId) => {
    const cmd = get().pendingStartup[sessionId];
    if (cmd === undefined) return null;
    set((state) => {
      const { [sessionId]: _, ...rest } = state.pendingStartup;
      return { pendingStartup: rest };
    });
    return cmd;
  },

  // Artifacts
  artifactsBySession: {},
  pushArtifact: (sessionId, item) => set((st) => {
    if (!sessionId || !item?.path) return {};
    const rest = (st.artifactsBySession[sessionId] || []).filter((a) => a.path !== item.path);
    return {
      artifactsBySession: {
        ...st.artifactsBySession,
        [sessionId]: [item, ...rest].slice(0, ARTIFACT_STACK_MAX)
      }
    };
  }),
  removeArtifact: (sessionId, filePath) => set((st) => ({
    artifactsBySession: dropArtifact(st.artifactsBySession, sessionId, filePath)
  }))
});
