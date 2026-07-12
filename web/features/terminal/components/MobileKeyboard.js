"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { SPECIAL_KEYS, CTRL_ARROW_KEYS } from "@/features/terminal/constants/keyMappings";
import {
  TERMINAL_KEY_POOL,
  TERMINAL_DEFAULT_BASIC,
  TERMINAL_DEFAULT_EXTRA,
  TERMINAL_PINNED_KEY_ID,
  BUTTON_STYLES,
  COMMON_COMMANDS,
  MAX_ATTACHMENT_SIZE,
  MAX_ATTACHMENTS,
  CLIPBOARD_ATTACH_TIMEOUT,
  CLIPBOARD_ATTACH_GAP,
  INPUT_CONTROL_KEYS
} from "@/features/terminal/constants/terminalConfig";
import { vibrate } from "@/shared/utils/vibration";
import { Paperclip, Settings, MoreHorizontal, X, CornerDownLeft, Mic, MicOff, History } from "@/shared/components/ui/Icon";
import CommandHistoryModal from "@/shared/components/ui/CommandHistoryModal";
import CommandSuggestions from "@/shared/components/ui/CommandSuggestions";
import { useTerminalHistoryStore } from "@/shared/stores/historyStore";
import { useVoiceInput, localeToSpeechLang, useVoiceLang } from "@/shared/hooks/useVoiceInput";
import VoiceLangModal from "@/shared/components/ui/VoiceLangModal";
import { useDeviceInfo } from "@/shared/hooks/useDeviceInfo";
import { useInputMode } from "@/shared/hooks/useInputMode";
import { useCustomKeys } from "@/shared/hooks/useCustomKeys";
import KeyCustomizeModal from "@/shared/components/ui/KeyCustomizeModal";
import { useI18n } from "@/shared/i18n";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { useFileSocket } from "@/features/fileExplorer/hooks/useFileSocket";
import PathSuggestion from "@/shared/components/ui/PathSuggestion";
import { makeDirCache, parsePathInput, pickMatches } from "@/features/terminal/utils/pathSuggest";
import { PATH_SUGGEST } from "@/features/terminal/constants/terminalConfig";

const MobileKeyboard = ({ socket, sessionId, onExpandChange, onRefocus, onRegisterTextApi, platform, onInput }) => {
  const { t, locale } = useI18n();
  const [isExpanded, setIsExpanded] = useState(false);
  const [showTextPanel, setShowTextPanel] = useState(true);
  // Draft text lives in the store keyed by sessionId so it survives this component
  // unmounting (e.g. switching to remote view and back).
  const textInput = useTerminalStore((s) => s.drafts[sessionId] ?? "");
  const setDraft = useTerminalStore((s) => s.setDraft);
  const setTextInput = useCallback((v) => {
    setDraft(sessionId, typeof v === "function" ? v(useTerminalStore.getState().drafts[sessionId] ?? "") : v);
  }, [setDraft, sessionId]);
  const [isMobile, setIsMobile] = useState(false);
  const [showPasteInput, setShowPasteInput] = useState(false);
  const [showCustomize, setShowCustomize] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const addCommand = useTerminalHistoryStore((s) => s.addCommand);
  const resolveAlias = useTerminalHistoryStore((s) => s.resolveAlias);
  const textInputRef = useRef(null);
  const pasteInputRef = useRef(null);
  // Physical ArrowUp/Down navigate command history; -1 = editing live draft.
  const historyIndexRef = useRef(-1);
  const draftRef = useRef("");

  // Path-aware ghost suggestion: only resolves when input matches a path-verb
  // regex + caret at end. Dir listings cached client-side (TTL, FIFO cap).
  const cwd = useTerminalStore((s) => s.cwdBySession[sessionId]);
  const [pathItems, setPathItems] = useState([]);
  const dirCacheRef = useRef(null);
  if (dirCacheRef.current == null) dirCacheRef.current = makeDirCache();
  const socketRef = useRef(socket);
  useEffect(() => { socketRef.current = socket; }, [socket]);
  const fileSocket = useFileSocket(socketRef);
  // Pending attachments (images/files) shown as chips; sent via OS clipboard on send.
  const [attachments, setAttachments] = useState([]);
  const attachIdRef = useRef(0);

  // Voice dictation language: persisted, defaults to the UI locale. Chosen via modal.
  const [voiceLang, setVoiceLang] = useVoiceLang(locale);
  const [voiceLangOpen, setVoiceLangOpen] = useState(false);
  const voice = useVoiceInput({
    lang: localeToSpeechLang(voiceLang),
    onText: (txt) => {
      setTextInput(txt);
      const el = textInputRef.current;
      if (el) requestAnimationFrame(() => {
        try { el.selectionStart = el.selectionEnd = el.value.length; } catch {}
        el.scrollTop = el.scrollHeight;
      });
    },
  });
  // Auto-grow textarea from 1 row up to a max, then scroll internally.
  useEffect(() => {
    const el = textInputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 72)}px`;
  }, [textInput]);
  const toggleVoice = () => {
    if (voice.listening) { voice.stop(); return; }
    document.activeElement?.blur(); // hide soft keyboard while dictating
    voice.start(textInput);
  };

  // Recompute ghost suffix when text or cwd changes. Only queries host if input
  // parses to a path-verb arg form; otherwise clears. State is set only from the
  // debounced async callback (never synchronously in the effect body).
  const lastSuggestRef = useRef(0);
  useEffect(() => {
    const parsed = parsePathInput(textInput, cwd);
    const token = ++lastSuggestRef.current;
    const timer = setTimeout(async () => {
      if (token !== lastSuggestRef.current) return;
      if (!parsed) { setPathItems([]); return; }
      const now = Date.now();
      let entries = dirCacheRef.current.get(parsed.dir, now);
      if (entries == null) {
        const res = await fileSocket.getFiles(parsed.dir, false);
        if (token !== lastSuggestRef.current) return;
        if (!res?.success) { setPathItems([]); return; }
        entries = res.files;
        dirCacheRef.current.set(parsed.dir, entries, now);
      }
      setPathItems(pickMatches(entries, parsed.prefix, parsed));
    }, PATH_SUGGEST.debounceMs);
    return () => clearTimeout(timer);
  }, [textInput, cwd, fileSocket]);

  // Reset per-session cache + suggestions when switching panes.
  useEffect(() => {
    const timer = setTimeout(() => { dirCacheRef.current?.clear(); setPathItems([]); }, 0);
    return () => clearTimeout(timer);
  }, [sessionId]);

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

  // Read a File → base64 attachment entry, skipping oversized ones.
  const fileToAttachment = (file) => new Promise((resolve) => {
    if (file.size > MAX_ATTACHMENT_SIZE) { alert(t("mobileKeyboard.fileTooLarge")); return resolve(null); }
    const reader = new FileReader();
    reader.onload = () => {
      const content = reader.result.split(",")[1];
      const isImage = file.type.startsWith("image/");
      const name = file.name || `paste_${attachIdRef.current}.${isImage ? (file.type.split("/")[1] || "png") : "bin"}`;
      resolve({ id: ++attachIdRef.current, name, type: file.type, size: file.size, content, isImage });
    };
    reader.onerror = () => { alert(t("mobileKeyboard.readFileFailed")); resolve(null); };
    reader.readAsDataURL(file);
  });

  const addFiles = async (files) => {
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) return;
    const picked = Array.from(files).slice(0, room);
    const entries = (await Promise.all(picked.map(fileToAttachment))).filter(Boolean);
    if (entries.length) { vibrate(); setAttachments((prev) => [...prev, ...entries]); }
  };

  const removeAttachment = (id) => setAttachments((prev) => prev.filter((a) => a.id !== id));

  // Push one attachment into the host OS clipboard + Ctrl+V, waiting for ack so
  // the CLI reads it before the next overwrites the clipboard.
  const sendOneAttachment = (att) => new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    socket.emit("clipboard-attach", { sessionId, filename: att.name, type: att.type, content: att.content }, finish);
    setTimeout(finish, CLIPBOARD_ATTACH_TIMEOUT);
  });

  const sendTextBatch = async () => {
    vibrate(15);
    if (voice.listening) voice.stop();
    if (!socket || !sessionId) return;
    // Only pull the keyboard back up if the input was already focused when sending.
    const wasFocused = document.activeElement === textInputRef.current;
    // Blur to force-commit pending IME composition before reading value,
    // otherwise the last composed char may be missing → inconsistent sends.
    if (wasFocused) textInputRef.current?.blur();
    const raw = textInputRef.current?.value ?? textInput;
    // Expand a bare snippet alias (e.g. "nrd" -> "npm run dev") before sending.
    const text = resolveAlias(raw);
    onInput?.(sessionId);

    // Attachments first (serially), then text — mirrors paste-image-then-type on the host.
    const pending = attachments;
    if (pending.length) setAttachments([]);
    for (const att of pending) {
      await sendOneAttachment(att);
      await new Promise((r) => setTimeout(r, CLIPBOARD_ATTACH_GAP));
    }

    if (text === "") {
      if (!pending.length) socket.emit("input", { sessionId, data: "\r" });
    } else {
      // Send text first, then Enter after a short delay so PTY reliably
      // receives both (mobile/IME may otherwise drop the Enter).
      socket.emit("input", { sessionId, data: text });
      setTimeout(() => socket.emit("input", { sessionId, data: "\r" }), 40);
      addCommand(text);
      setTextInput("");
      historyIndexRef.current = -1;
    }
    if (wasFocused) textInputRef.current?.focus();
  };

  const handleFileUpload = async (event) => {
    vibrate();
    const files = event.target.files;
    if (files?.length) await addFiles(files);
    event.target.value = "";
  };

  // Paste on the input: attach any image/file items; let text paste fall through.
  const handleAttachPaste = (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = [];
    for (const it of items) {
      if (it.kind === "file") { const f = it.getAsFile(); if (f) files.push(f); }
    }
    if (files.length) { e.preventDefault(); addFiles(files); }
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
        className={`transition-all duration-300 bg-bg ${voice.listening || showTextPanel ? "overflow-visible" : "overflow-hidden"} ${showTextPanel ? `${attachments.length ? "max-h-40" : "max-h-24"} opacity-100` : "max-h-0 opacity-0"}`}
      >
        <div className="p-2 flex gap-2 items-end">
          <div className="relative flex-1 bg-surface-2 rounded focus-within:ring-2 focus-within:ring-brand-500/40 transition-all duration-150 ease-out">
            <PathSuggestion
              items={pathItems}
              onSelect={(full) => { setTextInput(full); textInputRef.current?.focus(); }}
            />
            <CommandSuggestions
              value={textInput}
              store={useTerminalHistoryStore}
              commonCommands={COMMON_COMMANDS}
              isMobile={isMobile}
              disabled={pathItems.length > 0}
              onSelect={(cmd) => { setTextInput(cmd); textInputRef.current?.focus(); }}
            />
            {attachments.length > 0 && (
              <div className="flex gap-2 px-2 pt-2 overflow-x-auto scroll-thin-x">
                {attachments.map((att) => (
                  <div key={att.id} className="relative flex-shrink-0 group">
                    {att.isImage ? (
                      <img src={`data:${att.type};base64,${att.content}`} alt={att.name}
                        className="w-10 h-10 object-cover rounded border border-border" />
                    ) : (
                      <div className="w-10 h-10 flex flex-col items-center justify-center rounded border border-border bg-surface-3 px-1">
                        <Paperclip size={14} className="text-text-muted" />
                        <span className="text-[9px] text-text-muted truncate w-full text-center">{att.name}</span>
                      </div>
                    )}
                    <button
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => removeAttachment(att.id)}
                      className="absolute -top-1.5 -right-1.5 w-4 h-4 flex items-center justify-center bg-surface-3 rounded-full text-text-muted hover:text-text border border-border"
                    >
                      <X size={10} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <label className="absolute left-1.5 bottom-1.5 w-6 h-6 flex items-center justify-center cursor-pointer text-orange-500/70 hover:text-orange-500 transition-colors">
              <Paperclip size={16} />
              <input type="file" multiple onChange={handleFileUpload} className="hidden" accept="*/*" />
            </label>
            <textarea
              ref={textInputRef}
              value={textInput}
              onChange={(e) => {
                setTextInput(e.target.value);
                historyIndexRef.current = -1;
              }}
              onPaste={handleAttachPaste}
              onKeyDown={(e) => {
                if (hasPhysicalKeyboard && e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendTextBatch();
                  return;
                }
                // Physical ArrowUp/Down (no modifier) navigate history only at caret boundaries (multi-line aware).
                if (hasPhysicalKeyboard && (e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
                  const el = e.target;
                  const atFirstLine = el.selectionStart <= (el.value.indexOf("\n") === -1 ? el.value.length : el.value.indexOf("\n"));
                  const lastNL = el.value.lastIndexOf("\n");
                  const atLastLine = el.selectionEnd >= (lastNL === -1 ? 0 : lastNL + 1);
                  if (e.key === "ArrowUp" && !atFirstLine) return;
                  if (e.key === "ArrowDown" && !atLastLine) return;
                  const hist = useTerminalHistoryStore.getState().history;
                  if (!hist.length) return;
                  e.preventDefault();
                  if (historyIndexRef.current === -1) draftRef.current = e.target.value;
                  let next = historyIndexRef.current + (e.key === "ArrowUp" ? 1 : -1);
                  if (next >= hist.length) next = hist.length - 1;
                  if (next < -1) next = -1;
                  historyIndexRef.current = next;
                  setTextInput(next === -1 ? draftRef.current : hist[next]);
                  requestAnimationFrame(() => {
                    const el = textInputRef.current;
                    if (el) { el.selectionStart = el.selectionEnd = el.value.length; }
                  });
                  return;
                }
                // Control keys (Esc, Ctrl+C/D/Z/L) → straight to terminal.
                const cfg = INPUT_CONTROL_KEYS[e.key];
                if (cfg && (!cfg.ctrl || e.ctrlKey) && !e.metaKey && !e.altKey) {
                  const el = e.target;
                  if (cfg.requireNoSelection && el.selectionStart !== el.selectionEnd) return;
                  e.preventDefault();
                  onInput?.(sessionId);
                  socket.emit("input", { sessionId, data: cfg.data });
                }
              }}
              placeholder={hasPhysicalKeyboard ? t("mobileKeyboard.enterToSend") : t("mobileKeyboard.typeCommand")}
              rows={1}
              className="block w-full pl-9 pr-8 py-2 bg-transparent text-text text-sm placeholder-text-muted focus:outline-none resize-none overflow-y-auto"
            />
            {textInput ? (
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { setTextInput(""); textInputRef.current?.focus(); }}
                title={t("voice.clear")}
                className="absolute right-1.5 top-1.5 w-5 h-5 flex items-center justify-center text-text-muted hover:text-text transition-colors"
              >
                <X size={14} />
              </button>
            ) : (
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setShowHistory(true)}
                title={t("history.title")}
                className="absolute right-1.5 top-1.5 w-5 h-5 flex items-center justify-center text-text-muted hover:text-text transition-colors"
              >
                <History size={14} />
              </button>
            )}
          </div>
          {voice.supported && (
            <div className="relative flex-shrink-0">
              {voice.listening && (
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setVoiceLangOpen(true)}
                  title={t("voice.language")}
                  className="absolute -top-9 left-1/2 -translate-x-1/2 z-50 px-2.5 py-1 rounded bg-surface-2 shadow-lg text-[11px] font-semibold uppercase text-text-muted hover:text-text transition-colors"
                >
                  {voiceLang}
                </button>
              )}
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={toggleVoice}
                title={voice.error === "not-allowed" || voice.error === "service-not-allowed" ? t("voice.denied") : t("voice.dictate")}
                className={`h-9 w-9 flex items-center justify-center rounded-full transition-all duration-200 ${
                  voice.listening ? "bg-red-500/90 text-white animate-pulse" : voice.error ? "bg-surface-2 text-red-400" : "bg-surface-2 hover:bg-surface-3 text-text-muted hover:text-text"
                }`}
              >
                {voice.listening ? <MicOff size={18} /> : <Mic size={18} />}
              </button>
            </div>
          )}
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={sendTextBatch}
            disabled={false}
            className="px-3 py-2 bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium rounded transition-all duration-200 shadow-lg shadow-brand-500/20 flex-shrink-0 min-w-[56px] flex items-center justify-center"
          >
            {textInput.trim() || attachments.length ? t("mobileKeyboard.send") : <CornerDownLeft size={16} strokeWidth={2.5} />}
          </button>
        </div>
      </div>

      {/* Bottom keyboard bar */}
      {!hasPhysicalKeyboard && (
        <div
          className={`overflow-x-auto overflow-y-hidden touch-pan-x px-1.5 pb-1.5 bg-bg ${isIosPwa ? "safe-area-bottom" : ""}`}
        >
          <div className="flex items-center gap-1 max-w-4xl mx-auto">
            <div className="flex gap-1 flex-1 overflow-x-auto scroll-thin-x touch-pan-x pr-2 rounded-lg">
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
      <VoiceLangModal
        isOpen={voiceLangOpen}
        value={voiceLang}
        onSelect={setVoiceLang}
        onClose={() => setVoiceLangOpen(false)}
      />
      <CommandHistoryModal
        isOpen={showHistory}
        onSelect={(cmd) => { setTextInput(cmd); textInputRef.current?.focus(); }}
        onClose={() => setShowHistory(false)}
      />
    </div>
  );
};

export default MobileKeyboard;
