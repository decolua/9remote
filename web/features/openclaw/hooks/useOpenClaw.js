"use client";
import { useEffect, useRef, useCallback } from "react";
import { useSessionStorage } from "@/shared/hooks/useSessionStorage";
import { WsProtocol } from "@/shared/transport/WsProtocol";
import { useOpenClawStore } from "@/shared/stores/openclawStore";

const NAMESPACE = "/openclaw";
const HISTORY_LIMIT = 200;

export function useOpenClaw() {
  const { getAuth } = useSessionStorage();
  const socketRef = useRef(null);

  const {
    addMessage,
    setMessages,
    setAgents,
    setModelsList,
    setConnected,
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

  const loadAgents = useCallback(() => {
    if (!socketRef.current) return;
    socketRef.current.emit("agents:list", ({ agents }) => setAgents(agents || []));
  }, [setAgents]);

  const loadModels = useCallback(() => {
    if (!socketRef.current) return;
    socketRef.current.emit("models:list", ({ models }) => setModelsList(models || []));
  }, [setModelsList]);

  useEffect(() => {
    const auth = getAuth();
    if (!auth?.tunnelUrl) return;

    const protocol = new WsProtocol({
      tunnelUrl: auth.tunnelUrl,
      localIp: auth.localIp || null,
      namespace: NAMESPACE,
      socketOptions: { auth: { apiKey: auth.apiKey } },
      onConnect: (socket) => {
        socketRef.current = socket;
        setConnected(true);

        socket.on("chat:accepted", () => {
          startStreaming();
        });

        socket.on("chat:delta", ({ text }) => {
          updateStreamingText(streamingTextRef.current + text);
        });

        socket.on("chat:done", ({ sessionKey }) => {
          commitStreaming(sessionKey);
        });

        socket.on("chat:error", ({ error }) => {
          console.error("[OpenClaw] chat:error:", error);
          abortStreaming();
        });

        socket.on("chat:audio", ({ audio, format, engine }) => {
          setCurrentAudio({ audio, format, engine });
        });

        socket.on("agent:progress", ({ agentId, running, subagents }) => {
          setAgentProgress(agentId, { running, subagents });
        });

        loadAgents();
        loadModels();
      },
      onDisconnect: () => {
        socketRef.current = null;
        setConnected(false);
      },
      onRetryStatus: () => {},
    });

    protocol.connect();
    return () => { protocol.disconnect(); socketRef.current = null; };
  }, []);

  const sendMessage = useCallback((agentId, message, attachments) => {
    if (!socketRef.current) return;
    const sessionKey = getSessionKey(agentId);
    const userMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: message,
      timestamp: new Date().toISOString(),
    };
    addMessage(sessionKey, userMessage);
    socketRef.current.emit("chat:send", { sessionKey, message, attachments });
  }, [addMessage, getSessionKey]);

  const abortMessage = useCallback((agentId) => {
    if (!socketRef.current) return;
    const sessionKey = getSessionKey(agentId);
    socketRef.current.emit("chat:abort", { sessionKey });
  }, [getSessionKey]);

  const loadHistory = useCallback((agentId) => {
    if (!socketRef.current) return;
    const sessionKey = getSessionKey(agentId);
    socketRef.current.emit("chat:history", { sessionKey, limit: HISTORY_LIMIT }, ({ messages }) => {
      setMessages(sessionKey, messages || []);
    });
  }, [setMessages, getSessionKey]);

  const createAgent = useCallback((name, emoji, workspace) => {
    if (!socketRef.current) return Promise.reject(new Error("Not connected"));
    return new Promise((resolve, reject) => {
      socketRef.current.emit("agents:create", { name, emoji, workspace }, (res) => {
        if (res?.error) reject(new Error(res.error));
        else {
          loadAgents();
          resolve(res.agent);
        }
      });
    });
  }, [loadAgents]);

  const deleteAgent = useCallback((agentId) => {
    if (!socketRef.current) return Promise.reject(new Error("Not connected"));
    return new Promise((resolve, reject) => {
      socketRef.current.emit("agents:delete", { agentId }, (res) => {
        if (res?.error) reject(new Error(res.error));
        else {
          loadAgents();
          resolve();
        }
      });
    });
  }, [loadAgents]);

  const connected = useOpenClawStore((s) => s.isConnected);

  return {
    connected,
    socketRef,
    sendMessage,
    abortMessage,
    loadHistory,
    loadAgents,
    loadModels,
    createAgent,
    deleteAgent,
  };
}
