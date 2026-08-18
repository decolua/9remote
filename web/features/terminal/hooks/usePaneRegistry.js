"use client";

import { useRef, useCallback, useEffect } from "react";

// Registries of per-pane APIs and DOM elements, plus the focus/scroll side effects that
// depend on them (scroll the focused pane into view, preserve input focus across switches).
export function usePaneRegistry({ isDesktop, isTerminalView, activeSessionId, currentView, openedSessions }) {
  const paneApisRef = useRef({});
  const paneElementsRef = useRef({});
  const panesContainerRef = useRef(null);
  const keyboardTextApiRef = useRef(null);
  // Whether the active pane's input is focused — lets us preserve input focus across tab switches
  const inputFocusedRef = useRef(false);

  const registerPaneApi = useCallback((sessionId, api) => {
    if (api) paneApisRef.current[sessionId] = api;
    else delete paneApisRef.current[sessionId];
  }, []);

  const registerPaneElement = useCallback((sessionId, el) => {
    if (el) paneElementsRef.current[sessionId] = el;
    else delete paneElementsRef.current[sessionId];
  }, []);

  const registerKeyboardTextApi = useCallback((api) => {
    keyboardTextApiRef.current = api;
  }, []);

  const handlePasteFallback = useCallback(() => {
    keyboardTextApiRef.current?.openTextPanel?.();
  }, []);

  const handleInputFocusChange = useCallback((focused) => { inputFocusedRef.current = focused; }, []);

  const focusPane = useCallback((sessionId) => paneApisRef.current[sessionId]?.focus?.(), []);
  const focusKeyboardInput = useCallback(() => keyboardTextApiRef.current?.focus?.(), []);

  // Smooth-scroll a pane to the center of the panes row (desktop split-view only)
  const scrollPaneIntoView = useCallback((sessionId) => {
    if (!isDesktop) return;
    const el = paneElementsRef.current[sessionId];
    if (el) el.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }, [isDesktop]);

  // Scroll the focused pane whenever it changes (tab click, ghost click, swipe, deep-link)
  useEffect(() => {
    if (currentView.type !== "terminal") return;
    const id = requestAnimationFrame(() => scrollPaneIntoView(currentView.sessionId));
    return () => cancelAnimationFrame(id);
  }, [currentView, openedSessions, scrollPaneIntoView]);

  // With per-pane inputs, switching tabs unmounts the focused input — refocus the new pane's
  // input only if the previous one was focused, so we don't yank focus from the terminal body.
  useEffect(() => {
    if (!isDesktop || !isTerminalView) return;
    if (!inputFocusedRef.current) return;
    const id = setTimeout(() => keyboardTextApiRef.current?.focus?.(), 60);
    return () => clearTimeout(id);
  }, [activeSessionId, isDesktop, isTerminalView]);

  return {
    panesContainerRef,
    registerPaneApi,
    registerPaneElement,
    registerKeyboardTextApi,
    handlePasteFallback,
    handleInputFocusChange,
    focusPane,
    focusKeyboardInput,
    scrollPaneIntoView
  };
}
