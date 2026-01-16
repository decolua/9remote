"use client";

import { useState, useEffect, useCallback } from "react";

const MobileKeyboard = ({ socket, sessionId, onExpandChange }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [os, setOs] = useState("linux");
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

    // Base escape sequences for special keys
    const specialKeys = {
      "ArrowUp": "\x1b[A",
      "ArrowDown": "\x1b[B",
      "ArrowRight": "\x1b[C",
      "ArrowLeft": "\x1b[D",
      "Escape": "\x1b",
      "Tab": "\t",
      "Enter": "\r",
      "Backspace": "\x7f",
      "Delete": "\x1b[3~",
      "Home": "\x1b[H",
      "End": "\x1b[F",
      "PageUp": "\x1b[5~",
      "PageDown": "\x1b[6~",
      "Insert": "\x1b[2~",
      "F1": "\x1bOP",
      "F2": "\x1bOQ",
      "F3": "\x1bOR",
      "F4": "\x1bOS",
      "F5": "\x1b[15~",
      "F6": "\x1b[17~",
      "F7": "\x1b[18~",
      "F8": "\x1b[19~",
      "F9": "\x1b[20~",
      "F10": "\x1b[21~",
      "F11": "\x1b[23~",
      "F12": "\x1b[24~",
    };

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
      if (specialKeys[key]) {
        // Alt + special key: prefix with ESC
        data = "\x1b" + specialKeys[key];
      } else if (key.length === 1) {
        // Alt + character: prefix with ESC
        data = "\x1b" + key;
      } else {
        data = specialKeys[key] || key;
      }
    }
    // Handle Ctrl + special keys (arrows, Home, End, etc.)
    else if (ctrl && specialKeys[key]) {
      // Ctrl modifies the escape sequence
      if (key.startsWith("Arrow")) {
        // Ctrl+Arrow: jump by word
        const arrowMap = {
          "ArrowUp": "\x1b[1;5A",
          "ArrowDown": "\x1b[1;5B",
          "ArrowRight": "\x1b[1;5C",
          "ArrowLeft": "\x1b[1;5D",
        };
        data = arrowMap[key] || specialKeys[key];
      } else if (key === "Home") {
        data = "\x1b[1;5H";
      } else if (key === "End") {
        data = "\x1b[1;5F";
      } else {
        data = specialKeys[key];
      }
    }
    // Handle Shift combinations (mostly for uppercase)
    else if (shift && key.length === 1) {
      data = key.toUpperCase();
    }
    // No modifiers - just send the key
    else {
      data = specialKeys[key] || key;
    }

    return data;
  }, [ctrlPressed, altPressed, shiftPressed, metaPressed]);

  useEffect(() => {
    // Detect mobile device
    const checkMobile = () => {
      const mobile = window.innerWidth < 768 || 
                    ('ontouchstart' in window) || 
                    (navigator.maxTouchPoints > 0);
      setIsMobile(mobile);
    };
    
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  // Detect OS from terminal (could be improved by reading from session info)
  useEffect(() => {
    // For now, default to showing CMD on macOS client
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    setOs(isMac ? "macos" : "linux");
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
    
    // Hide mobile keyboard when expanding
    if (newState) {
      document.activeElement?.blur();
    }

    // Call callback after animation completes (300ms)
    if (onExpandChange) {
      setTimeout(() => onExpandChange(newState), 320);
    }
  };

  // Basic keys always visible
  const basicKeys = [
    { label: "↑", key: "ArrowUp", icon: true },
    { label: "↓", key: "ArrowDown", icon: true },
    { label: "Ctrl", key: "Ctrl", modifier: true },
    { label: "Alt", key: "Alt", modifier: true },
    { label: "Esc", key: "Escape" },
    { label: "Tab", key: "Tab" },
  ];

  // Add CMD for macOS
  if (os === "macos") {
    basicKeys.push({ label: "⌘", key: "Meta", modifier: true });
  }

  // Extended keys - only special PC keys that mobile doesn't have
  const extendedKeys = [
    { label: "←", key: "ArrowLeft" },
    { label: "→", key: "ArrowRight" },
    { label: "Home", key: "Home" },
    { label: "End", key: "End" },
    { label: "PgUp", key: "PageUp" },
    { label: "PgDn", key: "PageDown" },
    { label: "Del", key: "Delete" },
    { label: "Ins", key: "Insert" },
    { label: "F1", key: "F1" },
    { label: "F2", key: "F2" },
    { label: "F3", key: "F3" },
    { label: "F4", key: "F4" },
    { label: "F5", key: "F5" },
    { label: "F6", key: "F6" },
    { label: "F7", key: "F7" },
    { label: "F8", key: "F8" },
    { label: "F9", key: "F9" },
    { label: "F10", key: "F10" },
    { label: "F11", key: "F11" },
    { label: "F12", key: "F12" },
  ];

  const buttonBaseClass = "px-2 py-2 rounded-lg font-semibold text-xs transition-all duration-100 shadow-md";
  
  // All buttons same color - active state changes bg color for feedback
  const normalButtonClass = `${buttonBaseClass} bg-gradient-to-br from-slate-700 to-slate-800 hover:from-slate-600 hover:to-slate-700 active:from-slate-500 active:to-slate-600 text-white border border-slate-600`;
  const arrowButtonClass = `${buttonBaseClass} bg-gradient-to-br from-slate-700 to-slate-800 hover:from-slate-600 hover:to-slate-700 active:from-slate-500 active:to-slate-600 text-white text-base border border-slate-600`;
  
  // Modifier keys - change color when active (pressed)
  const getModifierClass = (modifierKey) => {
    let isActive = false;
    if (modifierKey === "Ctrl") isActive = ctrlPressed;
    else if (modifierKey === "Meta") isActive = metaPressed;
    else if (modifierKey === "Alt") isActive = altPressed;
    else if (modifierKey === "Shift") isActive = shiftPressed;
    
    if (isActive) {
      return `${buttonBaseClass} bg-gradient-to-br from-orange-500 to-orange-600 active:from-orange-400 active:to-orange-500 text-white shadow-lg ring-2 ring-orange-400`;
    }
    return normalButtonClass;
  };

  return (
    <div className="flex flex-col">
      {/* Expanded keyboard panel */}
      <div 
        className={`bg-gradient-to-b from-slate-900 to-slate-950 border-t border-slate-700 transition-all duration-300 overflow-hidden ${
          isExpanded ? 'max-h-64 opacity-100' : 'max-h-0 opacity-0'
        }`}
      >
        <div className="p-3 overflow-y-auto max-h-64">
          <div className="grid grid-cols-4 gap-1.5 max-w-2xl mx-auto">
            {extendedKeys.map((keyConfig, idx) => (
              <button
                key={idx}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => sendKey(keyConfig.key)}
                className={normalButtonClass}
                style={{ minHeight: "38px" }}
              >
                {keyConfig.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Bottom keyboard bar */}
      <div className="bg-gradient-to-t from-slate-900 via-slate-900 to-slate-800 border-t-2 border-slate-700 px-1.5 py-2 safe-area-bottom">
        <div className="flex items-center justify-between gap-1 max-w-4xl mx-auto">
          {/* Arrow Up/Down keys */}
          <div className="flex gap-1">
            {basicKeys.slice(0, 2).map((keyConfig) => (
              <button
                key={keyConfig.key}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => sendKey(keyConfig.key)}
                className={arrowButtonClass}
                style={{ minWidth: "40px", minHeight: "40px" }}
              >
                {keyConfig.label}
              </button>
            ))}
          </div>

          {/* Control keys */}
          <div className="flex gap-1 flex-1 justify-center flex-wrap">
            {basicKeys.slice(2).map((keyConfig) => {
              // Check if this is a modifier key
              const isModifier = keyConfig.modifier === true;
              const buttonClass = isModifier 
                ? getModifierClass(keyConfig.key)
                : normalButtonClass;
              
              return (
                <button
                  key={keyConfig.key}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => isModifier ? handleModifierToggle(keyConfig.key) : sendKey(keyConfig.key)}
                  className={buttonClass}
                  style={{ minHeight: "40px", minWidth: "45px" }}
                >
                  {keyConfig.label}
                </button>
              );
            })}
          </div>

          {/* Expand button - same color as other buttons */}
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={toggleExpanded}
            className={`${normalButtonClass} flex-shrink-0`}
            style={{ minWidth: "40px", minHeight: "40px" }}
          >
            <span className={`transition-transform duration-300 inline-block ${isExpanded ? 'rotate-180' : ''}`}>
              {isExpanded ? '×' : '⋯'}
            </span>
          </button>
        </div>
      </div>

      {/* Safe area spacer for iOS */}
      {/* <style jsx>{`
        .safe-area-bottom {
          padding-bottom: max(8px, env(safe-area-inset-bottom));
        }
      `}</style> */}
    </div>
  );
};

export default MobileKeyboard;
