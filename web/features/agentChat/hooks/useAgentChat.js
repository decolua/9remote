"use client";

import { useCallback, useEffect, useState } from "react";
import { EVENTS } from "../constants/agentChatConfig";
import { acquire, release, refresh } from "../lib/agentChatStore";

const EMPTY = { hasAgent: false, tool: null, prompt: null, activity: [], optionCount: 0, stale: false };

/**
 * Live view of what the AI CLI in this pane is doing and waiting on.
 *
 * Read-only mirror of the TUI — sending a decision types keys into the same PTY. The
 * subscription is shared per session, so the pane (for its toggle) and the chat view (for
 * its transcript) cost one round-trip between them, not two.
 */
export function useAgentChat(socket, sessionId, { enabled = true } = {}) {
  const [state, setState] = useState(EMPTY);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!socket || !sessionId || !enabled) return;
    const handle = acquire(socket, sessionId, setState);
    return () => release(socket, sessionId, handle);
  }, [socket, sessionId, enabled]);

  const { prompt } = state;

  const respond = useCallback((choice) => new Promise((resolve) => {
    if (!socket || !prompt) return resolve({ success: false });
    setError(null);
    socket.emit(EVENTS.RESPOND, { sessionId, promptId: prompt.promptId, choice }, (res) => {
      // A refusal means the screen no longer matches what we are answering — surface it
      // rather than retrying, and re-read so the card reflects what is actually up.
      if (!res?.success) {
        setError(res?.error || "failed");
        refresh(socket, sessionId);
      }
      resolve(res || { success: false });
    });
  }), [socket, sessionId, prompt]);

  const sendText = useCallback((text) => new Promise((resolve) => {
    if (!socket) return resolve({ success: false });
    setError(null);
    socket.emit(EVENTS.SEND_TEXT, { sessionId, text }, (res) => {
      if (!res?.success) setError(res?.error || "failed");
      resolve(res || { success: false });
    });
  }), [socket, sessionId]);

  const interrupt = useCallback(() => {
    socket?.emit(EVENTS.INTERRUPT, { sessionId }, () => {});
  }, [socket, sessionId]);

  return {
    ...state,
    error,
    respond,
    sendText,
    interrupt,
    refresh: () => refresh(socket, sessionId),
  };
}
