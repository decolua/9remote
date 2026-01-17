"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { SPECIAL_KEYS, CTRL_ARROW_KEYS } from "@/features/terminal/constants/keyMappings";
import { BASIC_KEYS, EXTENDED_KEYS, MAC_KEY, BUTTON_STYLES } from "@/features/terminal/constants/terminalConfig";

const MobileKeyboard = ({ socket, sessionId, onExpandChange, onRefocus }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [showTextInput, setShowTextInput] = useState(false);
  const [textInput, setTextInput] = useState("");
  const [isMobile, setIsMobile] = useState(false);
  const textInputRef = useRef(null);
  
  // Detect OS once on mount - no effect needed
  const os = useMemo(() => {
    if (typeof window === "undefined") return "linux";
    const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
    return isMac ? "macos" : "linux";
  }, []);
  
  const [ctrlPressed, setCtrlPressed] = useState(false);
  const [metaPressed, setMetaPressed] = useState(false);
  const [altPressed, setAltPressed] = useState(false);
  const [shiftPressed, setShiftPressed] = useState(false);

  // Smart combination generator - handles all key combinations
  const generateCombination = useCallback((key, modifiers = {}) => {
    const ctrl = modifiers.ctrl || ctrlPressed;
    const alt = modifiers.alt || altPressed;
    const shift = modifiers.shift || shiftPressed;
    const meta = modifiers.meta || metaPressed;

    let data = "";

    // Handle Ctrl combinations for alphanumeric keys
    if (ctrl && key.length === 1) {
      const upperKey = key.toUpperCase();
      const charCode = upperKey.charCodeAt(0);
      
      // Ctrl+A-Z (ASCII control codes)
      if (charCode >= 65 && charCode <= 90) {
        const controlCode = charCode - 64; // A=1, B=2, ..., Z=26
        data = String.fromCharCode(controlCode);
      }
      // Ctrl+special chars
      else if (key === "[") data = "\x1b"; // Ctrl+[ = ESC
      else if (key === "]") data = "\x1d";
      else if (key === "\\") data = "\x1c";
      else if (key === "@") data = "\x00";
      else if (key === "?") data = "\x7f";
      else {
        data = key; // Fallback
      }
    }
    // Handle Alt combinations
    else if (alt) {
      if (SPECIAL_KEYS[key]) {
        // Alt + special key: prefix with ESC
        data = "\x1b" + SPECIAL_KEYS[key];
      } else if (key.length === 1) {
        // Alt + character: prefix with ESC
        data = "\x1b" + key;
      } else {
        data = SPECIAL_KEYS[key] || key;
      }
    }
    // Handle Ctrl + special keys (arrows, Home, End, etc.)
    else if (ctrl && SPECIAL_KEYS[key]) {
      // Ctrl modifies the escape sequence
      if (key.startsWith("Arrow")) {
        data = CTRL_ARROW_KEYS[key] || SPECIAL_KEYS[key];
      } else if (key === "Home") {
        data = "\x1b[1;5H";
      } else if (key === "End") {
        data = "\x1b[1;5F";
      } else {
        data = SPECIAL_KEYS[key];
      }
    }
    // Handle Shift combinations (mostly for uppercase)
    else if (shift && key.length === 1) {
      data = key.toUpperCase();
    }
    // No modifiers - just send the key
    else {
      data = SPECIAL_KEYS[key] || key;
    }

    return data;
  }, [ctrlPressed, altPressed, shiftPressed, metaPressed]);

  useEffect(() => {
    // Detect mobile device
    const checkMobile = () => {
      const mobile = window.innerWidth < 768 || 
                    ("ontouchstart" in window) || 
                    (navigator.maxTouchPoints > 0);
      setIsMobile(mobile);
    };
    
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  // Intercept keyboard input when modifiers are active
  useEffect(() => {
    if (!isMobile || !socket || !sessionId) return;
    
    const hasActiveModifier = ctrlPressed || metaPressed || altPressed || shiftPressed;
    if (!hasActiveModifier) return;

    const handleKeyDown = (e) => {
      // Only intercept if we have an active modifier
      if (!ctrlPressed && !metaPressed && !altPressed && !shiftPressed) return;

      // Don't intercept modifier keys themselves
      if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;

      // Prevent default to stop normal input
      e.preventDefault();
      e.stopPropagation();

      // Get the key to send
      let key = e.key;
      
      // Map special keys
      if (key === "Backspace") key = "Backspace";
      else if (key === "Enter") key = "Enter";
      else if (key === "Tab") key = "Tab";
      else if (key === "Escape") key = "Escape";
      else if (key === "Delete") key = "Delete";
      else if (key.startsWith("Arrow")) key = e.key;
      else if (key.startsWith("F") && key.length <= 3) key = e.key; // F1-F12
      
      // Send the combination
      const data = generateCombination(key, {
        ctrl: ctrlPressed,
        alt: altPressed,
        shift: shiftPressed,
        meta: metaPressed
      });

      socket.emit("input", { sessionId, data });

      // Reset modifiers after sending
      setCtrlPressed(false);
      setMetaPressed(false);
      setAltPressed(false);
      setShiftPressed(false);
    };

    // Add listener to document
    document.addEventListener("keydown", handleKeyDown, true);

    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [isMobile, socket, sessionId, ctrlPressed, metaPressed, altPressed, shiftPressed, generateCombination]);

  if (!isMobile || !socket || !sessionId) return null;

  const handleModifierToggle = (modifier) => {
    if (modifier === "Ctrl") {
      setCtrlPressed(!ctrlPressed);
    } else if (modifier === "Meta") {
      setMetaPressed(!metaPressed);
    } else if (modifier === "Alt") {
      setAltPressed(!altPressed);
    } else if (modifier === "Shift") {
      setShiftPressed(!shiftPressed);
    }
  };

  const sendKey = (key, forceModifiers = {}) => {
    const data = generateCombination(key, forceModifiers);
    
    // Send directly via socket - same as real keyboard input
    socket.emit("input", { sessionId, data });

    // Reset modifier states after sending (unless it was a modifier key click)
    if (key !== "Ctrl" && key !== "Meta" && key !== "Alt" && key !== "Shift") {
      setCtrlPressed(false);
      setMetaPressed(false);
      setAltPressed(false);
      setShiftPressed(false);
    }
  };

  const toggleExpanded = () => {
    const newState = !isExpanded;
    setIsExpanded(newState);
    setShowTextInput(false); // Close text input when toggling extended
    
    // Hide mobile keyboard when expanding
    if (newState) {
      document.activeElement?.blur();
    }

    // Call callback after animation completes (300ms)
    if (onExpandChange) {
      setTimeout(() => onExpandChange(newState), 320);
    }
  };

  const toggleTextInput = () => {
    const newState = !showTextInput;
    setShowTextInput(newState);
    setIsExpanded(false); // Close extended when opening text input
    if (onExpandChange) {
      setTimeout(() => onExpandChange(newState), 320);
    }
    // Focus input when opening, refocus terminal when closing
    if (newState) {
      setTimeout(() => textInputRef.current?.focus(), 350);
    } else if (onRefocus) {
      setTimeout(() => onRefocus(), 350);
    }
  };

  const sendTextBatch = () => {
    if (!textInput.trim() || !socket || !sessionId) return;
    socket.emit("input", { sessionId, data: textInput });
    setTextInput("");
    setShowTextInput(false);
    if (onExpandChange) {
      setTimeout(() => onExpandChange(false), 320);
    }
    // Refocus terminal after sending
    if (onRefocus) {
      setTimeout(() => onRefocus(), 350);
    }
  };

  // Get basic keys (removed macOS CMD from main bar)
  const basicKeys = [...BASIC_KEYS];

  const buttonBaseClass = BUTTON_STYLES.base;
  const normalButtonClass = `${buttonBaseClass} ${BUTTON_STYLES.normal}`;
  const arrowButtonClass = `${buttonBaseClass} ${BUTTON_STYLES.arrow}`;
  
  // Modifier keys - change color when active (pressed)
  const getModifierClass = (modifierKey) => {
    let isActive = false;
    if (modifierKey === "Ctrl") isActive = ctrlPressed;
    else if (modifierKey === "Meta") isActive = metaPressed;
    else if (modifierKey === "Alt") isActive = altPressed;
    else if (modifierKey === "Shift") isActive = shiftPressed;
    
    if (isActive) {
      return `${buttonBaseClass} ${BUTTON_STYLES.modifierActive}`;
    }
    return normalButtonClass;
  };

  return (
    <div className="flex flex-col">
      {/* Expanded keyboard panel */}
      <div 
        className={`bg-gradient-to-b from-slate-900 to-slate-950 border-t border-slate-700 transition-all duration-300 overflow-hidden ${
          isExpanded ? "max-h-32 opacity-100" : "max-h-0 opacity-0"
        }`}
      >
        <div className="p-2 overflow-y-auto max-h-32">
          <div className="grid grid-cols-6 gap-1 max-w-2xl mx-auto">
            {EXTENDED_KEYS.map((keyConfig, idx) => (
              <button
                key={idx}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => sendKey(keyConfig.key, { ctrl: keyConfig.ctrl })}
                className={`${normalButtonClass} ${keyConfig.ctrl ? "text-orange-300" : ""}`}
                style={{ minHeight: "28px" }}
              >
                {keyConfig.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Text Input Panel */}
      <div 
        className={`bg-gradient-to-b from-slate-900 to-slate-950 border-t border-slate-700 transition-all duration-300 overflow-hidden ${
          showTextInput ? "max-h-16 opacity-100" : "max-h-0 opacity-0"
        }`}
      >
        <div className="p-2 flex gap-2 items-center">
          <div className="flex-1 relative">
            <input
              ref={textInputRef}
              type="text"
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendTextBatch()}
              placeholder="Type command and send..."
              className="w-full px-3 py-2 pr-8 bg-slate-700 border border-slate-600 rounded-lg text-white text-base placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            {/* Clear button */}
            {textInput && (
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setTextInput("");
                  textInputRef.current?.focus();
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center text-slate-400 hover:text-white transition"
              >
                ×
              </button>
            )}
          </div>
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={sendTextBatch}
            disabled={!textInput.trim()}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-600 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition"
          >
            Send
          </button>
        </div>
      </div>

      {/* Bottom keyboard bar */}
      <div className="bg-gradient-to-t from-slate-900 via-slate-900 to-slate-800 border-t-2 border-slate-700 px-1.5 py-2 safe-area-bottom">
        <div className="flex items-center justify-between gap-0.5 max-w-4xl mx-auto">
          {/* Arrow keys */}
          <div className="flex gap-0.5">
            {basicKeys.slice(0, 4).map((keyConfig) => (
              <button
                key={keyConfig.key}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => sendKey(keyConfig.key)}
                className={arrowButtonClass}
                style={BUTTON_STYLES.size}
              >
                {keyConfig.label}
              </button>
            ))}
          </div>

          {/* Control keys */}
          <div className="flex gap-0.5 flex-1 justify-center flex-wrap">
            {basicKeys.slice(4).map((keyConfig) => {
              const isModifier = keyConfig.modifier === true;
              const isCtrlCombo = keyConfig.ctrl === true;
              const buttonClass = isModifier 
                ? getModifierClass(keyConfig.key)
                : normalButtonClass;
              
              return (
                <button
                  key={keyConfig.key + keyConfig.label}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    if (isModifier) handleModifierToggle(keyConfig.key);
                    else if (isCtrlCombo) sendKey(keyConfig.key, { ctrl: true });
                    else sendKey(keyConfig.key);
                  }}
                  className={`${buttonClass} ${isCtrlCombo ? "text-orange-300" : ""}`}
                  style={BUTTON_STYLES.size}
                >
                  {keyConfig.label}
                </button>
              );
            })}
          </div>

          {/* Text input button */}
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={toggleTextInput}
            className={`${showTextInput ? `${buttonBaseClass} ${BUTTON_STYLES.modifierActive}` : normalButtonClass} flex-shrink-0`}
            style={BUTTON_STYLES.size}
          >
            Aa
          </button>

          {/* Expand button */}
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={toggleExpanded}
            className={`${normalButtonClass} flex-shrink-0`}
            style={BUTTON_STYLES.size}
          >
            <span className={`transition-transform duration-300 inline-block ${isExpanded ? "rotate-180" : ""}`}>
              {isExpanded ? "×" : "⋯"}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
};

export default MobileKeyboard;
