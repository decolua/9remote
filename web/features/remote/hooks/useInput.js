"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { MODIFIER_MAP, SPECIAL_KEYS, REMOTE_CONFIG } from "@/features/remote/constants/REMOTE_CONFIG";

export function useInput(socketEmitFunctions) {
  const [textInputValue, setTextInputValue] = useState("");
  const [isMobile, setIsMobile] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const textInputRef = useRef(null);

  const [modifierKeys, setModifierKeys] = useState({
    ctrl: false,
    cmd: false,
    alt: false,
    shift: false
  });

  const [selectionMode, setSelectionMode] = useState(false);
  const [selectionStart, setSelectionStart] = useState(null);
  const [selectionRect, setSelectionRect] = useState(null);

  const [dragMode, setDragMode] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const scrollIntervalRef = useRef(null);

  // Detect mobile and keyboard
  useEffect(() => {
    const checkMobile = () => {
      const isMobileDevice = window.innerWidth <= 768 || 
        /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
      setIsMobile(isMobileDevice);
      return isMobileDevice;
    };

    const handleResize = () => {
      const mobileDevice = checkMobile();
      if (mobileDevice) {
        const viewportHeight = window.visualViewport?.height || window.innerHeight;
        const windowHeight = window.screen.height;
        setKeyboardVisible(viewportHeight < windowHeight * 0.75);
      } else {
        setKeyboardVisible(false);
      }
    };

    checkMobile();
    window.addEventListener("resize", handleResize);
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", handleResize);
    }

    return () => {
      window.removeEventListener("resize", handleResize);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener("resize", handleResize);
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      if (scrollIntervalRef.current) {
        clearInterval(scrollIntervalRef.current);
      }
    };
  }, []);

  const toggleModifierKey = useCallback((key) => {
    setModifierKeys(prev => ({ ...prev, [key]: !prev[key] }));
    if (isMobile && textInputRef.current) {
      textInputRef.current.focus();
    }
  }, [isMobile]);

  const toggleSelectionMode = useCallback(() => {
    setSelectionMode(prev => !prev);
    setSelectionStart(null);
    setSelectionRect(null);
  }, []);

  const toggleDragMode = useCallback(() => {
    setDragMode(prev => !prev);
    if (isDragging) {
      setIsDragging(false);
    }
  }, [isDragging]);

  const handleTextInputFocus = useCallback(() => {
    // NOTE: Deliberately NO scrollIntoView here.
    // The hidden textarea is anchored at top:0 with 1px size. Calling
    // scrollIntoView({ block: "center" }) pushes the document down so the
    // invisible textarea is centered in the visual viewport — which on Android
    // Chrome creates a visible gap between the bottom RemoteControls bar and
    // the native keyboard. Terminal's MobileKeyboard doesn't do this and sits
    // flush against the keyboard, so we match that behavior.
  }, []);

  // Canvas keydown handler — used by physical keyboard when canvas has focus (PC mode).
  // Preserves case (for Shift-modified chars like "!", "A"), maps special keys via
  // SPECIAL_KEYS, merges UI sticky modifiers with live event modifiers, and prevents
  // the browser from swallowing keys (Tab, F-keys, Backspace, Space, etc.).
  const handleCanvasKeyPress = useCallback((event, streaming) => {
    if (!streaming || !socketEmitFunctions?.emitKeyPress) return;

    const raw = event.key;
    // Skip pure-modifier keys — they only matter as modifiers on the next key.
    if (raw === "Shift" || raw === "Control" || raw === "Meta" || raw === "Alt") return;

    // Always preventDefault so the browser doesn't eat Tab/F5/Space/Backspace/arrows.
    // Leave F12 for DevTools access.
    if (raw !== "F12") event.preventDefault();

    // Merge live event modifiers with sticky UI modifiers (from on-screen Ctrl/Alt/... buttons).
    const modifiers = [];
    if (event.ctrlKey) modifiers.push("control");
    if (event.metaKey) modifiers.push("command");
    if (event.altKey) modifiers.push("alt");
    if (event.shiftKey) modifiers.push("shift");
    const stickyActive = Object.keys(modifierKeys).filter(k => modifierKeys[k]);
    for (const k of stickyActive) {
      const m = MODIFIER_MAP[k];
      if (m && !modifiers.includes(m)) modifiers.push(m);
    }

    // Map special keys; single-char keys pass through as-is to preserve case.
    const key = SPECIAL_KEYS[raw] ?? (raw.length === 1 ? raw : raw.toLowerCase());

    socketEmitFunctions.emitKeyPress(key, modifiers);

    // Clear sticky modifiers after emit (matches emitKeyWithActiveModifiers semantics).
    if (stickyActive.length > 0) {
      setModifierKeys({ ctrl: false, cmd: false, alt: false, shift: false });
    }
  }, [modifierKeys, socketEmitFunctions]);

  // Scroll functions
  const startScroll = useCallback((direction, streaming, horizontal = false) => {
    if (!streaming || !socketEmitFunctions?.emitScroll) return;

    if (scrollIntervalRef.current) {
      clearInterval(scrollIntervalRef.current);
    }

    socketEmitFunctions.emitScroll(direction, 20, horizontal);

    scrollIntervalRef.current = setInterval(() => {
      if (socketEmitFunctions?.emitScroll && streaming) {
        socketEmitFunctions.emitScroll(direction, 20, horizontal);
      }
    }, REMOTE_CONFIG.scrollInterval);

    if (isMobile && textInputRef.current && keyboardVisible) {
      setTimeout(() => textInputRef.current?.focus(), 10);
    }
  }, [isMobile, keyboardVisible, socketEmitFunctions]);

  const startScrollUp = useCallback((streaming) => startScroll("up", streaming), [startScroll]);
  const startScrollDown = useCallback((streaming) => startScroll("down", streaming), [startScroll]);
  const startScrollLeft = useCallback((streaming) => startScroll("left", streaming, true), [startScroll]);
  const startScrollRight = useCallback((streaming) => startScroll("right", streaming, true), [startScroll]);

  const stopScrolling = useCallback(() => {
    if (scrollIntervalRef.current) {
      clearInterval(scrollIntervalRef.current);
      scrollIntervalRef.current = null;
    }
  }, []);

  const sendTextInput = useCallback((streaming) => {
    if (!streaming || !socketEmitFunctions?.emitTypeText) return;
    // Empty input → send lone Enter; otherwise type the buffered text
    if (!textInputValue.trim()) {
      socketEmitFunctions.emitKeyPress?.("enter", []);
      return;
    }
    // Only refocus (which re-opens the soft keyboard) if the input was focused when sending.
    const wasFocused = document.activeElement === textInputRef.current;
    socketEmitFunctions.emitTypeText(textInputValue); // type text only, no Enter
    setTextInputValue("");
    if (wasFocused) textInputRef.current?.focus();
  }, [textInputValue, socketEmitFunctions, textInputRef]);

  // Direct mode (real mobile keyboard): Android IMEs insert chars via input events,
  // not keydown (event.key="Unidentified"), so onChange fires per keystroke. The agent
  // throttles "type-text" to one event / 100ms and DROPS the rest, so sending each
  // char immediately loses fast typing. Buffer chars and flush the whole batch after
  // a short idle so a burst becomes a single emit.
  const directBufRef = useRef("");
  const directTimerRef = useRef(null);
  const handleDirectInputChange = useCallback((value, streaming) => {
    if (!streaming || !value || !socketEmitFunctions?.emitTypeText) return;
    directBufRef.current += value;
    setTextInputValue("");
    if (directTimerRef.current) clearTimeout(directTimerRef.current);
    directTimerRef.current = setTimeout(() => {
      const text = directBufRef.current;
      directBufRef.current = "";
      directTimerRef.current = null;
      if (text) socketEmitFunctions.emitTypeText(text);
    }, 150);
  }, [socketEmitFunctions]);

  // Emit a key with currently active sticky modifiers applied, then clear them.
  const emitKeyWithActiveModifiers = useCallback((key) => {
    if (!socketEmitFunctions?.emitKeyPress) return;
    const activeModifiers = Object.keys(modifierKeys).filter(k => modifierKeys[k]);
    const modifiers = activeModifiers.map(k => MODIFIER_MAP[k]);
    socketEmitFunctions.emitKeyPress(key, modifiers);
    if (activeModifiers.length > 0) {
      setModifierKeys({ ctrl: false, cmd: false, alt: false, shift: false });
    }
  }, [modifierKeys, socketEmitFunctions]);

  const sendBackspace = useCallback((streaming) => {
    if (!streaming) return;
    emitKeyWithActiveModifiers("backspace");
    if (isMobile && textInputRef.current && keyboardVisible) {
      textInputRef.current.focus();
    }
  }, [isMobile, keyboardVisible, emitKeyWithActiveModifiers]);

  const sendArrowKey = useCallback((direction, streaming) => {
    if (!streaming) return;
    emitKeyWithActiveModifiers(direction);
    if (isMobile && textInputRef.current && keyboardVisible) {
      textInputRef.current.focus();
    }
  }, [isMobile, keyboardVisible, emitKeyWithActiveModifiers]);

  const sendEscKey = useCallback((streaming) => {
    if (!streaming) return;
    emitKeyWithActiveModifiers("escape");
    if (isMobile && textInputRef.current && keyboardVisible) {
      textInputRef.current.focus();
    }
  }, [isMobile, keyboardVisible, emitKeyWithActiveModifiers]);

  const sendTabKey = useCallback((streaming) => {
    if (!streaming) return;
    emitKeyWithActiveModifiers("tab");
    if (isMobile && textInputRef.current && keyboardVisible) {
      textInputRef.current.focus();
    }
  }, [isMobile, keyboardVisible, emitKeyWithActiveModifiers]);

  const sendEnterKey = useCallback((event, streaming) => {
    if (!streaming) return;
    emitKeyWithActiveModifiers("enter");
    if (event) event.preventDefault();
    if (isMobile && textInputRef.current && keyboardVisible) {
      textInputRef.current.focus();
    }
  }, [isMobile, keyboardVisible, emitKeyWithActiveModifiers]);

  const handleSelection = useCallback((clientX, clientY, type, options) => {
    const { streaming, getCanvasCoordinates, baseCanvasSize, canvasZoom, canvasPan, percentOverride } = options;
    if (!selectionMode || !streaming || !socketEmitFunctions?.emitMouseDragSelect) return;

    // percentOverride: trackpad mode anchors selection at virtual cursor, not finger.
    const { percentX, percentY } = percentOverride || getCanvasCoordinates(clientX, clientY);

    if (type === "start") {
      setSelectionStart({ x: percentX, y: percentY });
      setSelectionRect(null);
    } else if (type === "move" && selectionStart) {
      const canvasDisplayWidth = baseCanvasSize.width * canvasZoom;
      const canvasDisplayHeight = baseCanvasSize.height * canvasZoom;

      setSelectionRect({
        x: Math.min(selectionStart.x, percentX) * canvasDisplayWidth / 100 + canvasPan.x,
        y: Math.min(selectionStart.y, percentY) * canvasDisplayHeight / 100 + canvasPan.y,
        width: Math.abs(percentX - selectionStart.x) * canvasDisplayWidth / 100,
        height: Math.abs(percentY - selectionStart.y) * canvasDisplayHeight / 100
      });
    } else if (type === "end" && selectionStart) {
      socketEmitFunctions.emitMouseDragSelect(selectionStart.x, selectionStart.y, percentX, percentY);
      setTimeout(() => {
        setSelectionStart(null);
        setSelectionMode(false);
        setSelectionRect(null);
      }, 500);
    }
  }, [selectionMode, selectionStart, socketEmitFunctions]);

  // Handle keydown from native keyboard input field.
  // - directMode=true (keyboardOn + no text panel): send every key directly to agent, don't buffer.
  // - directMode=false (Aa text panel): buffer plain text, only emit on Enter or modifier combos.
  const handleModifiedTextInput = useCallback((event, streaming, directMode = false) => {
    if (!streaming || !socketEmitFunctions?.emitTypeText || !socketEmitFunctions?.emitKeyPress) return;

    let keyToSend = event.key.toLowerCase();
    const isPureModifierKey = ["shift", "control", "meta", "alt"].includes(keyToSend);
    if (isPureModifierKey) return;

    // Android IME fallback: GBoard/Samsung keyboard send event.key="Unidentified"
    // (keyCode=229) for regular character keys. Let onChange handler capture those.
    if (event.key === "Unidentified" || event.keyCode === 229) return;

    const activeModifiers = Object.keys(modifierKeys).filter(key => modifierKeys[key]);
    const hasUIModifiers = activeModifiers.length > 0;
    const hasKeyboardModifiers = event.ctrlKey || event.metaKey || event.altKey || event.shiftKey;

    // Direct mode: every key goes to agent immediately, input value stays empty.
    if (directMode) {
      event.preventDefault();

      let modifiers = activeModifiers.map(k => MODIFIER_MAP[k]);
      if (event.ctrlKey && !modifiers.includes("control")) modifiers.push("control");
      if (event.metaKey && !modifiers.includes("command")) modifiers.push("command");
      if (event.altKey && !modifiers.includes("alt")) modifiers.push("alt");
      if (event.shiftKey && !modifiers.includes("shift")) modifiers.push("shift");

      if (SPECIAL_KEYS[keyToSend]) keyToSend = SPECIAL_KEYS[keyToSend];
      else if (keyToSend === " ") keyToSend = "space";
      else if (event.key.length === 1) keyToSend = event.key; // preserve case

      socketEmitFunctions.emitKeyPress(keyToSend, modifiers);
      if (hasUIModifiers) setModifierKeys({ ctrl: false, cmd: false, alt: false, shift: false });
      setTextInputValue("");
      return;
    }

    // Text panel mode: Enter flushes buffered text
    if (event.key === "Enter") {
      event.preventDefault();
      if (textInputValue.trim()) {
        socketEmitFunctions.emitTypeText(textInputValue);
        setTextInputValue("");
      }
      return;
    }

    const isAlphaNumeric = /^[a-z0-9]$/i.test(event.key);
    const shouldSendAsCombination = (hasUIModifiers || hasKeyboardModifiers) && (!isAlphaNumeric || hasUIModifiers);

    if (shouldSendAsCombination) {
      event.preventDefault();

      let modifiers = activeModifiers.map(key => MODIFIER_MAP[key]);
      if (event.ctrlKey && !modifiers.includes("control")) modifiers.push("control");
      if (event.metaKey && !modifiers.includes("command")) modifiers.push("command");
      if (event.altKey && !modifiers.includes("alt")) modifiers.push("alt");
      if (event.shiftKey && !modifiers.includes("shift")) modifiers.push("shift");

      if (SPECIAL_KEYS[keyToSend]) {
        keyToSend = SPECIAL_KEYS[keyToSend];
      } else if (keyToSend === " ") {
        keyToSend = "space";
      }

      socketEmitFunctions.emitKeyPress(keyToSend, modifiers);
      setModifierKeys({ ctrl: false, cmd: false, alt: false, shift: false });
      setTextInputValue("");
    }
  }, [modifierKeys, textInputValue, socketEmitFunctions]);

  return {
    textInputValue,
    setTextInputValue,
    textInputRef,
    keyboardVisible,
    modifierKeys,
    selectionMode,
    selectionStart,
    selectionRect,
    dragMode,
    isDragging,
    setIsDragging,
    setDragMode,
    toggleModifierKey,
    toggleSelectionMode,
    toggleDragMode,
    handleTextInputFocus,
    handleCanvasKeyPress,
    startScrollUp,
    startScrollDown,
    startScrollLeft,
    startScrollRight,
    stopScrolling,
    sendTextInput,
    sendBackspace,
    sendArrowKey,
    sendEscKey,
    sendTabKey,
    sendEnterKey,
    handleSelection,
    handleModifiedTextInput,
    handleDirectInputChange,
    emitKeyWithActiveModifiers
  };
}
