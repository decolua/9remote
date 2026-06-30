"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { SPECIAL_KEYS, CTRL_ARROW_KEYS } from "@/features/terminal/constants/keyMappings";
import {
  TERMINAL_KEY_POOL,
  TERMINAL_DEFAULT_BASIC,
  TERMINAL_DEFAULT_EXTRA,
  TERMINAL_PINNED_KEY_ID,
  BUTTON_STYLES
} from "@/features/terminal/constants/terminalConfig";
import { vibrate } from "@/shared/utils/vibration";
import { Paperclip, Settings, MoreHorizontal, X, CornerDownLeft } from "@/shared/components/ui/Icon";
import { useDeviceInfo } from "@/shared/hooks/useDeviceInfo";
import { useInputMode } from "@/shared/hooks/useInputMode";
import { useCustomKeys } from "@/shared/hooks/useCustomKeys";
import KeyCustomizeModal from "@/shared/components/ui/KeyCustomizeModal";
import { useI18n } from "@/shared/i18n";

const MobileKeyboard = ({ socket, sessionId, onExpandChange, onRefocus, onRegisterTextApi, platform, onInput }) => {
  const { t } = useI18n();
  const [isExpanded, setIsExpanded] = useState(false);
  const [showTextPanel, setShowTextPanel] = useState(true);
  const [textInput, setTextInput] = useState("");
  const [isMobile, setIsMobile] = useState(false);
  const [showPasteInput, setShowPasteInput] = useState(false);
  const [showCustomize, setShowCustomize] = useState(false);
  const textInputRef = useRef(null);
  const pasteInputRef = useRef(null);

  const { isIosPwa } = useDeviceInfo();
  const inputMode = useInputMode();
  // PC/laptop with physical keyboard → hide virtual key toolbar.
  const hasPhysicalKeyboard = inputMode === "mouse";

  const [ctrlPressed, setCtrlPressed] = useState(false);
  const [metaPressed, setMetaPressed] = useState(false);
  const [altPressed, setAltPressed] = useState(false);
  const [shiftPressed, setShiftPressed] = useState(false);

  const basicCustom = useCustomKeys("terminal.basicKeys", TERMINAL_KEY_POOL, TERMINAL_DEFAULT_BASIC, "flat");
  const extraCustom = useCustomKeys("terminal.extraKeys", TERMINAL_KEY_POOL, TERMINAL_DEFAULT_EXTRA, "grid");

  // Smart combination generator - handles all key combinations
  const generateCombination = useCallback((key, modifiers = {}) => {
    const ctrl = modifiers.ctrl || ctrlPressed;
    const alt = modifiers.alt || altPressed;
    const shift = modifiers.shift || shiftPressed;
    const meta = modifiers.meta || metaPressed;

    let data = "";

    if (ctrl && key.length === 1) {
      const upperKey = key.toUpperCase();
      const charCode = upperKey.charCodeAt(0);
      if (charCode >= 65 && charCode <= 90) {
        const controlCode = charCode - 64;
        data = String.fromCharCode(controlCode);
      }
      else if (key === "[") data = "\x1b";
      else if (key === "]") data = "\x1d";
      else if (key === "\\") data = "\x1c";
      else if (key === "@") data = "\x00";
      else if (key === "?") data = "\x7f";
      else data = key;
    }
    else if (alt) {
      if (SPECIAL_KEYS[key]) data = "\x1b" + SPECIAL_KEYS[key];
      else if (key.length === 1) data = "\x1b" + key;
      else data = SPECIAL_KEYS[key] || key;
    }
    else if (ctrl && SPECIAL_KEYS[key]) {
      if (key.startsWith("Arrow")) data = CTRL_ARROW_KEYS[key] || SPECIAL_KEYS[key];
      else if (key === "Home") data = "\x1b[1;5H";
      else if (key === "End") data = "\x1b[1;5F";
      else data = SPECIAL_KEYS[key];
    }
    else if (shift && SPECIAL_KEYS[key]) {
      if (key === "Tab") data = "\x1b[Z";
      else if (key.startsWith("Arrow")) {
        const arrowMap = {
          "ArrowUp": "\x1b[1;2A",
          "ArrowDown": "\x1b[1;2B",
          "ArrowRight": "\x1b[1;2C",
          "ArrowLeft": "\x1b[1;2D"
        };
        data = arrowMap[key] || SPECIAL_KEYS[key];
      } else data = SPECIAL_KEYS[key];
    }
    else if (shift && key.length === 1) data = key.toUpperCase();
    else data = SPECIAL_KEYS[key] || key;

    return data;
  }, [ctrlPressed, altPressed, shiftPressed, metaPressed]);

  useEffect(() => {
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

  useEffect(() => {
    if (onExpandChange) onExpandChange(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasPhysicalKeyboard]);

  // Expose openTextPanel for paste-fallback from TerminalPane
  useEffect(() => {
    if (!onRegisterTextApi) return;
    const openTextPanel = () => {
      setShowTextPanel(true);
      setTimeout(() => textInputRef.current?.focus(), 100);
    };
    onRegisterTextApi({ openTextPanel });
    return () => onRegisterTextApi(null);
  }, [onRegisterTextApi]);

  const tryPasteFromClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && socket) {
        onInput?.(sessionId);
        socket.emit("input", { sessionId, data: text });
        vibrate();
        return true;
      }
    } catch (err) {
      console.error("Clipboard API failed, showing input fallback:", err);
    }
    return false;
  }, [socket, sessionId]);

  // Intercept keyboard input when modifiers are active
  useEffect(() => {
    if (!isMobile || !socket || !sessionId) return;
    const hasActiveModifier = ctrlPressed || metaPressed || altPressed || shiftPressed;
    if (!hasActiveModifier) return;

    const handleKeyDown = async (e) => {
      if (!ctrlPressed && !metaPressed && !altPressed && !shiftPressed) return;
      if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      let key = e.key;

      if ((ctrlPressed || metaPressed) && key.toLowerCase() === "v") {
        const success = await tryPasteFromClipboard();
        if (!success) {
          setShowPasteInput(true);
          setTimeout(() => pasteInputRef.current?.focus(), 100);
        }
        setCtrlPressed(false); setMetaPressed(false); setAltPressed(false); setShiftPressed(false);
        return;
      }

      if (key === "Backspace") key = "Backspace";
      else if (key === "Enter") key = "Enter";
      else if (key === "Tab") key = "Tab";
      else if (key === "Escape") key = "Escape";
      else if (key === "Delete") key = "Delete";
      else if (key.startsWith("Arrow")) key = e.key;
      else if (key.startsWith("F") && key.length <= 3) key = e.key;

      const data = generateCombination(key, {
        ctrl: ctrlPressed, alt: altPressed, shift: shiftPressed, meta: metaPressed
      });
      onInput?.(sessionId);
      socket.emit("input", { sessionId, data });
      setCtrlPressed(false); setMetaPressed(false); setAltPressed(false); setShiftPressed(false);
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [isMobile, socket, sessionId, ctrlPressed, metaPressed, altPressed, shiftPressed, generateCombination, tryPasteFromClipboard]);

  if ((!isMobile && !hasPhysicalKeyboard) || !socket || !sessionId) return null;

  const handleModifierToggle = (modifier) => {
    vibrate();
    if (modifier === "Ctrl") setCtrlPressed(!ctrlPressed);
    else if (modifier === "Meta") setMetaPressed(!metaPressed);
    else if (modifier === "Alt" || modifier === "Opt") setAltPressed(!altPressed);
    else if (modifier === "Shift") setShiftPressed(!shiftPressed);
  };

  const handlePasteInput = (e) => {
    e.preventDefault();
    const text = e.clipboardData?.getData("text");
    if (text && socket) {
      onInput?.(sessionId);
      socket.emit("input", { sessionId, data: text });
      vibrate();
    }
    setShowPasteInput(false);
  };

  const sendKey = async (key, forceModifiers = {}) => {
    vibrate();
    const ctrl = forceModifiers.ctrl || ctrlPressed;
    const meta = forceModifiers.meta || metaPressed;
    if ((ctrl || meta) && key.toLowerCase() === "v") {
      const success = await tryPasteFromClipboard();
      if (!success) {
        setShowPasteInput(true);
        setTimeout(() => pasteInputRef.current?.focus(), 100);
      }
      setCtrlPressed(false); setMetaPressed(false); setAltPressed(false); setShiftPressed(false);
      return;
    }
    const data = generateCombination(key, forceModifiers);
    onInput?.(sessionId);
    socket.emit("input", { sessionId, data });
    if (key !== "Ctrl" && key !== "Meta" && key !== "Alt" && key !== "Shift") {
      setCtrlPressed(false); setMetaPressed(false); setAltPressed(false); setShiftPressed(false);
    }
  };

  const toggleExpanded = () => {
    vibrate();
    const newState = !isExpanded;
    setIsExpanded(newState);
    if (newState) document.activeElement?.blur();
    if (onExpandChange) setTimeout(() => onExpandChange(newState), 320);
  };

  const sendTextBatch = () => {
    vibrate(15);
    if (!socket || !sessionId) return;
    // Empty input → send single Enter (\r); otherwise send raw text
    const data = textInput === "" ? "\r" : textInput;
    onInput?.(sessionId);
    socket.emit("input", { sessionId, data });
    if (textInput !== "") setTextInput("");
    textInputRef.current?.focus();
  };

  const handleFileUpload = async (event) => {
    vibrate();
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (file.size > 5 * 1024 * 1024) { alert(t("mobileKeyboard.fileTooLarge")); return; }
      const reader = new FileReader();
      reader.onload = () => {
        const base64Content = reader.result.split(",")[1];
        if (socket && sessionId && base64Content) {
          socket.emit("upload-file", {
            sessionId, filename: file.name, size: file.size, type: file.type, content: base64Content
          });
        }
      };
      reader.onerror = () => alert(t("mobileKeyboard.readFileFailed"));
      reader.readAsDataURL(file);
    } catch (err) {
      console.error("File upload error:", err);
      alert(t("mobileKeyboard.uploadFailed", { error: err.message }));
    }
    event.target.value = "";
  };

  const buttonBaseClass = BUTTON_STYLES.base;
  const normalButtonClass = `${buttonBaseClass} ${BUTTON_STYLES.normal}`;
  const arrowButtonClass = `${buttonBaseClass} ${BUTTON_STYLES.arrow}`;

  const getModifierActive = (id) => (
    (id === "ctrl" && ctrlPressed) ||
    (id === "meta" && metaPressed) ||
    (id === "opt" && altPressed) ||
    (id === "shift" && shiftPressed)
  );

  // Render one key from pool entry. `large=true` → auto-width + taller (extra panel).
  const renderKey = (kc, idx, large = false, pinned = false) => {
    const isModifierActive = kc.type === "modifier" && getModifierActive(kc.id);
    const cls = isModifierActive
      ? `${buttonBaseClass} ${BUTTON_STYLES.modifierActive}`
      : pinned ? `${buttonBaseClass} ${BUTTON_STYLES.pinned}`
      : kc.type === "arrow" ? arrowButtonClass : normalButtonClass;
    const accent = kc.type === "ctrl" ? "text-brand-400" : "";
    const textCls = kc.label.length > 1 ? BUTTON_STYLES.textSmall : BUTTON_STYLES.textNormal;
    const sizeStyle = large ? BUTTON_STYLES.sizeLarge : BUTTON_STYLES.size;

    return (
      <button
        key={kc.id + idx}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (kc.type === "modifier") handleModifierToggle(kc.key);
          else if (kc.type === "ctrl") sendKey(kc.key, { ctrl: true });
          else sendKey(kc.key);
        }}
        className={`${cls} ${accent} ${textCls} whitespace-nowrap`}
        style={sizeStyle}
      >
        {kc.label}
      </button>
    );
  };

  return (
    <div className="flex flex-col">
      {/* Paste Input Fallback */}
      {showPasteInput && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowPasteInput(false)}>
          <input
            ref={pasteInputRef}
            placeholder={t("mobileKeyboard.pasteHere")}
            onPaste={handlePasteInput}
            onClick={(e) => e.stopPropagation()}
            className="px-6 py-3 bg-surface-2 text-text rounded-brand focus:ring-2 focus:ring-brand-500/40 font-medium transition-all duration-150 ease-out outline-none text-center w-64"
          />
        </div>
      )}

      {/* Expanded keyboard panel — 3 scrollable rows */}
      <div
        className={`transition-all duration-300 overflow-hidden bg-bg ${isExpanded && !hasPhysicalKeyboard ? "max-h-64 opacity-100" : "max-h-0 opacity-0"}`}
      >
        <div className="p-2 max-w-2xl mx-auto">
          <div className="space-y-1">
            {extraCustom.rows.map((row, rIdx) => (
              <div key={rIdx} className="flex items-center gap-1.5">
                <div className="flex-1 min-w-0 flex gap-1.5 overflow-x-auto scroll-thin-x pr-3 rounded-lg">
                  {row.map((id, cIdx) => {
                    const kc = TERMINAL_KEY_POOL.find(p => p.id === id);
                    return kc ? renderKey(kc, rIdx * 100 + cIdx, true) : null;
                  })}
                </div>
                {rIdx === 0 && (
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => { vibrate(); setShowCustomize(true); }}
                    className="shrink-0 h-8 w-8 flex items-center justify-center text-text-muted hover:text-text bg-surface-2 hover:bg-surface-3 rounded-brand transition-all duration-150 ease-out"
                    title={t("remote.customizeKeys")}
                  >
                    <Settings size={16} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Text Input Panel */}
      <div
        className={`overflow-hidden transition-all duration-300 bg-bg ${showTextPanel ? "max-h-24 opacity-100" : "max-h-0 opacity-0"}`}
      >
        <div className="p-2 flex gap-2 items-center">
          <label className="px-3 py-2 bg-surface-2 hover:bg-surface-3 text-sm font-medium rounded transition-all duration-150 ease-out flex items-center gap-1 cursor-pointer flex-shrink-0">
            <Paperclip size={16} className="text-orange-500/70" />
            <input type="file" onChange={handleFileUpload} className="hidden" accept="*/*" />
          </label>

          <textarea
            ref={textInputRef}
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            onKeyDown={(e) => {
              if (hasPhysicalKeyboard && e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendTextBatch();
              }
            }}
            placeholder={hasPhysicalKeyboard ? t("mobileKeyboard.enterToSend") : t("mobileKeyboard.typeCommand")}
            rows={Math.min(2, (textInput.match(/\n/g) || []).length + 1)}
            className="w-full px-3 py-1.5 pr-8 bg-surface-2 rounded text-text text-base placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-brand-500/40 transition-all duration-150 ease-out resize-none"
          />
          {textInput && (
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { setTextInput(""); textInputRef.current?.focus(); }}
              className="absolute right-2 top-2 w-5 h-5 flex items-center justify-center text-text-muted hover:text-text transition-colors"
            >
              ×
            </button>
          )}
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={sendTextBatch}
                  disabled={false}
                  className="px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium rounded transition-all duration-200 shadow-lg shadow-brand-500/20 flex-shrink-0 min-w-[72px] flex items-center justify-center"
          >
            {textInput.trim() ? t("mobileKeyboard.send") : <CornerDownLeft size={16} strokeWidth={2.5} />}
          </button>
        </div>
      </div>

      {/* Bottom keyboard bar */}
      {!hasPhysicalKeyboard && (
        <div
          className={`overflow-auto px-1.5 pb-1.5 bg-bg ${isIosPwa ? "safe-area-bottom" : ""}`}
        >
          <div className="flex items-center gap-1 max-w-4xl mx-auto">
            <div className="flex gap-1 flex-1 overflow-x-auto scroll-thin-x pr-2 rounded-lg">
              {basicCustom.keys
                .filter(kc => kc.id !== TERMINAL_PINNED_KEY_ID)
                .map((kc, idx) => renderKey(kc, idx))}
            </div>
            {/* Pinned Enter key — always visible next to expand button */}
            {(() => {
              const pinned = TERMINAL_KEY_POOL.find(p => p.id === TERMINAL_PINNED_KEY_ID);
              return pinned ? (
                <div className="flex-shrink-0">{renderKey(pinned, "pinned", false, true)}</div>
              ) : null;
            })()}
            {/* Pinned Aa — toggle text input panel */}
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { vibrate(); setShowTextPanel(s => !s); }}
              className={`${buttonBaseClass} ${showTextPanel ? BUTTON_STYLES.modifierActive : BUTTON_STYLES.pinned} flex-shrink-0 text-[11px]`}
              style={BUTTON_STYLES.size}
              title={t("mobileKeyboard.toggleTextInput")}
            >
              Aa
            </button>
            {/* Expand button */}
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={toggleExpanded}
              className={`${buttonBaseClass} ${isExpanded ? BUTTON_STYLES.modifierActive : BUTTON_STYLES.pinned} flex-shrink-0`}
              style={BUTTON_STYLES.size}
              title={t("mobileKeyboard.toggleExtraKeys")}
            >
              {isExpanded ? <X size={16} /> : <MoreHorizontal size={16} />}
            </button>
          </div>
        </div>
      )}

      <KeyCustomizeModal
        isOpen={showCustomize}
        onClose={() => setShowCustomize(false)}
        title={t("mobileKeyboard.customizeTerminalKeys")}
        tabs={[
          { id: "basic", label: t("mobileKeyboard.mainBar"), hook: basicCustom, excludeIds: [TERMINAL_PINNED_KEY_ID] },
          { id: "extra", label: t("mobileKeyboard.extraPanel"), hook: extraCustom }
        ]}
      />
    </div>
  );
};

export default MobileKeyboard;
