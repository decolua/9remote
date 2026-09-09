"use client";

import { memo, useState, useRef, useEffect, useMemo, useCallback } from "react";
import { Send, Square, Terminal, FileCode, Bot, Sparkles, Zap, ChevronUp, CornerDownLeft } from "@/shared/components/ui/Icon";
import { SLASH_COMMANDS, ENGINE_INFO } from "../constants";
import { vibrate } from "@/shared/utils/vibration";
import { useAiStore } from "@/shared/stores/aiStore";

export const Composer = memo(function Composer({
  sessionId = "",
  engine = "claude",
  isTurnRunning: propTurnRunning = false,
  onSend,
  onStop,
  onRunShell,
  fileBus = null,
  workspacePath = "",
  model: propModel = ""
}) {
  const storeTurnRunning = useAiStore((s) => s.bySession[sessionId]?.isTurnRunning);
  const storeModel = useAiStore((s) => s.bySession[sessionId]?.metadata?.model);
  const isTurnRunning = storeTurnRunning !== undefined ? storeTurnRunning : propTurnRunning;
  const model = storeModel !== undefined ? storeModel : propModel;

  const [text, setText] = useState("");
  const [history, setHistory] = useState([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuType, setMenuType] = useState(null); // "/" or "@"
  const [menuFilter, setMenuFilter] = useState("");
  const [menuItems, setMenuItems] = useState([]);
  const [selectedIdx, setSelectedIdx] = useState(0);

  const textareaRef = useRef(null);
  const engineMeta = ENGINE_INFO[engine] || ENGINE_INFO.claude;

  // Autosize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const nextH = Math.min(el.scrollHeight, 180);
    el.style.height = `${Math.max(nextH, 40)}px`;
  }, [text]);

  // Load draft on session change (9cowork UX pattern)
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
      const filtered = SLASH_COMMANDS.filter((cmd) => cmd.name.toLowerCase().includes(filter));
      setMenuItems(filtered);
      setMenuOpen(filtered.length > 0);
    } else if (trigger === "@") {
      if (fileBus?.searchFiles && workspacePath) {
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
  }, [text, fileBus, workspacePath]);

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

  return (
    <div className="relative p-3 border-t border-border-subtle bg-surface select-none">
      {/* Autocomplete Menu popup */}
      {menuOpen && menuItems.length > 0 && (
        <div className="absolute left-3 right-3 bottom-[calc(100%+8px)] max-h-56 bg-surface border border-border-subtle rounded-brand-lg shadow-lg overflow-y-auto z-50 p-1">
          <div className="px-2 py-1 text-[10px] text-text-muted font-mono uppercase tracking-wider border-b border-border-subtle mb-1">
            {menuType === "/" ? "Slash Commands" : "Files in repo (@)"}
          </div>
          {menuItems.map((item, idx) => (
            <div
              key={item.name}
              onClick={() => selectMenuItem(item)}
              onMouseEnter={() => setSelectedIdx(idx)}
              className={`px-2.5 py-1.5 rounded-brand flex items-center justify-between text-xs cursor-pointer ${
                idx === selectedIdx ? "bg-surface-2 text-text font-medium" : "text-text-muted hover:text-text"
              }`}
            >
              <div className="flex items-center gap-2 truncate">
                {menuType === "/" ? <Terminal size={13} className="text-brand-500 shrink-0" /> : <FileCode size={13} className="text-brand-500 shrink-0" />}
                <span className="font-mono text-text">{item.name}</span>
              </div>
              {item.description && (
                <span className="text-[11px] text-text-muted truncate ml-2 max-w-[50%]">
                  {item.description}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Main Composer Box */}
      <div className="rounded-brand-lg border border-border-subtle bg-bg focus-within:border-brand-500 transition-colors p-2 flex flex-col gap-2">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={`Ask ${engineMeta.label} (/ command, @ file, ! shell)...`}
          rows={1}
          className="w-full bg-transparent resize-none text-sm text-text placeholder-text-muted focus:outline-none custom-scrollbar leading-relaxed"
        />

        {/* Action strip */}
        <div className="flex items-center justify-between text-xs pt-1 border-t border-border-subtle/50">
          <div className="flex items-center gap-2">
            <span
              className="px-2 py-0.5 rounded-full text-[10px] font-medium flex items-center gap-1"
              style={{ backgroundColor: `${engineMeta.color}20`, color: engineMeta.color }}
            >
              <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: engineMeta.color }} />
              <span>{model || engineMeta.badge}</span>
            </span>

            {!text && (
              <span className="text-[11px] text-text-muted hidden sm:inline">
                Type <kbd className="px-1 py-0.5 rounded bg-surface-2 text-[10px] font-mono">@</kbd> files · <kbd className="px-1 py-0.5 rounded bg-surface-2 text-[10px] font-mono">/</kbd> commands · <kbd className="px-1 py-0.5 rounded bg-surface-2 text-[10px] font-mono">!</kbd> shell
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            {isTurnRunning ? (
              <button
                type="button"
                onClick={() => { vibrate(); onStop?.(); }}
                className="px-2.5 py-1 rounded bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 flex items-center gap-1 text-xs font-medium transition-colors"
                title="Stop generation"
              >
                <Square size={12} className="fill-current" />
                <span>Stop</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={executeSend}
                disabled={!text.trim()}
                className={`p-1.5 rounded-brand transition-colors flex items-center justify-center ${
                  text.trim()
                    ? "bg-brand-500 hover:bg-brand-600 text-white shadow-sm"
                    : "text-text-muted bg-surface-2 cursor-not-allowed opacity-50"
                }`}
                title="Send (Enter)"
              >
                <Send size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
