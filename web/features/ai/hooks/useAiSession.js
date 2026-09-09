"use client";

import { useEffect, useRef, useCallback } from "react";
import { useAiStore } from "@/shared/stores/aiStore";

export function useAiSession({
  sessionId,
  engine = "claude",
  workspacePath = "",
  bus = null
}) {
  const busRef = useRef(bus);
  useEffect(() => {
    busRef.current = bus;
  }, [bus]);

  const initSession = useAiStore((s) => s.initSession);
  const setMetadata = useAiStore((s) => s.setMetadata);
  const appendDelta = useAiStore((s) => s.appendDelta);
  const appendThinking = useAiStore((s) => s.appendThinking);
  const appendDiff = useAiStore((s) => s.appendDiff);
  const appendTool = useAiStore((s) => s.appendTool);
  const updateToolResult = useAiStore((s) => s.updateToolResult);
  const setPermission = useAiStore((s) => s.setPermission);
  const clearPermission = useAiStore((s) => s.clearPermission);
  const finishTurn = useAiStore((s) => s.finishTurn);
  const setTurnRunning = useAiStore((s) => s.setTurnRunning);
  const addUserMessage = useAiStore((s) => s.addUserMessage);

  // Read session-specific state from Zustand
  const sessionState = useAiStore((s) => s.bySession[sessionId]);
  const messages = sessionState?.messages || [];
  const isTurnRunning = sessionState?.isTurnRunning || false;
  const stats = sessionState?.stats || { inputTokens: 0, outputTokens: 0, totalTurns: 0 };
  const metadata = sessionState?.metadata || { model: "" };

  // 1. Initialize session in store and on host agent
  useEffect(() => {
    if (!sessionId) return;
    initSession(sessionId);
    if (bus) {
      bus.emit("ai:create", { sessionId, engine, cwd: workspacePath });
    }
  }, [sessionId, engine, workspacePath, bus, initSession]);

  // 2. Subscribe to AI bus events
  useEffect(() => {
    if (!bus || !sessionId) return;

    const handleAiEvent = (payload) => {
      if (!payload || payload.sessionId !== sessionId) return;
      const { event, data } = payload;

      switch (event) {
        case "init":
          setMetadata(sessionId, data);
          break;
        case "delta":
          appendDelta(sessionId, data.text);
          break;
        case "thinking":
          appendThinking(sessionId, data.text);
          break;
        case "diff":
          appendDiff(sessionId, data);
          break;
        case "tool_start":
          appendTool(sessionId, data);
          break;
        case "tool_result":
          updateToolResult(sessionId, data);
          break;
        case "permission_request":
          setPermission(sessionId, data);
          break;
        case "turn_complete":
          finishTurn(sessionId, data.stats);
          break;
        case "stopped":
          setTurnRunning(sessionId, false);
          break;
        default:
          break;
      }
    };

    bus.on("ai:event", handleAiEvent);
    return () => {
      bus.off("ai:event", handleAiEvent);
    };
  }, [
    bus,
    sessionId,
    setMetadata,
    appendDelta,
    appendThinking,
    appendDiff,
    appendTool,
    updateToolResult,
    setPermission,
    finishTurn,
    setTurnRunning
  ]);

  // 3. User actions
  const sendPrompt = useCallback(
    (text) => {
      if (!text || isTurnRunning) return;
      addUserMessage(sessionId, text);
      busRef.current?.emit("ai:prompt", { sessionId, message: text });
    },
    [sessionId, isTurnRunning, addUserMessage]
  );

  const resolvePermission = useCallback(
    (requestId, behavior, message = "", answers = null) => {
      clearPermission(sessionId, requestId);
      if (answers) {
        busRef.current?.emit("ai:question", { sessionId, requestId, answers });
      } else {
        busRef.current?.emit("ai:permission", { sessionId, requestId, behavior, message });
      }
    },
    [sessionId, clearPermission]
  );

  const stop = useCallback(() => {
    busRef.current?.emit("ai:stop", { sessionId });
    setTurnRunning(sessionId, false);
  }, [sessionId, setTurnRunning]);

  const runShell = useCallback(
    (command) => {
      sendPrompt(`! ${command}`);
    },
    [sendPrompt]
  );

  return {
    messages,
    isTurnRunning,
    stats,
    metadata,
    sendPrompt,
    resolvePermission,
    stop,
    runShell
  };
}
