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
    if (isMobile && textInputRef.current) {
      setTimeout(() => {
        textInputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 300);
    }
  }, [isMobile]);

  const handleCanvasKeyPress = useCallback((event, streaming) => {
    if (!streaming || !socketEmitFunctions?.emitKeyPress) return;

    if (event.ctrlKey || event.metaKey || event.altKey) {
      event.preventDefault();
    }

    const key = event.key.toLowerCase();
    const modifier = [];
    if (event.ctrlKey) modifier.push("control");
    if (event.metaKey) modifier.push("command");
    if (event.altKey) modifier.push("alt");
    if (event.shiftKey) modifier.push("shift");

    socketEmitFunctions.emitKeyPress(key, modifier);
  }, [socketEmitFunctions]);

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
    if (!textInputValue.trim() || !streaming || !socketEmitFunctions?.emitTypeText) return;
    socketEmitFunctions.emitTypeText(textInputValue);
    setTextInputValue("");
  }, [textInputValue, socketEmitFunctions]);

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
    const { streaming, getCanvasCoordinates, baseCanvasSize, canvasZoom, canvasPan } = options;
    if (!selectionMode || !streaming || !socketEmitFunctions?.emitMouseDragSelect) return;

    const { percentX, percentY } = getCanvasCoordinates(clientX, clientY);

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
    handleModifiedTextInput
  };
}
