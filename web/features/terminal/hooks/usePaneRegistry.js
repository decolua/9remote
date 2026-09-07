"use client";

import { useRef, useCallback, useEffect, useMemo } from "react";

// Registries of per-pane APIs and DOM elements, plus the focus/scroll side effects that
// depend on them (scroll the focused pane into view, preserve input focus across switches).
export function usePaneRegistry({ isDesktop, isTerminalView, activeSessionId, currentView, openedSessions }) {
  const paneApisRef = useRef({});
  const paneElementsRef = useRef({});
  const panesContainerRef = useRef(null);
  const keyboardTextApiRef = useRef(null);
  // Whether the active pane's input is focused — lets us preserve input focus across tab switches
  const inputFocusedRef = useRef(false);
  const pendingFocusSessionRef = useRef(null);

  const registerPaneApi = useCallback((sessionId, api) => {
    if (api) paneApisRef.current[sessionId] = api;
    else delete paneApisRef.current[sessionId];
  }, []);

  // Pure node registration — never trigger scroll on ref attach/detach
  const registerPaneElement = useCallback((sessionId, el) => {
    if (el) paneElementsRef.current[sessionId] = el;
    else delete paneElementsRef.current[sessionId];
  }, []);

  const registerKeyboardTextApi = useCallback((api) => {
    keyboardTextApiRef.current = api;
    if (api && pendingFocusSessionRef.current && isDesktop) {
      pendingFocusSessionRef.current = null;
      inputFocusedRef.current = true;
      setTimeout(() => api.focus?.(), 50);
    }
  }, [isDesktop]);

  const requestFocus = useCallback((sessionId) => {
    if (!isDesktop) return;
    pendingFocusSessionRef.current = sessionId;
    inputFocusedRef.current = true;
    setTimeout(() => {
      if (keyboardTextApiRef.current?.focus) {
        keyboardTextApiRef.current.focus();
      } else {
        paneApisRef.current[sessionId]?.focus?.();
      }
    }, 60);
  }, [isDesktop]);

  const handlePasteFallback = useCallback(() => {
    keyboardTextApiRef.current?.openTextPanel?.();
  }, []);

  const handleInputFocusChange = useCallback((focused) => { inputFocusedRef.current = focused; }, []);

  const focusPane = useCallback((sessionId) => paneApisRef.current[sessionId]?.focus?.(), []);
  const focusKeyboardInput = useCallback(() => {
    keyboardTextApiRef.current?.focus?.();
  }, []);

  // Smooth-scroll a pane to the center of the panes row (desktop split-view only)
  const scrollPaneIntoView = useCallback((sessionId) => {
    if (!isDesktop) return;
    const el = paneElementsRef.current[sessionId];
    if (el) el.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }, [isDesktop]);

  // Scroll the focused pane ONLY when the active session actually changes
  const prevFocusedSessionRef = useRef(null);
  useEffect(() => {
    if (!isDesktop || currentView?.type !== "terminal" || !currentView?.sessionId) return;
    if (prevFocusedSessionRef.current === currentView.sessionId) return;
    prevFocusedSessionRef.current = currentView.sessionId;
    const id = requestAnimationFrame(() => scrollPaneIntoView(currentView.sessionId));
    return () => cancelAnimationFrame(id);
  }, [currentView?.type, currentView?.sessionId, isDesktop, scrollPaneIntoView]);

  // With per-pane inputs, switching tabs unmounts the focused input — refocus the new pane's
  // input if it was focused, otherwise focus the terminal body.
  useEffect(() => {
    if (!isDesktop || !isTerminalView || !activeSessionId) return;
    const id = setTimeout(() => {
      if (inputFocusedRef.current) {
        keyboardTextApiRef.current?.focus?.();
      } else {
        paneApisRef.current[activeSessionId]?.focus?.();
      }
    }, 60);
    return () => clearTimeout(id);
  }, [activeSessionId, isDesktop, isTerminalView]);

  return useMemo(() => ({
    panesContainerRef,
    registerPaneApi,
    registerPaneElement,
    registerKeyboardTextApi,
    handlePasteFallback,
    handleInputFocusChange,
    focusPane,
    focusKeyboardInput,
    scrollPaneIntoView,
    requestFocus
  }), [
    registerPaneApi,
    registerPaneElement,
    registerKeyboardTextApi,
    handlePasteFallback,
    handleInputFocusChange,
    focusPane,
    focusKeyboardInput,
    scrollPaneIntoView,
    requestFocus
  ]);
}
