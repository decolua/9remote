"use client";

import { memo, useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Send, Square, Terminal, FileCode, Zap, ChevronUp, Check, X, Paperclip, Mic, MicOff } from "@/shared/components/ui/Icon";
import { ENGINE_INFO } from "../constants";
import { getEngineConfig } from "../registry";
import { vibrate } from "@/shared/utils/vibration";
import { useAiStore } from "@/shared/stores/aiStore";
import { useConnectionStore } from "@/shared/stores/connectionStore";
import { agentIconUrl, AGENT_ICON_CLS } from "@/features/terminal/constants/agentCli";
import { useVoiceInput, localeToSpeechLang, useVoiceLang } from "@/shared/hooks/useVoiceInput";
import VoiceLangModal from "@/shared/components/ui/VoiceLangModal";
import { useI18n } from "@/shared/i18n";
import { useAttachments } from "@/features/terminal/hooks/useAttachments";

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
  onOpenModal,
  onOptionChange,
  onActivate,
  fileBus = null,
  workspacePath = "",
  model: propModel = "",
  modalOpen = false
}) {
  const { t, locale } = useI18n();
  const engineConfig = getEngineConfig(engine);
  const CLAUDE_MODES = engineConfig.permissionModes;
  const SLASH_COMMANDS = engineConfig.slashCommands;
  const storeTurnRunning = useAiStore((s) => s.bySession[sessionId]?.isTurnRunning);
  const storeModel = useAiStore((s) => s.bySession[sessionId]?.metadata?.model);
  // Models the host actually offers (its own CLI settings). The registry list is only
  // a fallback for engines whose models are not host-specific.
  const hostModels = useAiStore((s) => s.bySession[sessionId]?.metadata?.modelOptions);
  const MODELS = hostModels?.length ? hostModels : engineConfig.models;
  const storeSkills = useAiStore((s) => s.bySession[sessionId]?.metadata?.skills) || EMPTY_ARRAY;
  const storeMode = useAiStore((s) => s.bySession[sessionId]?.permissionMode);
  // Before the host answers, the engine's own defaultMode is the truth.
  const permissionMode = storeMode || engineConfig.defaultMode;

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
  // The slash command whose second-level option list is open (e.g. /effort)
  const [submenuCmd, setSubmenuCmd] = useState(null);

  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const modelMenuRef = useRef(null);

  // Staged files/images, held as base64 until send then handed to the host, which
  // writes them where the CLI can read them. `bus` is unused by the hook on this
  // path (that is the terminal's clipboard route) but it is what it is built around.
  const {
    attachments, setAttachments,
    removeAttachment, handleFileUpload, handleAttachPaste
  } = useAttachments({ bus: useConnectionStore((s) => s.bus), sessionId });

  // Voice dictation language: persisted, defaults to the UI locale. Chosen via modal.
  const [voiceLang, setVoiceLang] = useVoiceLang(locale);
  const [voiceLangOpen, setVoiceLangOpen] = useState(false);
  const voice = useVoiceInput({
    lang: localeToSpeechLang(voiceLang),
    onText: (txt) => setText(txt),
  });
  const toggleVoice = useCallback(() => {
    if (voice.listening) { voice.stop(); return; }
    document.activeElement?.blur(); // hide soft keyboard while dictating
    voice.start(text);
  }, [voice, text]);

  const clearText = useCallback(() => {
    vibrate();
    setText("");
    if (textareaRef.current) {
      textareaRef.current.value = "";
      textareaRef.current.style.height = "26px";
    }
    try { localStorage.removeItem(`9remote_draft_${sessionId}`); } catch {}
    textareaRef.current?.focus();
  }, [sessionId]);

  const textareaRef = useRef(null);
  const attachmentsRef = useRef(attachments);
  useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);
  const menuContainerRef = useRef(null);
  const isComposingRef = useRef(false);
  const lastCompositionEndRef = useRef(0);
  const lastSendTimeRef = useRef(0);
  const justSentRef = useRef(0);
  const engineMeta = ENGINE_INFO[engine] || ENGINE_INFO.claude;

  // Auto-focus only when this specific pane is active/focused and not busy running.
  // Never while a modal is open — it would drag focus back out of the modal panel.
  useEffect(() => {
    if (isFocused && !isTurnRunning && !modalOpen) {
      textareaRef.current?.focus();
    }
  }, [isFocused, isTurnRunning, modalOpen]);

  // Auto-close the model popover on outside click
  useEffect(() => {
    const onClick = (e) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target)) setModelMenuOpen(false);
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
    // While a submenu is open it owns the popup. Picking a command sets the text to
    // "/effort ", which would otherwise re-enter this effect and close the submenu
    // before the user can pick — so keep it open as long as the text still ends in
    // that command, and close it once the user types something else.
    if (submenuCmd) {
      const escaped = submenuCmd.name.replace(/[/@]/g, "\\$&");
      if (new RegExp(`(?:^|\\s)${escaped}\\s*$`).test(text)) return;
      setSubmenuCmd(null);
    }

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
  }, [text, fileBus, workspacePath, storeSkills, SLASH_COMMANDS, submenuCmd]);

  const executeSend = useCallback(() => {
    const raw = textareaRef.current ? textareaRef.current.value : text;
    const trimmed = (raw || text).trim();
    // Read the staged files live, not from this render's closure: the send button's
    // own re-render does not update a memoized callback, so a file picked right
    // before Send was silently dropped.
    const pending = attachmentsRef.current;
    // An attachment with no caption is still a message — a picture needs no words.
    if (!trimmed && pending.length === 0) return;
    const now = Date.now();
    if (now - lastSendTimeRef.current < 250) return;
    lastSendTimeRef.current = now;
    justSentRef.current = now;

    vibrate();
    if (trimmed) setHistory((prev) => [...prev.filter((h) => h !== trimmed), trimmed].slice(-50));
    setHistoryIdx(-1);
    setText("");
    if (textareaRef.current) {
      textareaRef.current.value = "";
      textareaRef.current.style.height = "26px";
    }
    try { localStorage.removeItem(`9remote_draft_${sessionId}`); } catch {}

    // A shell command is text-only — attachments would have nowhere to go, and the
    // box must not be cleared for one the user is still composing.
    if (trimmed.startsWith("!")) {
      if (!pending.length) onRunShell?.(trimmed.slice(1).trim());
      return;
    }

    // Turn state read live, not from this render's closure — a memoized callback
    // would otherwise queue a prompt for a turn that has already ended.
    if (useAiStore.getState().bySession[sessionId]?.isTurnRunning) {
      setQueuedText(trimmed);
      return;
    }

    if (pending.length) setAttachments([]);
    // Send only what the host needs; the terminal's `name`/`size` fields are for its
    // own chips, and the resume path never sees them.
    onSend?.(trimmed, {
      attachments: pending.map(({ name, type, content }) => ({ filename: name, type, content }))
    });
  }, [text, sessionId, onSend, onRunShell, setAttachments]);

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

  // Dispatch a picked slash command by its declared action. The action lives in
  // the engine registry, so this switch never needs an engine-specific branch.
  const runSlashAction = useCallback((item) => {
    const action = item.action || "send";
    const [kind, arg] = action.split(":");

    if (kind === "modal") {
      onOpenModal?.(arg);
      setText("");
      return;
    }
    if (kind === "clear") {
      // Host-side reset — works mid-turn, so it is not dropped by the running guard.
      onSend?.("/clear", { force: true });
      setText("");
      return;
    }
    if (kind === "setMode") {
      // A command that switches the session's mode (codex `/plan`); the mode lives in
      // the engine's permission list, so this never needs an engine-specific branch.
      onModeChange?.(item.mode);
      setText("");
      return;
    }
    if (kind === "send" || action === "send") {
      // CLI-owned command (e.g. /compact, /review). Mid-turn it would be dropped by
      // the running guard, so queue it the same way a normal prompt is queued.
      if (isTurnRunning) {
        setQueuedText(item.name);
        setText("");
        return;
      }
      onSend?.(item.name);
      setText("");
      return;
    }
    // Unknown/local action → leave the token in the box for the user to complete.
    textareaRef.current?.focus();
  }, [onOpenModal, onSend, isTurnRunning, onModeChange]);

  const selectMenuItem = useCallback((item) => {
    vibrate();
    const lastWordMatch = /(?:^|\s)([/@][\w\d_.-]*)$/.exec(text);
    if (!lastWordMatch) return;

    const token = lastWordMatch[1];
    const prefix = text.slice(0, text.length - token.length);
    // A modal command is an action, not text: writing the token into the box first
    // would flash it and leave it behind when the modal closes.
    const opensModal = menuType === "/" && item.action?.startsWith("modal:");
    const replacement = menuType === "@" ? `@${item.name} ` : `${item.name} `;
    // A submenu keeps its token in the box: the effect above holds the submenu open
    // only while the text still ends in that command, so clearing it would close the
    // list the user just opened. The text is cleared when an option is picked.
    setText(opensModal ? "" : `${prefix}${replacement}`);
    setMenuOpen(false);

    if (menuType !== "/") {
      textareaRef.current?.focus();
      return;
    }
    // A submenu command opens a second-level list instead of dispatching.
    if (item.action === "submenu" && Array.isArray(item.subOptions) && item.subOptions.length > 0) {
      setSubmenuCmd(item);
      setSelectedIdx(0);
      setMenuOpen(true);
      return;
    }
    runSlashAction(item);
  }, [text, menuType, runSlashAction]);

  // Pick a value from a submenu (e.g. an effort level) and apply it to the session.
  const selectSubOption = useCallback((option) => {
    vibrate();
    const cmd = submenuCmd;
    if (!cmd) return;
    onOptionChange?.(cmd.optionKey, option.value);
    setSubmenuCmd(null);
    setMenuOpen(false);
    setText("");
    textareaRef.current?.focus();
  }, [submenuCmd, onOptionChange]);

  const handleKeyDown = (e) => {
    // A modal above owns the keyboard: the composer keeps focus underneath, so an
    // unguarded Escape would stop the turn and Enter would send a prompt.
    if (modalOpen) return;

    // Shift+Tab: cycle permission modes (matching Claude Code CLI)
    if (e.shiftKey && e.key === "Tab") {
      e.preventDefault();
      // The pane's container handler is a fallback for focus outside the composer;
      // without this the event bubbles and the mode advances twice per press.
      e.stopPropagation();
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

    // Escape: cancel submenu, then autocomplete menu, then stop stream / clear queue
    if (e.key === "Escape") {
      if (submenuCmd) {
        e.preventDefault();
        setSubmenuCmd(null);
        setMenuOpen(false);
        setText("");
        return;
      }
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

    // Submenu option navigation
    if (submenuCmd) {
      const opts = submenuCmd.subOptions || [];
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx((prev) => (prev + 1) % opts.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx((prev) => (prev - 1 + opts.length) % opts.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        selectSubOption(opts[selectedIdx]);
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

  // The raw id is what the CLI reports and what `--model` must receive — `[1m]` picks
  // the 1M-context variant, so it is never stripped from the value that goes back.
  const matchedModel = useMemo(
    () => (rawModel ? (MODELS || []).find((m) => m.id === rawModel) : null),
    [rawModel, MODELS]
  );

  const displayModel = matchedModel?.label || rawModel || "Model";

  // The running model may not be in the host's list (set from another surface, or a
  // settings change since) — show it anyway rather than pretending another is active.
  const allModels = useMemo(() => {
    const list = [...(MODELS || [])];
    if (rawModel && !list.some((m) => m.id === rawModel)) {
      list.unshift({ id: rawModel, label: rawModel, short: rawModel });
    }
    return list;
  }, [MODELS, rawModel]);

  return (    <div className="relative px-3 py-1.5 bg-transparent border-t border-border-subtle/40 select-none">
      {/* Autocomplete Menu popup — second-level option list when a submenu is open */}
      {menuOpen && submenuCmd && (
        <div
          ref={menuContainerRef}
          className="absolute left-3 right-3 bottom-[calc(100%+6px)] max-h-52 bg-surface border border-border-subtle rounded-brand shadow-lg overflow-y-auto z-50 p-1 custom-scrollbar"
        >
          <div className="px-2 py-0.5 text-[10px] text-text-muted font-mono uppercase tracking-wider border-b border-border-subtle mb-1 flex items-center justify-between">
            <span>{submenuCmd.name} — {submenuCmd.optionKey}</span>
            <button
              type="button"
              onClick={() => { setSubmenuCmd(null); setMenuOpen(false); setText(""); }}
              className="text-text-muted hover:text-text"
            >
              <X size={11} />
            </button>
          </div>
          {(submenuCmd.subOptions || []).map((opt, idx) => (
            <div
              key={opt.value}
              data-menu-item="true"
              onClick={() => selectSubOption(opt)}
              onMouseEnter={() => setSelectedIdx(idx)}
              className={`px-2 py-1 rounded-brand flex items-center justify-between text-xs cursor-pointer ${
                idx === selectedIdx ? "bg-surface-2 text-text font-medium" : "text-text-muted hover:text-text"
              }`}
            >
              <span className="font-mono text-xs text-text">{opt.label}</span>
              {opt.desc && (
                <span className="text-[10px] text-text-muted truncate ml-2 max-w-[55%]">{opt.desc}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Autocomplete Menu popup */}
      {menuOpen && !submenuCmd && menuItems.length > 0 && (
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
                {item.action === "submenu" && (
                  <ChevronUp size={11} className="text-text-muted shrink-0 rotate-90" />
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

      {/* While dictating, the language is one tap away — same affordance as the terminal */}
      {voice.supported && voice.listening && (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setVoiceLangOpen(true)}
          title={t("voice.language")}
          className="mb-1 px-2 py-0.5 rounded bg-surface-2 shadow text-[10px] font-semibold uppercase text-text-muted hover:text-text transition-colors"
        >
          {voiceLang}
        </button>
      )}

      {/* Main Composer Box — Transparent, compact height */}
      <div className="rounded-brand border border-border-subtle/80 bg-transparent focus-within:border-brand-500 transition-colors px-2.5 py-1 flex flex-col gap-1">
        {/* Staged attachments — image thumbnails, or a name chip for other files */}
        {attachments.length > 0 && (
          <div className="flex gap-1.5 overflow-x-auto scroll-thin-x pt-0.5">
            {attachments.map((att) => (
              <div key={att.id} className="relative flex-shrink-0 group">
                {att.isImage ? (
                  <img
                    src={`data:${att.type};base64,${att.content}`}
                    alt={att.name}
                    className="w-10 h-10 object-cover rounded border border-border-subtle"
                  />
                ) : (
                  <div className="w-10 h-10 flex flex-col items-center justify-center rounded border border-border-subtle bg-surface-2 px-1">
                    <Paperclip size={12} className="text-text-muted" />
                    <span className="text-[8px] text-text-muted truncate w-full text-center">{att.name}</span>
                  </div>
                )}
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => removeAttachment(att.id)}
                  className="absolute -top-1.5 -right-1.5 w-4 h-4 flex items-center justify-center bg-surface-3 rounded-full text-text-muted hover:text-text border border-border-subtle"
                  aria-label="Remove attachment"
                >
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={text}
          onPaste={handleAttachPaste}
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
          className="ai-conversation ai-composer-input w-full bg-transparent resize-none text-xs text-text placeholder-text-muted focus:outline-none custom-scrollbar leading-snug min-h-[24px]"
        />

        {/* Action strip: Model selector, Mode selector & Send button */}
        <div className="relative flex items-center justify-between text-xs pt-0.5 border-t border-border-subtle/30">
          <div className="flex items-center gap-1.5">
            {/* Model Selector Dropdown */}
            <div ref={modelMenuRef} className="relative">
              <button
                type="button"
                onClick={() => setModelMenuOpen((v) => !v)}
                className="px-1.5 py-0.5 rounded text-[11px] font-medium flex items-center gap-1 font-mono text-text-muted hover:text-text hover:bg-surface-2 transition-colors cursor-pointer"
                title="Select model (/model)"
              >
                <img src={agentIconUrl(`${engine}-ui`)} alt="" className={`w-3.5 h-3.5 object-contain shrink-0 ${AGENT_ICON_CLS}`} />
                <span className="truncate max-w-[170px] sm:max-w-[240px]">{displayModel}</span>
                <ChevronUp size={11} className={`text-text-muted transition-transform ${modelMenuOpen ? "" : "rotate-180"}`} />
              </button>
              {modelMenuOpen && (
                <div className="absolute left-0 bottom-[calc(100%+6px)] min-w-[260px] max-h-56 bg-surface border border-border-subtle rounded-brand shadow-xl overflow-y-auto z-50 p-1 custom-scrollbar">
                  <div className="px-2 py-0.5 text-[10px] text-text-muted font-mono uppercase tracking-wider border-b border-border-subtle mb-1">
                    Select Model
                  </div>
                  {allModels.map((m) => {
                    const isSelected = rawModel === m.id;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => {
                          vibrate();
                          onSelectModel?.(m.id);
                          setModelMenuOpen(false);
                        }}
                        className={`w-full px-2 py-1.5 rounded text-left text-xs flex flex-col gap-0.5 transition-colors ${
                          isSelected
                            ? "bg-brand-500/15 text-brand-400 font-semibold"
                            : "text-text-muted hover:text-text hover:bg-surface-2"
                        }`}
                      >
                        <span className="w-full flex items-center justify-between">
                          <span className="truncate">{m.label}</span>
                          {isSelected && (
                            <Check size={12} className="text-brand-400 shrink-0 ml-1" />
                          )}
                        </span>
                        {m.label !== m.id && (
                          <span className="truncate font-mono text-[10px] opacity-70">{m.id}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {/* Attach a file or image — the host stages it where the CLI can read it */}
            <label
              className="p-1 rounded text-text-muted hover:text-text hover:bg-surface-2 transition-colors cursor-pointer flex items-center justify-center"
              title="Attach file or image"
            >
              <Paperclip size={12} />
              <input type="file" multiple onChange={handleFileUpload} className="hidden" accept="*/*" />
            </label>

            {/* Dictate into the box, same engine the terminal input uses */}
            {voice.supported && (
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={toggleVoice}
                title={voice.error === "not-allowed" || voice.error === "service-not-allowed" ? t("voice.denied") : t("voice.dictate")}
                aria-label={t("voice.dictate")}
                className={`p-1 rounded flex items-center justify-center transition-colors ${
                  voice.listening ? "bg-red-500/90 text-white animate-pulse" : voice.error ? "text-red-400" : "text-text-muted hover:text-text hover:bg-surface-2"
                }`}
              >
                {voice.listening ? <MicOff size={12} /> : <Mic size={12} />}
              </button>
            )}

            {/* Wipe the draft without sending it */}
            {text.trim().length > 0 && (
              <button
                type="button"
                onClick={clearText}
                className="p-1 rounded text-text-muted hover:text-text hover:bg-surface-2 transition-colors flex items-center justify-center"
                title="Clear input"
              >
                <X size={12} />
              </button>
            )}

            {isTurnRunning ? (
              <>
                {(text.trim() || attachments.length > 0) && (
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
                disabled={!text.trim() && attachments.length === 0}
                className={`p-1 rounded transition-colors flex items-center justify-center ${
                  text.trim() || attachments.length > 0
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

      {/* Dictation language picker — only reachable while dictating, like the terminal */}
      <VoiceLangModal
        isOpen={voiceLangOpen}
        value={voiceLang}
        onSelect={setVoiceLang}
        onClose={() => setVoiceLangOpen(false)}
      />
    </div>
  );
});
