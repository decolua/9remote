"use client";

import { memo, useState, useRef, useEffect, useCallback } from "react";
import { Send, Square, Terminal, FileCode, Zap, ChevronUp, Check, Shield, Sparkles } from "@/shared/components/ui/Icon";
import { SLASH_COMMANDS, ENGINE_INFO } from "../constants";
import { vibrate } from "@/shared/utils/vibration";
import { useAiStore } from "@/shared/stores/aiStore";
import { useConnectionStore } from "@/shared/stores/connectionStore";
import { agentIconUrl } from "@/features/terminal/constants/agentCli";

const CLAUDE_MODES = [
  { id: "default", label: "Default", desc: "Ask before executing commands & editing files" },
  { id: "acceptEdits", label: "Accept Edits", desc: "Automatically approve file changes" },
  { id: "bypassPermissions", label: "Bypass (YOLO)", desc: "Bypass all confirmation prompts" },
  { id: "plan", label: "Plan Mode", desc: "Explore and plan without modifying code" },
];

const MODELS = [
  { id: "claude-3-7-sonnet-latest", label: "Sonnet 3.7", short: "Sonnet 3.7" },
  { id: "claude-3-5-sonnet-latest", label: "Sonnet 3.5", short: "Sonnet 3.5" },
  { id: "claude-3-5-haiku-latest", label: "Haiku 3.5", short: "Haiku 3.5" },
  { id: "claude-3-opus-latest", label: "Opus 3", short: "Opus 3" },
  { id: "ag/gemini-3.8-flash-high", label: "Gemini 3.8", short: "Gemini 3.8" },
  { id: "gpt-4o", label: "GPT-4o", short: "GPT-4o" },
];

export const Composer = memo(function Composer({
  sessionId = "",
  engine = "claude",
  isTurnRunning: propTurnRunning = false,
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
  const storeTurnRunning = useAiStore((s) => s.bySession[sessionId]?.isTurnRunning);
  const storeModel = useAiStore((s) => s.bySession[sessionId]?.metadata?.model);
  const storeSkills = useAiStore((s) => s.bySession[sessionId]?.metadata?.skills || []);
  const permissionMode = useAiStore((s) => s.bySession[sessionId]?.permissionMode || "default");

  const isTurnRunning = storeTurnRunning !== undefined ? storeTurnRunning : propTurnRunning;
  const rawModel = storeModel !== undefined ? storeModel : propModel;

  const [text, setText] = useState("");
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
  const engineMeta = ENGINE_INFO[engine] || ENGINE_INFO.claude;

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
  }, [text, fileBus, workspacePath, storeSkills]);

  const executeSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || isTurnRunning) return;

    vibrate();
    setHistory((prev) => [...prev.filter((h) => h !== trimmed), trimmed].slice(-50));
    setHistoryIdx(-1);
    setText("");
    try { localStorage.removeItem(`9remote_draft_${sessionId}`); } catch {}
    if (textareaRef.current) textareaRef.current.style.height = "40px";

    if (trimmed.startsWith("!")) {
      onRunShell?.(trimmed.slice(1).trim());
      return;
    }

    onSend?.(trimmed);
  }, [text, sessionId, isTurnRunning, onSend, onRunShell]);

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
      if (e.key === "Escape") {
        e.preventDefault();
        setMenuOpen(false);
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

    // Submit on Enter (without Shift)
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      executeSend();
    }
  };

  const matchedModel = MODELS.find((m) => m.id === rawModel || m.short.toLowerCase() === rawModel?.toLowerCase());
  const displayModel = matchedModel?.short || rawModel || "Model";
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
                  <Zap size={12} className="text-purple-400 shrink-0" />
                ) : menuType === "/" ? (
                  <Terminal size={12} className="text-brand-500 shrink-0" />
                ) : (
                  <FileCode size={12} className="text-brand-500 shrink-0" />
                )}
                <span className="font-mono text-xs text-text">{item.name}</span>
                {item.isSkill && (
                  <span className="text-[9px] px-1 rounded bg-purple-500/15 text-purple-300 font-mono">
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

      {/* Main Composer Box — Transparent, compact height */}
      <div className="rounded-brand border border-border-subtle/80 bg-transparent focus-within:border-brand-500 transition-colors px-2.5 py-1 flex flex-col gap-1">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => onActivate?.()}
          onKeyDown={handleKeyDown}
          placeholder={`Ask ${engineMeta.label} (/ command, @ file, ! shell)...`}
          rows={1}
          className="w-full bg-transparent resize-none text-xs text-text placeholder-text-muted focus:outline-none custom-scrollbar leading-snug min-h-[24px]"
        />

        {/* Action strip: Model selector, Mode selector & Send button */}
        <div className="flex items-center justify-between text-xs pt-0.5 border-t border-border-subtle/30">
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
                <span className="truncate max-w-[105px]">{displayModel}</span>
                <ChevronUp size={11} className={`text-text-muted transition-transform ${modelMenuOpen ? "" : "rotate-180"}`} />
              </button>
              {modelMenuOpen && (
                <div className="absolute left-0 bottom-[calc(100%+6px)] min-w-[200px] max-h-56 bg-surface border border-border-subtle rounded-brand shadow-xl overflow-y-auto z-50 p-1 custom-scrollbar">
                  <div className="px-2 py-0.5 text-[10px] text-text-muted font-mono uppercase tracking-wider border-b border-border-subtle mb-1">
                    Select Model
                  </div>
                  {MODELS.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => {
                        vibrate();
                        onSelectModel?.(m.id);
                        setModelMenuOpen(false);
                      }}
                      className={`w-full px-2 py-1.5 rounded text-left text-xs flex items-center justify-between transition-colors ${
                        (rawModel === m.id || (!rawModel && m.id.includes("3-7-sonnet")))
                          ? "bg-brand-500/15 text-brand-400 font-semibold"
                          : "text-text-muted hover:text-text hover:bg-surface-2"
                      }`}
                    >
                      <span className="truncate">{m.label}</span>
                      {(rawModel === m.id || (!rawModel && m.id.includes("3-7-sonnet"))) && (
                        <Check size={12} className="text-brand-400 shrink-0 ml-1" />
                      )}
                    </button>
                  ))}
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
                  <Sparkles size={11} className="text-amber-400 shrink-0" />
                ) : permissionMode === "plan" ? (
                  <Zap size={11} className="text-purple-400 shrink-0" />
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
              <button
                type="button"
                onClick={() => { vibrate(); onStop?.(); }}
                className="px-2 py-0.5 rounded bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 flex items-center gap-1 text-[11px] font-medium transition-colors"
                title="Stop generation"
              >
                <Square size={11} className="fill-current" />
                <span>Stop</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={executeSend}
                disabled={!text.trim()}
                className={`p-1 rounded transition-colors flex items-center justify-center ${
                  text.trim()
                    ? "bg-brand-500 hover:bg-brand-600 text-white shadow-sm"
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
