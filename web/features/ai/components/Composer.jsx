"use client";

import { memo, useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Send, Square, Terminal, FileCode, Zap, ChevronUp, Check, X, Paperclip, Mic, MicOff, History, Search } from "@/shared/components/ui/Icon";
import { ENGINE_INFO, SKIP_BEHAVIOR, SKIP_MESSAGE } from "../constants";
import { getEngineConfig } from "../registry";
import { buildSlashItems } from "../lib/slashMenu";
import { buildModelSections } from "../lib/modelSections";
import { vibrate } from "@/shared/utils/vibration";
import { useAiStore } from "@/shared/stores/aiStore";
import { useConnectionStore } from "@/shared/stores/connectionStore";
import { agentIconUrl, AGENT_ICON_CLS } from "@/features/terminal/constants/agentCli";
import { useVoiceInput, localeToSpeechLang, useVoiceLang } from "@/shared/hooks/useVoiceInput";
import { useI18n } from "@/shared/i18n";
import { useInputMode } from "@/shared/hooks/useInputMode";
import { isMac } from "@/features/terminal/constants/shortcuts";
import { useAttachments } from "@/features/terminal/hooks/useAttachments";
import CommandSuggestions, { pickCommandItems } from "@/shared/components/ui/CommandSuggestions";
import { useAiHistoryStore } from "@/shared/stores/historyStore";
import CommandHistoryModal from "@/shared/components/ui/CommandHistoryModal";
import VoicePill from "@/shared/components/ui/VoicePill";

const EMPTY_ARRAY = [];
// Only long lists (omp catalogs hundreds of models) get the inline search box.
const MODEL_MENU_SEARCH_MIN = 20;

export const Composer = memo(function Composer({
  sessionId = "",
  engine = "claude",
  isTurnRunning: propTurnRunning = false,
  isFocused = false,
  onSend,
  onRemoveQueueItem,
  onClearQueue,
  onStop,
  onRunShell,
  onResolvePermission,
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
  const hasKeyboard = useInputMode() === "mouse";
  const tabHint = isMac() ? "Opt ←/→ · Opt 1…9 to switch tab" : "Ctrl+Shift+←/→ · 1…9 to switch tab";
  const engineConfig = getEngineConfig(engine);
  const CLAUDE_MODES = engineConfig.permissionModes;
  const SLASH_COMMANDS = engineConfig.slashCommands;
  const storeTurnRunning = useAiStore((s) => s.bySession[sessionId]?.isTurnRunning);
  const storeModel = useAiStore((s) => s.bySession[sessionId]?.metadata?.model);
  const hostModels = useAiStore((s) => s.bySession[sessionId]?.metadata?.modelOptions);
  const MODELS = hostModels?.length ? hostModels : engineConfig.models;
  const storeSkills = useAiStore((s) => s.bySession[sessionId]?.metadata?.skills) || EMPTY_ARRAY;
  // Live engine command feed (opencode /command, omp available_commands_update).
  const storeCommands = useAiStore((s) => s.bySession[sessionId]?.metadata?.commands) || EMPTY_ARRAY;
  const storeMode = useAiStore((s) => s.bySession[sessionId]?.permissionMode);
  const storeTier = useAiStore((s) => s.bySession[sessionId]?.metadata?.effort || s.bySession[sessionId]?.metadata?.variant);
  const permissionMode = storeMode || engineConfig.defaultMode;

  const isTurnRunning = storeTurnRunning !== undefined ? storeTurnRunning : propTurnRunning;
  const rawModel = storeModel !== undefined ? storeModel : propModel;

  const [text, setText] = useState("");
  // Queue from agent session store (persisted on host across mobile disconnects).
  const queue = useAiStore((s) => s.bySession[sessionId]?.queue) || EMPTY_ARRAY;
  const [historyIdx, setHistoryIdx] = useState(-1);
  const draftRef = useRef("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuType, setMenuType] = useState(null); // "/" or "@"
  const [menuFilter, setMenuFilter] = useState("");
  const [menuItems, setMenuItems] = useState([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [submenuCmd, setSubmenuCmd] = useState(null);
  const [suggestActive, setSuggestActive] = useState(-1);

  const addCommand = useAiHistoryStore((s) => s.addCommand);
  const resolveAlias = useAiHistoryStore((s) => s.resolveAlias);
  const promptHistory = useAiHistoryStore((s) => s.history);
  const pinnedPrompts = useAiHistoryStore((s) => s.pinned);
  const suggestItems = useMemo(
    () => (menuOpen ? [] : pickCommandItems(text, promptHistory, pinnedPrompts, [], !hasKeyboard)),
    [text, promptHistory, pinnedPrompts, hasKeyboard, menuOpen]
  );

  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const [collapsedSections, setCollapsedSections] = useState(() => new Set());
  const [tierMenuOpen, setTierMenuOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const modelMenuRef = useRef(null);

  // Staged attachments held as base64 until send.
  const {
    attachments, setAttachments,
    removeAttachment, handleFileUpload, handleAttachPaste
  } = useAttachments({ bus: useConnectionStore((s) => s.bus), sessionId });

  const [voiceLang] = useVoiceLang(locale);
  const voice = useVoiceInput({
    lang: localeToSpeechLang(voiceLang),
    onText: (txt) => {
      setText(txt);
      if (textareaRef.current) {
        textareaRef.current.value = txt;
        textareaRef.current.style.height = "auto";
        textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
        textareaRef.current.focus();
      }
    },
  });

  const handleVoiceDone = useCallback(() => {
    vibrate();
    voice.stop();
  }, [voice]);

  const handleVoiceCancel = useCallback(() => {
    voice.cancel();
  }, [voice]);

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

  // Auto-focus input on desktop when pane becomes active.
  useEffect(() => {
    if (isFocused && !modalOpen && hasKeyboard) textareaRef.current?.focus({ preventScroll: true });
  }, [isFocused, modalOpen, hasKeyboard]);

  useEffect(() => {
    const onClick = (e) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target)) {
        setModelMenuOpen(false);
        setTierMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  useEffect(() => {
    if (isTurnRunning) {
      setModelMenuOpen(false);
      setTierMenuOpen(false);
    }
  }, [isTurnRunning]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const nextH = Math.min(el.scrollHeight, 140);
    el.style.height = `${Math.max(nextH, 26)}px`;
  }, [text]);

  useEffect(() => {
    if (!menuOpen || !menuContainerRef.current) return;
    const items = menuContainerRef.current.querySelectorAll("[data-menu-item]");
    const activeEl = items[selectedIdx];
    if (activeEl) {
      activeEl.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIdx, menuOpen]);

  // Reset attachments and restore draft on session change.
  useEffect(() => {
    if (!sessionId) return;
    setAttachments([]);
    try {
      setText(localStorage.getItem(`9remote_draft_${sessionId}`) || "");
    } catch {}
  }, [sessionId, setAttachments]);

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

  useEffect(() => {
    // Keep submenu open while text ends in the triggering command.
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
      // A live command or skill can share a host builtin's name: first one wins.
      const filtered = buildSlashItems({
        staticCommands: SLASH_COMMANDS,
        liveCommands: storeCommands,
        skills: storeSkills,
        filter
      });
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
  }, [text, fileBus, workspacePath, storeSkills, storeCommands, SLASH_COMMANDS, submenuCmd]);

  const executeSend = useCallback((overrideText) => {
    const raw = typeof overrideText === "string" ? overrideText : (textareaRef.current ? textareaRef.current.value : text);
    const trimmed = resolveAlias((raw || text).trim());
    const pending = attachmentsRef.current;
    if (!trimmed && pending.length === 0) return;
    const now = Date.now();
    if (now - lastSendTimeRef.current < 250) return;
    lastSendTimeRef.current = now;
    justSentRef.current = now;

    vibrate();
    if (trimmed) {
      if (!trimmed.startsWith("!")) addCommand(trimmed);
    }
    setHistoryIdx(-1);
    setText("");
    if (textareaRef.current) {
      textareaRef.current.value = "";
      textareaRef.current.style.height = "26px";
    }
    try { localStorage.removeItem(`9remote_draft_${sessionId}`); } catch {}

    if (trimmed.startsWith("!")) {
      if (!pending.length) onRunShell?.(trimmed.slice(1).trim());
      return;
    }

    // Auto-skip active permission gate when typing a new message.
    const gate = useAiStore.getState().bySession[sessionId]?.activePermission;
    if (gate) onResolvePermission?.(gate.requestId, SKIP_BEHAVIOR, SKIP_MESSAGE);

    if (pending.length) setAttachments([]);
    onSend?.(trimmed, {
      attachments: pending.map(({ name, type, content }) => ({ filename: name, type, content }))
    });
  }, [text, sessionId, onSend, onRunShell, onResolvePermission, setAttachments, addCommand, resolveAlias]);

  const handleStopClick = useCallback(() => {
    vibrate();
    onStop?.();
  }, [onStop]);

  const runSlashAction = useCallback((item) => {
    const action = item.action || "send";
    const [kind, arg] = action.split(":");

    if (kind === "modal") {
      textareaRef.current?.blur();
      onOpenModal?.(arg);
      return;
    }
    if (kind === "clear") {
      onSend?.("/clear", { force: true });
      setText("");
      return;
    }
    if (kind === "setMode") {
      onModeChange?.(item.mode);
      setText("");
      return;
    }
    if (kind === "send" || action === "send") {
      onSend?.(item.name);
      setText("");
      return;
    }
    textareaRef.current?.focus();
  }, [onOpenModal, onSend, onModeChange]);

  const selectMenuItem = useCallback((item) => {
    vibrate();
    const lastWordMatch = /(?:^|\s)([/@][\w\d_.-]*)$/.exec(text);
    if (!lastWordMatch) return;

    const token = lastWordMatch[1];
    const prefix = text.slice(0, text.length - token.length);
    const opensModal = menuType === "/" && item.action?.startsWith("modal:");
    const replacement = menuType === "@" ? `@${item.name} ` : `${item.name} `;
    setText(opensModal ? prefix : `${prefix}${replacement}`);
    setMenuOpen(false);

    if (menuType !== "/") {
      textareaRef.current?.focus();
      return;
    }
    if (item.action === "submenu" && Array.isArray(item.subOptions) && item.subOptions.length > 0) {
      if (isTurnRunning && (item.optionKey === "effort" || item.optionKey === "variant")) {
        setText("");
        return;
      }
      setSubmenuCmd(item);
      setSelectedIdx(0);
      setMenuOpen(true);
      return;
    }
    runSlashAction(item);
  }, [text, menuType, runSlashAction, isTurnRunning]);

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

  const selectSuggestion = useCallback((cmd) => {
    vibrate();
    const lastWordMatch = /(?:^|\s)(\S*)$/.exec(text);
    const token = lastWordMatch ? lastWordMatch[1] : "";
    setText(text.slice(0, text.length - token.length) + cmd);
    setSuggestActive(-1);
    textareaRef.current?.focus();
  }, [text]);

  const handleKeyDown = (e) => {
    if (modalOpen) return;
    if (e.nativeEvent?.isComposing || e.keyCode === 229) return;

    // Shift+Tab: cycle permission modes (matching Claude Code CLI)
    if (e.shiftKey && e.key === "Tab") {
      e.preventDefault();
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
        console.log("[TEMP DIAGNOSTIC] Esc → stop", { sessionId });
        handleStopClick();
        return;
      }
      if (queue.length > 0) {
        e.preventDefault();
        onClearQueue?.();
        return;
      }
    }

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

    if (suggestItems.length > 0) {
      const activeIdx = suggestActive < 0 ? -1 : ((suggestActive % suggestItems.length) + suggestItems.length) % suggestItems.length;
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        setSuggestActive(activeIdx === -1 ? 0 : (activeIdx + 1) % suggestItems.length);
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && activeIdx !== -1) {
        e.preventDefault();
        selectSuggestion(suggestItems[activeIdx].cmd);
        return;
      }
    }

    const el = textareaRef.current;
    const caret = el?.selectionStart ?? 0;
    const value = el?.value ?? "";
    const atFirstLine = value.lastIndexOf("\n", caret - 1) === -1;
    const atLastLine = value.indexOf("\n", caret) === -1;

    if (e.key === "ArrowUp" && !submenuCmd && !menuOpen && atFirstLine && promptHistory.length > 0) {
      e.preventDefault();
      if (historyIdx === -1) draftRef.current = text;
      const nextIdx = Math.min(historyIdx + 1, promptHistory.length - 1);
      if (nextIdx === historyIdx) return;
      setHistoryIdx(nextIdx);
      setText(promptHistory[nextIdx]);
      return;
    }
    if (e.key === "ArrowDown" && !submenuCmd && !menuOpen && atLastLine && historyIdx !== -1) {
      e.preventDefault();
      const nextIdx = historyIdx - 1;
      if (nextIdx < 0) {
        setHistoryIdx(-1);
        setText(draftRef.current);
      } else {
        setHistoryIdx(nextIdx);
        setText(promptHistory[nextIdx]);
      }
      return;
    }

    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      executeSend();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && hasKeyboard) {
      e.preventDefault();
      executeSend();
    }
  };

  // Match model IDs allowing for provider prefixes and context suffixes.
  const modelKey = (id) => String(id || "").toLowerCase().replace(/\[[^\]]*\]$/, "");
  const matchedModel = useMemo(() => {
    if (!rawModel) return null;
    const list = MODELS || [];
    const key = modelKey(rawModel);
    return list.find((m) => m.id === rawModel)
      || list.find((m) => modelKey(m.id) === key)
      || list.find((m) => modelKey(m.id).split("/").pop() === key.split("/").pop())
      || null;
  }, [rawModel, MODELS]);

  const displayModel = matchedModel?.short || matchedModel?.label || rawModel || "Model";

  const displayTier = storeTier || engineConfig.defaultEffort || "";

  const allModels = useMemo(() => {
    const list = [...(MODELS || [])];
    if (rawModel && !list.some((m) => m.id === rawModel)) {
      list.unshift({ id: rawModel, label: rawModel, short: rawModel });
    }
    return list;
  }, [MODELS, rawModel]);

  const modelMenuModels = useMemo(() => {
    if (allModels.length <= MODEL_MENU_SEARCH_MIN) return allModels;
    const q = modelQuery.trim().toLowerCase();
    if (!q) return allModels;
    return allModels.filter((m) => {
      const id = (m.id || "").toLowerCase();
      return (m.label || "").toLowerCase().includes(q) || id.includes(q) || (m.provider || "").toLowerCase().includes(q);
    });
  }, [allModels, modelQuery]);

  // Sections matching OpenCode TUI: Recent, OpenCode Go, OpenCode Zen, others.
  // Short catalogs stay a flat single section — headers would be noise.
  const modelMenuSections = useMemo(
    () => allModels.length <= MODEL_MENU_SEARCH_MIN
      ? [{ key: "all", title: "", items: allModels }]
      : buildModelSections(allModels, modelMenuModels, rawModel, modelQuery.trim()),
    [allModels, modelMenuModels, rawModel, modelQuery]
  );

  const toggleModelSection = (key) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const tierSpec = useMemo(
    () => (SLASH_COMMANDS || []).find((c) => c.action === "submenu" && (c.optionKey === "effort" || c.optionKey === "variant")),
    [SLASH_COMMANDS]
  );
  const tierOptions = useMemo(() => {
    const own = (matchedModel?.efforts || []).map((e) => ({ value: e, label: e }));
    return own.length > 0 ? own : tierSpec?.subOptions || [];
  }, [tierSpec, matchedModel]);

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
          {menuItems.map((item, idx) => {
            const isBlocked = isTurnRunning && (
              item.name === "/model" ||
              (item.action === "submenu" && (item.optionKey === "effort" || item.optionKey === "variant"))
            );
            return (
              <div
                key={item.name}
                data-menu-item="true"
                onClick={isBlocked ? undefined : () => selectMenuItem(item)}
                onMouseEnter={() => setSelectedIdx(idx)}
                className={`px-2 py-1 rounded-brand flex items-center justify-between text-xs ${
                  isBlocked
                    ? "opacity-40 cursor-not-allowed"
                    : idx === selectedIdx ? "bg-surface-2 text-text font-medium cursor-pointer" : "text-text-muted hover:text-text cursor-pointer"
                }`}
                title={isBlocked ? "Cannot change while turn is running" : undefined}
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
            );
          })}
        </div>
      )}

      {/* Queued messages */}
      {queue.length > 0 && (
        <div className="mb-1 space-y-0.5">
          {queue.map((item, idx) => (
            <div
              key={item.id}
              className="px-2 py-0.5 rounded bg-brand-500/10 border border-brand-500/30 flex items-center justify-between text-xs animate-in fade-in duration-100"
            >
              <div className="flex items-center gap-1.5 truncate min-w-0">
                <span className="font-mono text-[9px] uppercase tracking-wider font-semibold px-1 rounded bg-brand-500/20 text-brand-400 shrink-0">
                  {idx === 0 ? "Next" : `Queued ${idx + 1}`}
                </span>
                <span className="truncate text-text font-mono text-[11px]">{item.text}</span>
                {item.attachments?.length > 0 && (
                  <span className="shrink-0 text-text-muted flex items-center gap-0.5 font-mono text-[10px]">
                    <Paperclip size={10} />
                    {item.attachments.length}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0 ml-2">
                {idx === 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      vibrate();
                      handleStopClick();
                    }}
                    className="text-text-muted hover:text-brand-400 p-1 rounded hover:bg-surface-2 transition-colors cursor-pointer"
                    title="Send now (stops the current turn)"
                  >
                    <Send size={13} />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => { vibrate(); onRemoveQueueItem?.(item.id); }}
                  className="text-text-muted hover:text-text p-1 rounded hover:bg-surface-2 transition-colors cursor-pointer"
                  title="Remove from queue"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <VoicePill voice={voice} onDone={handleVoiceDone} onCancel={handleVoiceCancel} className="mb-1.5" />

      <div className="relative rounded-brand border border-border-subtle/80 bg-transparent focus-within:border-brand-500 transition-colors px-2.5 py-1 flex flex-col gap-1">
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

        <CommandSuggestions
          value={text}
          store={useAiHistoryStore}
          isMobile={!hasKeyboard}
          activeIndex={suggestActive}
          onSelect={selectSuggestion}
        />

        <div className="flex items-start gap-1">
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
              setSuggestActive(-1);
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
            placeholder={
              isTurnRunning
                ? (hasKeyboard ? "Type command · Enter to queue · Esc to stop" : "Type command · Send to queue")
                : (hasKeyboard ? `Type command · ${tabHint}` : "Type command")
            }
            rows={1}
            className="ai-conversation ai-composer-input flex-1 min-w-0 bg-transparent resize-none text-xs text-text placeholder-text-muted focus:outline-none custom-scrollbar leading-snug min-h-[24px]"
          />

          {text.trim().length > 0 ? (
            <button
              type="button"
              onClick={clearText}
              className="shrink-0 mt-0.5 p-1.5 rounded text-text-muted hover:text-text hover:bg-surface-2 transition-colors flex items-center justify-center"
              title="Clear input"
            >
              <X size={16} />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => { vibrate(); setHistoryOpen(true); }}
              className="shrink-0 mt-0.5 p-1.5 rounded text-text-muted hover:text-text hover:bg-surface-2 transition-colors flex items-center justify-center"
              title={t("history.title")}
            >
              <History size={16} />
            </button>
          )}
        </div>

        {/* Action strip: Model selector, Mode selector & Send button */}
        <div className="relative flex items-center justify-between text-xs pt-0.5 border-t border-border-subtle/30">
          <div className="flex items-center gap-1.5 flex-1 min-w-0">
            <div ref={modelMenuRef} className="relative min-w-0 flex items-center gap-1">
              <button
                type="button"
                disabled={isTurnRunning}
                onClick={() => { setModelMenuOpen(!modelMenuOpen); if (!modelMenuOpen) setModelQuery(""); setTierMenuOpen(false); }}
                className="min-w-0 px-1.5 py-0.5 rounded text-[11px] font-medium flex items-center gap-1 font-mono text-text-muted hover:text-text hover:bg-surface-2 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                title={isTurnRunning ? "Cannot change model while turn is running" : "Select model (/model)"}
              >
                <img src={agentIconUrl(`${engine}-ui`)} alt="" className={`w-3.5 h-3.5 object-contain shrink-0 ${AGENT_ICON_CLS}`} />
                <span dir="rtl" className="truncate min-w-0"><bdi>{displayModel}</bdi></span>
                <ChevronUp size={11} className={`text-text-muted shrink-0 transition-transform ${modelMenuOpen ? "" : "rotate-180"}`} />
              </button>
              {modelMenuOpen && (
                <div className="absolute left-0 bottom-[calc(100%+6px)] min-w-[260px] max-h-56 bg-surface border border-border-subtle rounded-brand shadow-xl overflow-y-auto z-50 p-1 custom-scrollbar">
                  <div className="px-2 py-0.5 text-[10px] text-text-muted font-mono uppercase tracking-wider border-b border-border-subtle mb-1">
                    Select Model
                  </div>
                  {allModels.length > MODEL_MENU_SEARCH_MIN && (
                    <div className="px-1.5 pb-1.5 mb-1 border-b border-border-subtle flex items-center gap-1.5 text-text-muted">
                      <Search size={12} className="shrink-0" />
                      <input
                        type="text"
                        value={modelQuery}
                        onChange={(e) => setModelQuery(e.target.value)}
                        placeholder="Search models..."
                        autoFocus
                        className="w-full bg-transparent text-[11px] text-text placeholder-text-muted/70 focus:outline-none py-0.5"
                      />
                    </div>
                  )}
                  {modelMenuModels.length === 0 && (
                    <div className="px-2 py-2 text-[11px] text-text-muted">No models match &quot;{modelQuery}&quot;</div>
                  )}
                  {modelMenuSections.map((sec) => (
                    <div key={sec.key}>
                      {modelMenuSections.length > 1 && (
                        <button
                          type="button"
                          onClick={() => toggleModelSection(sec.key)}
                          aria-expanded={!collapsedSections.has(sec.key)}
                          className="w-full px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider font-semibold text-text flex items-center justify-between select-none border-b border-border-subtle mb-1 mt-1 first:mt-0"
                        >
                          <span className="flex items-center gap-1">
                            <span className="text-[8px]">{collapsedSections.has(sec.key) ? "▶" : "▼"}</span>
                            {sec.title}
                          </span>
                          <span className="text-[9px] text-text-subtle">{sec.items.length}</span>
                        </button>
                      )}
                      {!collapsedSections.has(sec.key) && sec.items.map((m) => {
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
                            title={m.id}
                            className={`w-full pl-4 pr-2 py-1.5 rounded text-left text-xs flex flex-col gap-0.5 transition-colors ${
                              isSelected
                                ? "bg-surface-2 text-text font-semibold"
                                : "text-text-muted hover:text-text hover:bg-surface-2"
                            }`}
                          >
                            <span className="w-full flex items-center justify-between">
                              <span className="truncate">{m.label}</span>
                              {isSelected && (
                                <Check size={12} className="text-text shrink-0 ml-1" />
                              )}
                            </span>
                            {m.label !== m.id && (
                              <span className="truncate font-mono text-[10px] text-text-subtle">{m.id}</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}

              {tierOptions.length > 0 && (
                <>
                  <button
                    type="button"
                    disabled={isTurnRunning}
                    onClick={() => { setTierMenuOpen((v) => !v); setModelMenuOpen(false); }}
                    className="shrink-0 px-1 py-0.5 rounded text-[10px] uppercase tracking-wide font-mono text-text-muted hover:text-text hover:bg-surface-2 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                    title={isTurnRunning ? `Cannot change ${tierSpec?.optionKey || "effort"} while turn is running` : `Select ${tierSpec?.optionKey || "effort"}`}
                  >
                    {displayTier || "—"}
                  </button>
                  {tierMenuOpen && (
                    <div className="absolute left-0 bottom-[calc(100%+6px)] min-w-[220px] max-h-56 bg-surface border border-border-subtle rounded-brand shadow-xl overflow-y-auto z-50 p-1 custom-scrollbar">
                      <div className="px-2 py-0.5 text-[10px] text-text-muted font-mono uppercase tracking-wider border-b border-border-subtle mb-1">
                        {tierSpec?.optionKey === "variant" ? "Variant" : "Reasoning effort"}
                      </div>
                      {tierOptions.map((opt) => {
                        const isSelected = displayTier === opt.value;
                        return (
                          <button
                            key={opt.value}
                            type="button"
                            onClick={() => {
                              vibrate();
                              onOptionChange?.(tierSpec?.optionKey || "effort", opt.value);
                              setTierMenuOpen(false);
                            }}
                            className={`w-full px-2 py-1.5 rounded text-left text-xs flex items-center justify-between gap-2 transition-colors ${
                              isSelected
                                ? "bg-brand-500/15 text-brand-400 font-semibold"
                                : "text-text-muted hover:text-text hover:bg-surface-2"
                            }`}
                          >
                            <span className="font-mono truncate">{opt.label}</span>
                            {isSelected && <Check size={12} className="text-brand-400 shrink-0" />}
                            {!isSelected && opt.desc && (
                              <span className="text-[10px] text-text-subtle truncate max-w-[55%]">{opt.desc}</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0 pl-1.5">
            <label
              className="p-1.5 rounded text-text-muted hover:text-text hover:bg-surface-2 transition-colors cursor-pointer flex items-center justify-center"
              title="Attach file or image"
            >
              <Paperclip size={15} />
              <input type="file" multiple onChange={handleFileUpload} className="hidden" accept="*/*" />
            </label>

            {voice.active && (
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={toggleVoice}
                title={voice.error === "not-allowed" || voice.error === "service-not-allowed" ? t("voice.denied") : t("voice.dictate")}
                aria-label={t("voice.dictate")}
                className={`p-1.5 rounded flex items-center justify-center transition-colors ${
                  voice.listening ? "bg-red-500/90 text-white animate-pulse" : voice.error ? "text-red-400" : "text-text-muted hover:text-text hover:bg-surface-2"
                }`}
              >
                {voice.listening ? <MicOff size={15} /> : <Mic size={15} />}
              </button>
            )}

            {isTurnRunning ? (
              <>
                {(text.trim() || attachments.length > 0) && (
                  <button
                    type="button"
                    onClick={executeSend}
                    className="px-2 py-0.5 rounded bg-brand-500 hover:bg-brand-600 text-white flex items-center gap-1 text-[11px] font-medium transition-colors shadow-sm cursor-pointer"
                    title={hasKeyboard ? "Queue message (Enter)" : "Queue message"}
                  >
                    <Send size={13} />
                    <span>Queue</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleStopClick}
                  className="px-2 py-0.5 rounded bg-danger/20 hover:bg-danger/30 text-danger flex items-center gap-1 text-[11px] font-medium transition-colors cursor-pointer"
                  title={queue.length ? "Stop & run the next queued message (Esc)" : "Stop generation (Esc)"}
                >
                  <Square size={13} className="fill-current" />
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={executeSend}
                disabled={!text.trim() && attachments.length === 0}
                className={`px-2 py-1 rounded transition-colors flex items-center justify-center ${
                  text.trim() || attachments.length > 0
                    ? "bg-brand-500 hover:bg-brand-600 text-white shadow-sm cursor-pointer"
                    : "text-text-muted bg-surface-2 cursor-not-allowed opacity-40"
                }`}
                title="Send (Enter)"
              >
                <Send size={14} />
              </button>
            )}
          </div>
        </div>
      </div>

      <CommandHistoryModal
        isOpen={historyOpen}
        store={useAiHistoryStore}
        onSelect={selectSuggestion}
        onClose={() => setHistoryOpen(false)}
      />

    </div>
  );
});
