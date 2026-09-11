"use client";

import { memo, useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Send, Square, Terminal, FileCode, Zap, ChevronUp, Check, Shield, Sparkles, X } from "@/shared/components/ui/Icon";
import { ENGINE_INFO } from "../constants";
import { getEngineConfig } from "../registry";
import { vibrate } from "@/shared/utils/vibration";
import { useAiStore } from "@/shared/stores/aiStore";
import { useConnectionStore } from "@/shared/stores/connectionStore";
import { agentIconUrl } from "@/features/terminal/constants/agentCli";

const EMPTY_ARRAY = [];

export const Composer = memo(function Composer({
  sessionId = "",
  engine = "claude",
  isTurnRunning: propTurnRunning = false,
  isFocused = false,
  onSend,
  onStop,
  onRunShell,
  onSelectModel,
  onModeChange,
  onActivate,
  fileBus = null,
  workspacePath = "",
  model: propModel = ""
}) {
  const engineConfig = getEngineConfig(engine);
  const MODELS = engineConfig.models;
  const CLAUDE_MODES = engineConfig.permissionModes;
  const SLASH_COMMANDS = engineConfig.slashCommands;
  const storeTurnRunning = useAiStore((s) => s.bySession[sessionId]?.isTurnRunning);
  const storeModel = useAiStore((s) => s.bySession[sessionId]?.metadata?.model);
  const storeSkills = useAiStore((s) => s.bySession[sessionId]?.metadata?.skills) || EMPTY_ARRAY;
  const permissionMode = useAiStore((s) => s.bySession[sessionId]?.permissionMode || "default");

  const isTurnRunning = storeTurnRunning !== undefined ? storeTurnRunning : propTurnRunning;
  const rawModel = storeModel !== undefined ? storeModel : propModel;

  const [text, setText] = useState("");
  const [queuedText, setQueuedText] = useState("");
  const [history, setHistory] = useState([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuType, setMenuType] = useState(null); // "/" or "@"
  const [menuFilter, setMenuFilter] = useState("");
  const [menuItems, setMenuItems] = useState([]);
  const [selectedIdx, setSelectedIdx] = useState(0);

  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const modelMenuRef = useRef(null);
  const modeMenuRef = useRef(null);

  const textareaRef = useRef(null);
  const menuContainerRef = useRef(null);
  const isComposingRef = useRef(false);
  const lastCompositionEndRef = useRef(0);
  const lastSendTimeRef = useRef(0);
  const justSentRef = useRef(0);
  const engineMeta = ENGINE_INFO[engine] || ENGINE_INFO.claude;

  // Auto-focus only when this specific pane is active/focused and not busy running
  useEffect(() => {
    if (isFocused && !isTurnRunning) {
      textareaRef.current?.focus();
    }
  }, [isFocused, isTurnRunning]);

  // Auto-close popover menus on outside click
  useEffect(() => {
    const onClick = (e) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target)) setModelMenuOpen(false);
      if (modeMenuRef.current && !modeMenuRef.current.contains(e.target)) setModeMenuOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  // Autosize textarea — lower minimum height for a compact input
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const nextH = Math.min(el.scrollHeight, 140);
    el.style.height = `${Math.max(nextH, 26)}px`;
  }, [text]);

  // Keep active autocomplete item scrolled into view
  useEffect(() => {
    if (!menuOpen || !menuContainerRef.current) return;
    const items = menuContainerRef.current.querySelectorAll("[data-menu-item]");
    const activeEl = items[selectedIdx];
    if (activeEl) {
      activeEl.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIdx, menuOpen]);

  // Load draft on session change
  useEffect(() => {
    if (!sessionId) return;
    try {
      const d = localStorage.getItem(`9remote_draft_${sessionId}`);
      if (d) setText(d);
    } catch {}
  }, [sessionId]);

  // Save draft debounced
  useEffect(() => {
    if (!sessionId) return;
    const timer = setTimeout(() => {
      try {
        if (text) localStorage.setItem(`9remote_draft_${sessionId}`, text);
        else localStorage.removeItem(`9remote_draft_${sessionId}`);
      } catch {}
    }, 300);
    return () => clearTimeout(timer);
  }, [text, sessionId]);

  // Check trigger token for Autocomplete menu
  useEffect(() => {
    const lastWordMatch = /(?:^|\s)([/@][\w\d_.-]*)$/.exec(text);
    if (!lastWordMatch) {
      setMenuOpen(false);
      setMenuType(null);
      setMenuFilter("");
      return;
    }

    const token = lastWordMatch[1];
    const trigger = token[0];
    const filter = token.slice(1).toLowerCase();

    setMenuType(trigger);
    setMenuFilter(filter);
    setSelectedIdx(0);

    if (trigger === "/") {
      const skillCmds = storeSkills.map((s) => ({
        name: `/${s.name || s.id}`,
        description: s.description || `Skill: ${s.name || s.id}`,
        isSkill: true
      }));
      const allCommands = [...SLASH_COMMANDS, ...skillCmds];
      const filtered = allCommands.filter((cmd) => cmd.name.toLowerCase().includes(filter));
      setMenuItems(filtered);
      setMenuOpen(filtered.length > 0);
    } else if (trigger === "@") {
      const b = useConnectionStore.getState().bus;
      if (b?.emit) {
        b.emit("ai:files", { workspace: workspacePath, query: filter }, (res) => {
          if (res?.ok && Array.isArray(res.files)) {
            setMenuItems(
              res.files.map((f) => ({
                name: f.path || f,
                description: f.isModified ? `${f.dir ? f.dir + " · " : ""}modified` : (f.dir || "")
              }))
            );
            setMenuOpen(res.files.length > 0);
          }
        });
      } else if (fileBus?.searchFiles && workspacePath) {
        fileBus.searchFiles(workspacePath, filter).then((res) => {
          if (res?.success && Array.isArray(res.files)) {
            setMenuItems(res.files.slice(0, 10).map((f) => ({ name: f.path || f, description: f.relPath || f })));
            setMenuOpen(res.files.length > 0);
          }
        });
      } else {
        setMenuItems([]);
        setMenuOpen(false);
      }
    }
  }, [text, fileBus, workspacePath, storeSkills, SLASH_COMMANDS]);

  const executeSend = useCallback(() => {
    const raw = textareaRef.current ? textareaRef.current.value : text;
    const trimmed = (raw || text).trim();
    if (!trimmed) return;
    const now = Date.now();
    if (now - lastSendTimeRef.current < 250) return;
    lastSendTimeRef.current = now;
    justSentRef.current = now;

    vibrate();
    setHistory((prev) => [...prev.filter((h) => h !== trimmed), trimmed].slice(-50));
    setHistoryIdx(-1);
    setText("");
    if (textareaRef.current) {
      textareaRef.current.value = "";
      textareaRef.current.style.height = "26px";
    }
    try { localStorage.removeItem(`9remote_draft_${sessionId}`); } catch {}

    // If turn is already streaming, enqueue the prompt
    if (isTurnRunning) {
      setQueuedText(trimmed);
      return;
    }

    if (trimmed.startsWith("!")) {
      onRunShell?.(trimmed.slice(1).trim());
      return;
    }

    onSend?.(trimmed);
  }, [text, sessionId, isTurnRunning, onSend, onRunShell]);

  // When stream finishes normally, automatically drain and send queued prompt
  const prevRunningRef = useRef(isTurnRunning);
  useEffect(() => {
    if (prevRunningRef.current && !isTurnRunning && queuedText) {
      const nextPrompt = queuedText;
      setQueuedText("");
      if (nextPrompt.startsWith("!")) {
        onRunShell?.(nextPrompt.slice(1).trim());
      } else {
        onSend?.(nextPrompt);
      }
    }
    prevRunningRef.current = isTurnRunning;
  }, [isTurnRunning, queuedText, onSend, onRunShell]);

  // Stop stream and immediately dispatch queued prompt if one exists
  const handleStopClick = useCallback(() => {
    vibrate();
    onStop?.();
    if (queuedText) {
      const nextPrompt = queuedText;
      setQueuedText("");
      setTimeout(() => {
        if (nextPrompt.startsWith("!")) {
          onRunShell?.(nextPrompt.slice(1).trim());
        } else {
          onSend?.(nextPrompt);
        }
      }, 70);
    }
  }, [onStop, queuedText, onSend, onRunShell]);

  const selectMenuItem = useCallback((item) => {
    vibrate();
    const lastWordMatch = /(?:^|\s)([/@][\w\d_.-]*)$/.exec(text);
    if (!lastWordMatch) return;

    const token = lastWordMatch[1];
    const prefix = text.slice(0, text.length - token.length);
    const replacement = menuType === "@" ? `@${item.name} ` : `${item.name} `;
    setText(`${prefix}${replacement}`);
    setMenuOpen(false);

    if (menuType === "/" && ["/clear", "/compact", "/cost", "/context", "/doctor", "/help"].includes(item.name)) {
      onSend?.(item.name);
      setText("");
    } else {
      textareaRef.current?.focus();
    }
  }, [text, menuType, onSend]);

  const handleKeyDown = (e) => {
    // Shift+Tab: cycle permission modes (matching Claude Code CLI)
    if (e.shiftKey && e.key === "Tab") {
      e.preventDefault();
      vibrate();
      const modes = CLAUDE_MODES || [];
      if (modes.length > 0) {
        const currentIdx = modes.findIndex((m) => m.id === permissionMode);
        const nextIdx = currentIdx === -1 ? 0 : (currentIdx + 1) % modes.length;
        const nextMode = modes[nextIdx]?.id;
        if (nextMode) onModeChange?.(nextMode);
      }
      return;
    }

    // Escape: cancel autocomplete menu, or stop active stream (& send queue), or clear queue
    if (e.key === "Escape") {
      if (menuOpen) {
        e.preventDefault();
        setMenuOpen(false);
        return;
      }
      if (isTurnRunning) {
        e.preventDefault();
        handleStopClick();
        return;
      }
      if (queuedText) {
        e.preventDefault();
        setQueuedText("");
        return;
      }
    }

    // Autocomplete navigation
    if (menuOpen && menuItems.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx((prev) => (prev + 1) % menuItems.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx((prev) => (prev - 1 + menuItems.length) % menuItems.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        selectMenuItem(menuItems[selectedIdx]);
        return;
      }
    }

    // History traversal on empty or unchanged input
    if (e.key === "ArrowUp" && !text && history.length > 0) {
      e.preventDefault();
      const nextIdx = historyIdx === -1 ? history.length - 1 : Math.max(0, historyIdx - 1);
      setHistoryIdx(nextIdx);
      setText(history[nextIdx]);
      return;
    }
    if (e.key === "ArrowDown" && historyIdx !== -1) {
      e.preventDefault();
      const nextIdx = historyIdx + 1;
      if (nextIdx >= history.length) {
        setHistoryIdx(-1);
        setText("");
      } else {
        setHistoryIdx(nextIdx);
        setText(history[nextIdx]);
      }
      return;
    }

    // Submit on Enter (without Shift) — Shift+Enter inserts newline
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      executeSend();
    }
  };

  const cleanRawModel = useMemo(() => {
    if (!rawModel) return "";
    return rawModel.replace(/\[1m\]$/i, "");
  }, [rawModel]);

  const matchedModel = useMemo(() => {
    if (!cleanRawModel) return null;
    return (MODELS || []).find(
      (m) =>
        m.id === cleanRawModel ||
        m.id === rawModel ||
        m.short.toLowerCase() === cleanRawModel.toLowerCase() ||
        cleanRawModel.startsWith(m.id) ||
        m.id.startsWith(cleanRawModel)
    );
  }, [cleanRawModel, rawModel, MODELS]);

  const displayModel = matchedModel?.short || cleanRawModel || rawModel || "Model";

  const allModels = useMemo(() => {
    const list = [...(MODELS || [])];
    if (cleanRawModel) {
      const exists = list.some((m) => m.id === cleanRawModel || m.id === rawModel);
      if (!exists) {
        list.unshift({ id: cleanRawModel, label: cleanRawModel, short: cleanRawModel });
      }
    }
    return list;
  }, [MODELS, cleanRawModel, rawModel]);

  const activeModeObj = CLAUDE_MODES.find((m) => m.id === permissionMode) || CLAUDE_MODES[0];

  return (
    <div className="relative px-3 py-1.5 bg-transparent border-t border-border-subtle/40 select-none">
      {/* Autocomplete Menu popup */}
      {menuOpen && menuItems.length > 0 && (
        <div
          ref={menuContainerRef}
          className="absolute left-3 right-3 bottom-[calc(100%+6px)] max-h-52 bg-surface border border-border-subtle rounded-brand shadow-lg overflow-y-auto z-50 p-1 custom-scrollbar"
        >
          <div className="px-2 py-0.5 text-[10px] text-text-muted font-mono uppercase tracking-wider border-b border-border-subtle mb-1">
            {menuType === "/" ? "Slash Commands & Skills" : "Files in repo (@)"}
          </div>
          {menuItems.map((item, idx) => (
            <div
              key={item.name}
              data-menu-item="true"
              onClick={() => selectMenuItem(item)}
              onMouseEnter={() => setSelectedIdx(idx)}
              className={`px-2 py-1 rounded-brand flex items-center justify-between text-xs cursor-pointer ${
                idx === selectedIdx ? "bg-surface-2 text-text font-medium" : "text-text-muted hover:text-text"
              }`}
            >
              <div className="flex items-center gap-2 truncate">
                {item.isSkill ? (
                  <Zap size={12} className="text-warning shrink-0" />
                ) : menuType === "/" ? (
                  <Terminal size={12} className="text-accent shrink-0" />
                ) : (
                  <FileCode size={12} className="text-accent shrink-0" />
                )}
                <span className="font-mono text-xs text-text">{item.name}</span>
                {item.isSkill && (
                  <span className="text-[9px] px-1 rounded bg-warning/15 text-warning font-mono">
                    skill
                  </span>
                )}
              </div>
              {item.description && (
                <span className="text-[10px] text-text-muted truncate ml-2 max-w-[50%]">
                  {item.description}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Queued Message Pill */}
      {queuedText && (
        <div className="mb-1 px-2 py-0.5 rounded bg-brand-500/10 border border-brand-500/30 flex items-center justify-between text-xs animate-in fade-in duration-100">
          <div className="flex items-center gap-1.5 truncate min-w-0">
            <span className="font-mono text-[9px] uppercase tracking-wider font-semibold px-1 py-0.2 rounded bg-brand-500/20 text-brand-400 shrink-0">
              Queued
            </span>
            <span className="truncate text-text font-mono text-[11px]">{queuedText}</span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0 ml-2">
            <span className="text-[10px] text-text-muted hidden sm:inline font-mono">Esc to stop & send</span>
            <button
              type="button"
              onClick={() => { vibrate(); setQueuedText(""); }}
              className="text-text-muted hover:text-text p-0.5 rounded hover:bg-surface-2 transition-colors cursor-pointer"
              title="Cancel queued message"
            >
              <X size={12} />
            </button>
          </div>
        </div>
      )}

      {/* Main Composer Box — Transparent, compact height */}
      <div className="rounded-brand border border-border-subtle/80 bg-transparent focus-within:border-brand-500 transition-colors px-2.5 py-1 flex flex-col gap-1">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            if (Date.now() - justSentRef.current < 200) {
              if (textareaRef.current) textareaRef.current.value = "";
              return;
            }
            setText(e.target.value);
          }}
          onFocus={() => onActivate?.()}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => { isComposingRef.current = true; }}
          onCompositionEnd={() => {
            isComposingRef.current = false;
            lastCompositionEndRef.current = Date.now();
            if (Date.now() - justSentRef.current < 200) {
              if (textareaRef.current) textareaRef.current.value = "";
              setText("");
            }
          }}
          placeholder={isTurnRunning ? "Type command · Enter to queue · Esc to stop" : "Type command"}
          rows={1}
          className="w-full bg-transparent resize-none text-xs text-text placeholder-text-muted focus:outline-none custom-scrollbar leading-snug min-h-[24px]"
        />

        {/* Action strip: Model selector, Mode selector & Send button */}
        <div className="relative flex items-center justify-between text-xs pt-0.5 border-t border-border-subtle/30">
          <div className="flex items-center gap-1.5">
            {/* Model Selector Dropdown */}
            <div ref={modelMenuRef} className="relative">
              <button
                type="button"
                onClick={() => { setModelMenuOpen((v) => !v); setModeMenuOpen(false); }}
                className="px-2 py-0.5 rounded text-[11px] font-medium flex items-center gap-1 font-mono bg-surface-2/60 hover:bg-surface-2 text-text transition-colors border border-border-subtle/60 cursor-pointer"
                title="Select model (/model)"
              >
                <img src={agentIconUrl(engine)} alt="" className="w-3.5 h-3.5 object-contain shrink-0" />
                <span className="truncate max-w-[170px] sm:max-w-[240px]">{displayModel}</span>
                <ChevronUp size={11} className={`text-text-muted transition-transform ${modelMenuOpen ? "" : "rotate-180"}`} />
              </button>
              {modelMenuOpen && (
                <div className="absolute left-0 bottom-[calc(100%+6px)] min-w-[260px] max-h-56 bg-surface border border-border-subtle rounded-brand shadow-xl overflow-y-auto z-50 p-1 custom-scrollbar">
                  <div className="px-2 py-0.5 text-[10px] text-text-muted font-mono uppercase tracking-wider border-b border-border-subtle mb-1">
                    Select Model
                  </div>
                  {allModels.map((m) => {
                    const isSelected =
                      cleanRawModel === m.id ||
                      rawModel === m.id ||
                      (matchedModel && matchedModel.id === m.id);
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => {
                          vibrate();
                          onSelectModel?.(m.id);
                          setModelMenuOpen(false);
                        }}
                        className={`w-full px-2 py-1.5 rounded text-left text-xs flex items-center justify-between transition-colors ${
                          isSelected
                            ? "bg-brand-500/15 text-brand-400 font-semibold"
                            : "text-text-muted hover:text-text hover:bg-surface-2"
                        }`}
                      >
                        <span className="truncate font-mono text-[11px]">{m.label}</span>
                        {isSelected && (
                          <Check size={12} className="text-brand-400 shrink-0 ml-1" />
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Mode Selector Dropdown (Chế độ) */}
            <div ref={modeMenuRef} className="relative">
              <button
                type="button"
                onClick={() => { setModeMenuOpen((v) => !v); setModelMenuOpen(false); }}
                className="px-2 py-0.5 rounded text-[11px] font-medium flex items-center gap-1 font-mono bg-surface-2/60 hover:bg-surface-2 text-text transition-colors border border-border-subtle/60 cursor-pointer"
                title="Change permission mode"
              >
                {permissionMode === "bypassPermissions" || permissionMode === "auto" ? (
                  <Sparkles size={11} className="text-warning shrink-0" />
                ) : permissionMode === "plan" ? (
                  <Zap size={11} className="text-accent shrink-0" />
                ) : (
                  <Shield size={11} className="text-text-muted shrink-0" />
                )}
                <span>{activeModeObj.label}</span>
                <ChevronUp size={11} className={`text-text-muted transition-transform ${modeMenuOpen ? "" : "rotate-180"}`} />
              </button>
              {modeMenuOpen && (
                <div className="absolute left-0 bottom-[calc(100%+6px)] min-w-[220px] max-h-56 bg-surface border border-border-subtle rounded-brand shadow-xl overflow-y-auto z-50 p-1 custom-scrollbar">
                  <div className="px-2 py-0.5 text-[10px] text-text-muted font-mono uppercase tracking-wider border-b border-border-subtle mb-1">
                    Permission Mode
                  </div>
                  {CLAUDE_MODES.map((cm) => (
                    <button
                      key={cm.id}
                      type="button"
                      onClick={() => {
                        vibrate();
                        onModeChange?.(cm.id);
                        setModeMenuOpen(false);
                      }}
                      className={`w-full px-2 py-1.5 rounded text-left text-xs flex flex-col gap-0.5 transition-colors ${
                        permissionMode === cm.id
                          ? "bg-brand-500/15 text-brand-400 font-semibold"
                          : "text-text-muted hover:text-text hover:bg-surface-2"
                      }`}
                    >
                      <div className="flex items-center justify-between w-full">
                        <span>{cm.label}</span>
                        {permissionMode === cm.id && <Check size={12} className="text-brand-400 shrink-0" />}
                      </div>
                      <span className="text-[10px] text-text-muted/70 font-normal font-sans leading-tight">
                        {cm.desc}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {isTurnRunning ? (
              <>
                {text.trim() && (
                  <button
                    type="button"
                    onClick={executeSend}
                    className="px-2 py-0.5 rounded bg-brand-500 hover:bg-brand-600 text-white flex items-center gap-1 text-[11px] font-medium transition-colors shadow-sm cursor-pointer"
                    title="Queue message (Enter)"
                  >
                    <Send size={11} />
                    <span>Queue</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleStopClick}
                  className="px-2 py-0.5 rounded bg-danger/20 hover:bg-danger/30 text-danger flex items-center gap-1 text-[11px] font-medium transition-colors cursor-pointer"
                  title={queuedText ? "Stop & send queued message (Esc)" : "Stop generation (Esc)"}
                >
                  <Square size={11} className="fill-current" />
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={executeSend}
                disabled={!text.trim()}
                className={`p-1 rounded transition-colors flex items-center justify-center ${
                  text.trim()
                    ? "bg-brand-500 hover:bg-brand-600 text-white shadow-sm cursor-pointer"
                    : "text-text-muted bg-surface-2 cursor-not-allowed opacity-40"
                }`}
                title="Send (Enter)"
              >
                <Send size={12} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
