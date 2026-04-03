"use client";
import { useEffect, useRef, useCallback } from "react";
import { useOpenClawStore } from "@/shared/stores/openclawStore";

const HISTORY_LIMIT = 200;

/**
 * OpenClaw logic hook - handles OpenClaw API calls
 * Similar to useFileSocket - receives socketRef from parent
 */
export function useOpenClaw(socketRef) {
  const {
    addMessage,
    setMessages,
    setAgents,
    updateAgent,
    setModelsList,
    startStreaming,
    updateStreamingText,
    commitStreaming,
    abortStreaming,
    setCurrentAudio,
    setAgentProgress,
    getSessionKey,
    streamingText,
  } = useOpenClawStore();

  const streamingTextRef = useRef(streamingText);
  useEffect(() => { streamingTextRef.current = streamingText; }, [streamingText]);

  // ─── Helpers ───────────────────────────────────────────────────────────────

  // If data is empty object, omit it so servers that expect (cb) still work
  const emit = useCallback((event, data) =>
    new Promise((resolve, reject) => {
      if (!socketRef?.current) return reject(new Error("Not connected"));
      const cb = (res) => {
        if (res?.error) reject(new Error(res.error));
        else resolve(res);
      };
      const hasData = data && Object.keys(data).length > 0;
      if (hasData) socketRef.current.emit(event, data, cb);
      else socketRef.current.emit(event, cb);
    }), [socketRef]);

  // ─── Init event listeners ──────────────────────────────────────────────────

  const loadAgents = useCallback(() => {
    if (!socketRef?.current) return;
    socketRef.current.emit("agents:list", (res) => setAgents(res?.agents || []));
  }, [socketRef, setAgents]);

  const loadModels = useCallback(() => {
    if (!socketRef?.current) return;
    socketRef.current.emit("models:list", (res) => setModelsList(res?.models || []));
  }, [socketRef, setModelsList]);

  useEffect(() => {
    if (!socketRef?.current) return;

    const socket = socketRef.current;

    socket.on("chat:accepted", () => startStreaming());
    socket.on("chat:delta", ({ text }) => updateStreamingText(streamingTextRef.current + text));
    socket.on("chat:done", ({ sessionKey }) => commitStreaming(sessionKey));
    socket.on("chat:error", ({ error }) => { console.error("[OpenClaw] chat:error:", error); abortStreaming(); });
    socket.on("chat:audio", ({ audio, format, engine }) => setCurrentAudio({ audio, format, engine }));
    socket.on("agent:progress", ({ agentId, running, subagents }) => setAgentProgress(agentId, { running, subagents }));

    loadAgents();
    loadModels();

    return () => {
      socket.off("chat:accepted");
      socket.off("chat:delta");
      socket.off("chat:done");
      socket.off("chat:error");
      socket.off("chat:audio");
      socket.off("agent:progress");
    };
  }, [socketRef, startStreaming, updateStreamingText, commitStreaming, abortStreaming, setCurrentAudio, setAgentProgress, loadAgents, loadModels]);

  // ─── Chat ──────────────────────────────────────────────────────────────────

  const sendMessage = useCallback((agentId, message, attachments) => {
    if (!socketRef?.current) return;
    const sessionKey = getSessionKey(agentId);
    addMessage(sessionKey, { id: `user-${Date.now()}`, role: "user", content: message, timestamp: new Date().toISOString() });
    socketRef.current.emit("chat:send", { sessionKey, message, attachments });
  }, [socketRef, addMessage, getSessionKey]);

  const abortMessage = useCallback((agentId) => {
    if (!socketRef?.current) return;
    socketRef.current.emit("chat:abort", { sessionKey: getSessionKey(agentId) });
  }, [socketRef, getSessionKey]);

  const loadHistory = useCallback((agentId) => {
    if (!socketRef?.current) return;
    const sessionKey = getSessionKey(agentId);
    socketRef.current.emit("chat:history", { sessionKey, limit: HISTORY_LIMIT }, ({ messages }) => setMessages(sessionKey, messages || []));
  }, [socketRef, setMessages, getSessionKey]);

  // ─── Agents CRUD ───────────────────────────────────────────────────────────

  const createAgent = useCallback(async (name, emoji, workspace) => {
    const res = await emit("agents:create", { name, emoji, workspace });
    loadAgents();
    return res.agent;
  }, [emit, loadAgents]);

  const deleteAgent = useCallback(async (agentId) => {
    await emit("agents:delete", { agentId });
    loadAgents();
  }, [emit, loadAgents]);

  // ─── Agent config ──────────────────────────────────────────────────────────

  const getAgentConfig = useCallback((agentId) =>
    emit("agent:config:get", { agentId }).then((r) => r.config), [emit]);

  const saveAgentConfig = useCallback(async (agentId, config) => {
    await emit("agent:config:set", { agentId, config });
    // Reload agents from server to ensure sync (wait for completion)
    await new Promise((resolve) => {
      if (!socketRef?.current) return resolve();
      socketRef.current.emit("agents:list", (res) => {
        setAgents(res?.agents || []);
        resolve();
      });
    });
  }, [emit, socketRef, setAgents]);

  const saveAgentToAgent = useCallback((agentId, agentToAgent) =>
    emit("agent:config:patch", { agentId, config: { agentToAgent } }), [emit]);

  // ─── Agent workspace files ─────────────────────────────────────────────────

  const getAgentFile = useCallback((agentId, fileName) =>
    emit("agent:files:get", { agentId, fileName }).then((r) => r.content ?? ""), [emit]);

  const saveAgentFile = useCallback((agentId, fileName, content) =>
    emit("agent:files:set", { agentId, fileName, content }), [emit]);

  const getModels = useCallback(() =>
    emit("models:list").then((r) => r.models ?? []), [emit]);

  // ─── Return ────────────────────────────────────────────────────────────────

  return {
    // Chat
    sendMessage,
    abortMessage,
    loadHistory,
    // Agents
    loadAgents,
    loadModels,
    createAgent,
    deleteAgent,
    // Agent config
    getAgentConfig,
    saveAgentConfig,
    saveAgentToAgent,
    // Agent files
    getAgentFile,
    saveAgentFile,
    // Models
    getModels,
  };
}
