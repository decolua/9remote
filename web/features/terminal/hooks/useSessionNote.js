"use client";

import { useState, useEffect, useRef, useCallback } from "react";

// Per-session note backed by agent storage (socket getNote/saveNote).
// Debounced auto-save 500ms after the last edit.
const SAVE_DEBOUNCE_MS = 500;

export function useSessionNote(socket, sessionId) {
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const textRef = useRef("");
  const saveTimerRef = useRef(null);

  // Load on mount / when session changes
  useEffect(() => {
    if (!socket || !sessionId) { setText(""); textRef.current = ""; setLoaded(false); return; }
    let cancelled = false;
    setLoaded(false);
    socket.emit("getNote", { sessionId }, (res) => {
      if (cancelled) return;
      const value = res?.success ? (res.text || "") : "";
      setText(value);
      textRef.current = value;
      setLoaded(true);
    });
    return () => { cancelled = true; };
  }, [socket, sessionId]);

  const doSave = useCallback((value) => {
    if (!socket || !sessionId) return;
    socket.emit("saveNote", { sessionId, text: value });
  }, [socket, sessionId]);

  // Debounced auto-save — latest value read from ref at fire time
  const update = useCallback((next) => {
    setText(next);
    textRef.current = next;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      doSave(textRef.current);
    }, SAVE_DEBOUNCE_MS);
  }, [doSave]);

  // Flush pending save on unmount / session switch
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        doSave(textRef.current);
      }
    };
  }, [doSave]);

  return { text, setText: update, loaded };
}
