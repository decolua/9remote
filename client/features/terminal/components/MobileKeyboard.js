"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { SPECIAL_KEYS, CTRL_ARROW_KEYS } from "@/features/terminal/constants/keyMappings";
import { BASIC_KEYS, EXTENDED_KEYS, MAC_KEY, BUTTON_STYLES } from "@/features/terminal/constants/terminalConfig";
import { vibrate } from "@/shared/utils/vibration";
import { Paperclip } from "@/shared/components/ui/Icon";

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

  // Detect iOS PWA standalone mode
  const isIosPwa = useMemo(() => {
    if (typeof window === "undefined") return false;
    const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);
    const isStandalone = window.navigator.standalone === true;
    return isIos && isStandalone;
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
    // Handle Shift + special keys
    else if (shift && SPECIAL_KEYS[key]) {
      if (key === "Tab") {
        data = "\x1b[Z"; // Shift+Tab (reverse tab / backtab)
      } else if (key.startsWith("Arrow")) {
        // Shift+Arrow: modifier 2
        const arrowMap = {
          "ArrowUp": "\x1b[1;2A",
          "ArrowDown": "\x1b[1;2B",
          "ArrowRight": "\x1b[1;2C",
          "ArrowLeft": "\x1b[1;2D"
        };
        data = arrowMap[key] || SPECIAL_KEYS[key];
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
    vibrate();

    if (modifier === "Ctrl") {
      setCtrlPressed(!ctrlPressed);
    } else if (modifier === "Meta") {
      setMetaPressed(!metaPressed);
    } else if (modifier === "Alt" || modifier === "Opt") {
      setAltPressed(!altPressed);
    } else if (modifier === "Shift") {
      setShiftPressed(!shiftPressed);
    }
  };

  const sendKey = (key, forceModifiers = {}) => {
    vibrate();

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
    vibrate();

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
    vibrate();

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
    vibrate(15);

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

  // Handle file upload
  const handleFileUpload = async (event) => {
    vibrate();

    const file = event.target.files?.[0];
    if (!file) return;

    try {
      // Check file size (limit 5MB)
      if (file.size > 5 * 1024 * 1024) {
        alert("File too large (max 5MB)");
        return;
      }

      // Read file as base64
      const reader = new FileReader();

      reader.onload = () => {
        const base64Content = reader.result.split(",")[1];

        if (socket && sessionId && base64Content) {
          // Send file to server via socket
          socket.emit("upload-file", {
            sessionId,
            filename: file.name,
            size: file.size,
            type: file.type,
            content: base64Content
          });
        }
      };

      reader.onerror = () => {
        alert("Failed to read file");
      };

      reader.readAsDataURL(file);

    } catch (err) {
      console.error("File upload error:", err);
      alert("Failed to upload file: " + err.message);
    }

    // Reset input
    event.target.value = "";
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
    else if (modifierKey === "Alt" || modifierKey === "Opt") isActive = altPressed;
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
        className={`bg-gradient-to-b from-dark-700 to-dark-800 border-t border-dark-400 transition-all duration-300 overflow-hidden ${isExpanded ? "max-h-32 opacity-100" : "max-h-0 opacity-0"
          }`}
      >
        <div className="p-2 overflow-y-auto max-h-32">
          <div className="grid grid-cols-6 gap-1 max-w-2xl mx-auto">
            {EXTENDED_KEYS.map((keyConfig, idx) => (
              <button
                key={idx}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => sendKey(keyConfig.key, { ctrl: keyConfig.ctrl })}
                className={`${normalButtonClass} ${keyConfig.ctrl ? "text-brand-400" : ""}`}
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
        className={`bg-gradient-to-b from-dark-700 to-dark-800 border-t border-dark-400 transition-all duration-300 overflow-hidden ${showTextInput ? "max-h-24 opacity-100" : "max-h-0 opacity-0"
          }`}
      >
        <div className="p-2 flex gap-2 items-center">
          {/* File upload button */}
          <label className="px-3 py-2 bg-dark-500 hover:bg-dark-400 text-sm font-medium rounded transition-all duration-200 border border-dark-400 hover:border-brand-500 flex items-center gap-1 cursor-pointer flex-shrink-0">
            <Paperclip size={16} className="text-orange-500/70" />
            <input
              type="file"
              onChange={handleFileUpload}
              className="hidden"
              accept="*/*"
            />
          </label>

          <textarea
            ref={textInputRef}
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            placeholder="Type command and send..."
            rows={Math.min(2, (textInput.match(/\n/g) || []).length + 1)}
            className="w-full px-3 py-2 pr-8 bg-dark-600 border border-dark-400 rounded text-white text-base placeholder-dark-100 focus:outline-none focus:ring-1 focus:ring-brand-500 transition-all duration-200 resize-none"
          />
          {/* Clear button */}
          {textInput && (
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setTextInput("");
                textInputRef.current?.focus();
              }}
              className="absolute right-2 top-2 w-5 h-5 flex items-center justify-center text-dark-100 hover:text-white transition-colors"
            >
              ×
            </button>
          )}
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={sendTextBatch}
            disabled={!textInput.trim()}
            className="px-4 py-2 bg-brand-500 hover:bg-brand-600 disabled:bg-dark-500 disabled:opacity-50 text-white text-sm font-medium rounded transition-all duration-200 shadow-lg shadow-brand-500/20 flex-shrink-0"
          >
            Send
          </button>
        </div>
      </div>

      {/* Bottom keyboard bar */}
      <div className={`bg-gradient-to-t from-dark-700 via-dark-700 to-dark-600 border-t-2 border-dark-400 px-1.5 py-2 ${isIosPwa ? "safe-area-bottom" : ""}`}>
        <div className="flex items-center justify-between gap-0.5 max-w-4xl mx-auto">
          {/* Esc button - separate group */}
          <div className="flex gap-0.5">
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => sendKey("Escape")}
              className={normalButtonClass}
              style={BUTTON_STYLES.size}
            >
              Esc
            </button>
          </div>

          {/* Up/Down Arrow keys */}
          <div className="flex gap-0.5">
            {basicKeys.slice(1, 3).map((keyConfig) => (
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

          {/* Control keys (from index 3) */}
          <div className="flex gap-0.5 justify-center flex-wrap">
            {basicKeys.slice(3).map((keyConfig) => {
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
                  className={`${buttonClass} ${isCtrlCombo ? "text-brand-400" : ""}`}
                  style={BUTTON_STYLES.size}
                >
                  {keyConfig.label}
                </button>
              );
            })}
          </div>

          {/* Text input button */}
          <div className="flex gap-0.5 justify-center flex-wrap">
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
    </div>
  );
};

export default MobileKeyboard;
