"use client";
import { create } from "zustand";

export const useOpenClawStore = create((set, get) => ({
  // UI state
  isOpen: false,
  activeAgentId: null,
  chatView: "agents", // "agents" | "chat"
  
  // Data
  agents: [],
  messages: {}, // { [sessionKey]: [{ id, role, content, timestamp }] }
  modelsList: [],
  
  // Streaming
  isStreaming: false,
  streamingText: "",
  
  // Connection
  isConnected: false,
  
  // TTS/Audio
  audioEnabled: {}, // { [agentId]: bool }
  currentAudio: null, // { audio: base64, format, engine }
  
  // File upload
  pendingFiles: [], // [{ type, mimeType, fileName, content, preview }]
  
  // Orchestrator progress
  agentProgress: {}, // { [agentId]: { running: bool, subagents: [] } }
  
  // Config modal
  configModalOpen: false,
  configModalAgentId: null,

  // Actions - UI
  openChat: (agentId) => set({
    isOpen: true,
    ...(agentId !== undefined && { activeAgentId: agentId }),
    chatView: agentId !== undefined ? "chat" : "agents",
  }),
  openAgentList: () => set({ isOpen: true, chatView: "agents", activeAgentId: null }),
  openChatWithAgent: (agentId) => set({ isOpen: true, chatView: "chat", activeAgentId: agentId }),
  backToAgents: () => set({ chatView: "agents", activeAgentId: null }),
  closeChat: () => set({ isOpen: false, chatView: "agents", activeAgentId: null }),
  setActiveAgent: (agentId) => set({ activeAgentId: agentId }),
  
  openConfigModal: (agentId) => set({ configModalOpen: true, configModalAgentId: agentId }),
  closeConfigModal: () => set({ configModalOpen: false, configModalAgentId: null }),
  
  // Actions - Data
  setAgents: (agents) => set({ agents }),
  updateAgent: (agentId, updates) =>
    set((state) => ({
      agents: state.agents.map((agent) =>
        agent.id === agentId ? { ...agent, ...updates } : agent
      ),
    })),
  setModelsList: (models) => set({ modelsList: models }),
  setConnected: (bool) => set({ isConnected: bool }),
  
  addMessage: (sessionKey, message) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [sessionKey]: [...(state.messages[sessionKey] || []), message],
      },
    })),
  
  setMessages: (sessionKey, msgs) =>
    set((state) => ({ messages: { ...state.messages, [sessionKey]: msgs } })),
  
  // Actions - Streaming
  startStreaming: () => set({ isStreaming: true, streamingText: "" }),
  updateStreamingText: (text) => set({ streamingText: text }),
  
  commitStreaming: (sessionKey) => {
    const { streamingText, messages } = get();
    const aiMessage = {
      id: `ai-${Date.now()}`,
      role: "assistant",
      content: streamingText,
      timestamp: new Date().toISOString(),
    };
    set({
      isStreaming: false,
      streamingText: "",
      messages: {
        ...messages,
        [sessionKey]: [...(messages[sessionKey] || []), aiMessage],
      },
    });
  },
  
  abortStreaming: () => set({ isStreaming: false, streamingText: "" }),
  
  // Actions - Audio
  setAudioEnabled: (agentId, enabled) =>
    set((state) => ({ audioEnabled: { ...state.audioEnabled, [agentId]: enabled } })),
  
  setCurrentAudio: (audio) => set({ currentAudio: audio }),
  
  // Actions - Files
  setPendingFiles: (files) => set({ pendingFiles: files }),
  clearPendingFiles: () => set({ pendingFiles: [] }),
  
  // Actions - Progress
  setAgentProgress: (agentId, progress) =>
    set((state) => ({ agentProgress: { ...state.agentProgress, [agentId]: progress } })),
  
  // Helpers
  getSessionKey: (agentId) => (agentId ? `agent:${agentId}:main` : "main"),
  getMessages: (sessionKey) => get().messages[sessionKey] || [],
  isAudioEnabled: (agentId) => get().audioEnabled[agentId] !== false,
}));
