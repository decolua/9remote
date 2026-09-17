"use client";

import { memo, useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Send, Square, Terminal, FileCode, Zap, ChevronUp, Check, X, Paperclip, Mic, MicOff, History } from "@/shared/components/ui/Icon";
import { ENGINE_INFO, SKIP_BEHAVIOR, SKIP_MESSAGE } from "../constants";
import { getEngineConfig } from "../registry";
import { vibrate } from "@/shared/utils/vibration";
import { useAiStore } from "@/shared/stores/aiStore";
import { useConnectionStore } from "@/shared/stores/connectionStore";
import { agentIconUrl, AGENT_ICON_CLS } from "@/features/terminal/constants/agentCli";
import { useVoiceInput, localeToSpeechLang, useVoiceLang } from "@/shared/hooks/useVoiceInput";
import VoiceLangModal from "@/shared/components/ui/VoiceLangModal";
import { useI18n } from "@/shared/i18n";
import { useInputMode } from "@/shared/hooks/useInputMode";
import { isMac } from "@/features/terminal/constants/shortcuts";
import { useAttachments } from "@/features/terminal/hooks/useAttachments";
import CommandSuggestions, { pickCommandItems } from "@/shared/components/ui/CommandSuggestions";
import { useAiHistoryStore } from "@/shared/stores/historyStore";
import CommandHistoryModal from "@/shared/components/ui/CommandHistoryModal";

const EMPTY_ARRAY = [];

export const Composer = memo(function Composer({
  sessionId = "",
  engine = "claude",
  isTurnRunning: propTurnRunning = false,
  isFocused = false,
  onSend,
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
  // Same chord the workspace shell already listens for (useGlobalShortcuts), so this is
  // only the label — the tab switch itself needs no handler here.
  const tabHint = isMac() ? "Opt ←/→ · Opt 1…9 to switch tab" : "Ctrl+Shift+←/→ · 1…9 to switch tab";
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
  // Reasoning tier beside the model: whichever name this engine publishes it under.
  const storeTier = useAiStore((s) => s.bySession[sessionId]?.metadata?.effort || s.bySession[sessionId]?.metadata?.variant);
  // Before the host answers, the engine's own defaultMode is the truth.
  const permissionMode = storeMode || engineConfig.defaultMode;

  const isTurnRunning = storeTurnRunning !== undefined ? storeTurnRunning : propTurnRunning;
  const rawModel = storeModel !== undefined ? storeModel : propModel;

  const [text, setText] = useState("");
  // Messages sent while a turn is running. A list, not a single slot: sending a second
  // one used to overwrite the first with no sign anything was lost.
  //
  // NOT persisted, deliberately: an item can carry a staged image as base64, and
  // localStorage holds a few MB in total — one photo would fill it and the write would
  // fail. Unsent text is worth keeping, but not at the cost of the draft mechanism itself.
  const [queue, setQueue] = useState(EMPTY_ARRAY);
  const [historyIdx, setHistoryIdx] = useState(-1);
  // Whatever was in the box before the first ArrowUp — ArrowDown past the newest entry
  // gives it back instead of wiping the box.
  const draftRef = useRef("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuType, setMenuType] = useState(null); // "/" or "@"
  const [menuFilter, setMenuFilter] = useState("");
  const [menuItems, setMenuItems] = useState([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  // The slash command whose second-level option list is open (e.g. /effort)
  const [submenuCmd, setSubmenuCmd] = useState(null);
  // Keyboard-highlighted row in the prompt-history dropdown (-1 = none). Tab cycles.
  const [suggestActive, setSuggestActive] = useState(-1);

  const addCommand = useAiHistoryStore((s) => s.addCommand);
  const resolveAlias = useAiHistoryStore((s) => s.resolveAlias);
  const promptHistory = useAiHistoryStore((s) => s.history);
  const pinnedPrompts = useAiHistoryStore((s) => s.pinned);
  // No commonCommands: an agent composer suggests past prompts and pinned snippets,
  // not shell commands — those only make sense inside a terminal.
  const suggestItems = useMemo(
    () => (menuOpen ? [] : pickCommandItems(text, promptHistory, pinnedPrompts, [], !hasKeyboard)),
    [text, promptHistory, pinnedPrompts, hasKeyboard, menuOpen]
  );

  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [tierMenuOpen, setTierMenuOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
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

  // Focus the box whenever this pane becomes the active one — switching tabs is how you
  // get here to type, and a running turn is exactly when a prompt gets queued. Keyed on
  // focus/modal only, never on the turn: a turn edge must not yank focus back from
  // wherever the user moved it. Never while a modal is open — that would drag focus
  // back out of the modal panel.
  useEffect(() => {
    if (isFocused && !modalOpen) textareaRef.current?.focus();
  }, [isFocused, modalOpen]);

  // Auto-close the model popover on outside click
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

  // Close model/tier popovers if a turn starts running
  useEffect(() => {
    if (isTurnRunning) {
      setModelMenuOpen(false);
      setTierMenuOpen(false);
    }
  }, [isTurnRunning]);

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

  // Load draft on session change. The queue and staged attachments are per-conversation
  // too: leaving them behind would dispatch another session's messages and files on send.
  useEffect(() => {
    if (!sessionId) return;
    setQueue(EMPTY_ARRAY);
    setAttachments([]);
    try {
      setText(localStorage.getItem(`9remote_draft_${sessionId}`) || "");
    } catch {}
  }, [sessionId, setAttachments]);

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
      const seen = new Set();
      // A skill can share a builtin's name (/simplify, /init): first one wins, no dup keys.
      const filtered = allCommands.filter((cmd) => {
        if (seen.has(cmd.name) || !cmd.name.toLowerCase().includes(filter)) return false;
        seen.add(cmd.name);
        return true;
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
  }, [text, fileBus, workspacePath, storeSkills, SLASH_COMMANDS, submenuCmd]);

  const executeSend = useCallback(() => {
    const raw = textareaRef.current ? textareaRef.current.value : text;
    // A bare snippet alias expands to its prompt before anything reads the text —
    // history, the shell branch and the host must all see the prompt, not the alias.
    const trimmed = resolveAlias((raw || text).trim());
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
    if (trimmed) {
      // Suggested prompts only, never a shell command the user ran with "!".
      if (!trimmed.startsWith("!")) addCommand(trimmed);
    }
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

    // Typing a new message over an open gate IS the answer: the user moved on. Denied
    // first, so the CLI does not sit waiting for a card this message is about to push
    // out of the way — that wait is what used to end two minutes later with the
    // watchdog killing the turn.
    const gate = useAiStore.getState().bySession[sessionId]?.activePermission;
    if (gate) onResolvePermission?.(gate.requestId, SKIP_BEHAVIOR, SKIP_MESSAGE);

    // Turn state read live, not from this render's closure — a memoized callback
    // would otherwise queue a prompt for a turn that has already ended.
    if (useAiStore.getState().bySession[sessionId]?.isTurnRunning) {
      // Attachments ride with the item: staged files belong to the message that was
      // being typed, not to whatever gets composed next.
      setQueue((q) => [...q, { id: `q-${now}`, text: trimmed, attachments: pending }]);
      setAttachments([]);
      return;
    }

    if (pending.length) setAttachments([]);
    // Send only what the host needs; the terminal's `name`/`size` fields are for its
    // own chips, and the resume path never sees them.
    onSend?.(trimmed, {
      attachments: pending.map(({ name, type, content }) => ({ filename: name, type, content }))
    });
  }, [text, sessionId, onSend, onRunShell, onResolvePermission, setAttachments, addCommand, resolveAlias, setQueue]);

  // Dispatch one item that has ALREADY been decided: it sat in the queue because a turn
  // was running, and now it is its turn to go. No `force` — this is reached from the
  // falling edge below, so the store has genuinely moved on and the running guard passes
  // on its own. Forcing it would let a prompt start before the previous turn's `stopped`
  // had been applied, and that event measures its span from the CURRENT turn's start mark:
  // the new prompt reset it a moment earlier, so the old turn summarised as "Worked for 0s".
  const dispatchQueued = useCallback((item) => {
    if (item.text.startsWith("!")) {
      onRunShell?.(item.text.slice(1).trim());
      return;
    }
    const files = (item.attachments || []).map(({ name, type, content }) => ({ filename: name, type, content }));
    onSend?.(item.text, files.length ? { attachments: files } : undefined);
  }, [onSend, onRunShell]);

  // A turn ended: take exactly ONE item off the queue. Keyed on the running→idle edge
  // only — with `queue` in the deps the effect re-ran on its own setQueue, draining the
  // whole list in a single tick while the host still refused every prompt but the first.
  const queueRef = useRef(queue);
  useEffect(() => { queueRef.current = queue; }, [queue]);
  const prevRunningRef = useRef(isTurnRunning);
  useEffect(() => {
    const ended = prevRunningRef.current && !isTurnRunning;
    prevRunningRef.current = isTurnRunning;
    if (!ended || queueRef.current.length === 0) return;
    const [next, ...rest] = queueRef.current;
    setQueue(rest);
    dispatchQueued(next);
  }, [isTurnRunning, dispatchQueued, setQueue]);

  // Stop the turn. The queue is NOT drained here: the item goes out when the host says the
  // turn ended (the falling edge above), which is also what the previous turn's `turnMs`
  // rides on. Dispatching from this handler started the next prompt before that number
  // arrived, and it was then measured against the new turn's start mark — "Worked for 0s"
  // over a turn that had run for minutes.
  const handleStopClick = useCallback(() => {
    vibrate();
    onStop?.();
  }, [onStop]);

  // Dispatch a picked slash command by its declared action. The action lives in
  // the engine registry, so this switch never needs an engine-specific branch.
  const runSlashAction = useCallback((item) => {
    const action = item.action || "send";
    const [kind, arg] = action.split(":");

    if (kind === "modal") {
      // End any in-flight composition here, not in the modal's own autoFocus target.
      textareaRef.current?.blur();
      onOpenModal?.(arg);
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
        setQueue((q) => [...q, { id: `q-${Date.now()}`, text: item.name, attachments: EMPTY_ARRAY }]);
        setText("");
        return;
      }
      onSend?.(item.name);
      setText("");
      return;
    }
    // Unknown/local action → leave the token in the box for the user to complete.
    textareaRef.current?.focus();
  }, [onOpenModal, onSend, isTurnRunning, onModeChange, setQueue]);

  const selectMenuItem = useCallback((item) => {
    vibrate();
    const lastWordMatch = /(?:^|\s)([/@][\w\d_.-]*)$/.exec(text);
    if (!lastWordMatch) return;

    const token = lastWordMatch[1];
    const prefix = text.slice(0, text.length - token.length);
    // A modal command is an action, not text: writing the token into the box first
    // would flash it and leave it behind when the modal closes. Only the token goes —
    // anything typed before it is the user's draft and stays.
    const opensModal = menuType === "/" && item.action?.startsWith("modal:");
    const replacement = menuType === "@" ? `@${item.name} ` : `${item.name} `;
    // A submenu keeps its token in the box: the effect above holds the submenu open
    // only while the text still ends in that command, so clearing it would close the
    // list the user just opened. The text is cleared when an option is picked.
    setText(opensModal ? prefix : `${prefix}${replacement}`);
    setMenuOpen(false);

    if (menuType !== "/") {
      textareaRef.current?.focus();
      return;
    }
    // A submenu command opens a second-level list instead of dispatching.
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

  // Picking a suggested prompt replaces the word being typed, it does not send it —
  // the user still gets to edit and press Enter themselves.
  const selectSuggestion = useCallback((cmd) => {
    vibrate();
    const lastWordMatch = /(?:^|\s)(\S*)$/.exec(text);
    const token = lastWordMatch ? lastWordMatch[1] : "";
    setText(text.slice(0, text.length - token.length) + cmd);
    setSuggestActive(-1);
    textareaRef.current?.focus();
  }, [text]);

  const handleKeyDown = (e) => {
    // A modal above owns the keyboard: the composer keeps focus underneath, so an
    // unguarded Escape would stop the turn and Enter would send a prompt.
    if (modalOpen) return;
    // Mid-composition keys belong to the IME. On a phone Enter is also the key that
    // commits the word being typed, so acting on it opens a modal with the composition
    // still open — and the word lands in whatever the modal focuses (its search box).
    if (e.nativeEvent?.isComposing || e.keyCode === 229) return;

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
      if (queue.length > 0) {
        e.preventDefault();
        setQueue(EMPTY_ARRAY);
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

    // Prompt-history suggestions: Tab cycles, Enter replaces the trailing word with
    // the picked prompt. Sits after the slash/at menu so those keep priority.
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

    // History traversal, newest-first (index 0 is the most recent prompt). Arrow keys
    // only reach history from the box's edge — inside a multi-line draft they still
    // move the caret, which is what every shell does.
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

    // Enter sends on a physical keyboard; on touch it inserts a newline, because a
    // phone's Enter key is how you start the next line and there is a Send button
    // right there. Cmd/Ctrl+Enter is the shortcut that sends either way.
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

  // The raw id is what the CLI reports and what `--model` must receive — `[1m]` picks
  // the 1M-context variant, so it is never stripped from the value that goes back.
  // Matching is looser than equality on purpose: the host catalog lists bare slugs
  // (`gpt-5.6-luna`) while the config may run a gateway id for the same model
  // (`cx/gpt-5.6-luna`), and an exact compare left the tier picker with nothing to show.
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

  // `short` is the real id for host slot models; the alias label is the no-custom fallback.
  const displayModel = matchedModel?.short || matchedModel?.label || rawModel || "Model";

  // The reasoning tier the CLI is actually running with. Engines name this field
  // differently (claude/codex say effort, opencode says variant) and some have none at
  // all (antigravity folds the tier into the model id) — so the chip is simply absent
  // when there is nothing to say, never a placeholder.
  const displayTier = storeTier || engineConfig.defaultEffort || "";

  // The running model may not be in the host's list (set from another surface, or a
  // settings change since) — show it anyway rather than pretending another is active.
  const allModels = useMemo(() => {
    const list = [...(MODELS || [])];
    if (rawModel && !list.some((m) => m.id === rawModel)) {
      list.unshift({ id: rawModel, label: rawModel, short: rawModel });
    }
    return list;
  }, [MODELS, rawModel]);

  // The tiers beside the model, picked in their own popover. The engine's submenu names
  // the option key to send them under (claude/codex say effort, opencode says variant)
  // and carries a fallback ladder. The running model's OWN tiers win when the host
  // catalog has them: they differ per model (luna takes `max`, 5.5 stops at `xhigh`),
  // and offering a level the model rejects fails the next turn.
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

      {/* Queued messages. Each one goes on its own when the turn that is running ends;
          Send promotes it to the head instead of waiting its turn. */}
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
                <button
                  type="button"
                  onClick={() => {
                    vibrate();
                    // The head is already next, so "send" there means now: stop the turn
                    // and hand it over. Deeper items just move up.
                    if (idx === 0) { handleStopClick(); return; }
                    setQueue((q) => [item, ...q.filter((x) => x.id !== item.id)]);
                  }}
                  className="text-text-muted hover:text-brand-400 p-1 rounded hover:bg-surface-2 transition-colors cursor-pointer"
                  title={idx === 0 ? "Send now (stops the current turn)" : "Send this one next"}
                >
                  <Send size={13} />
                </button>
                <button
                  type="button"
                  onClick={() => { vibrate(); setQueue((q) => q.filter((x) => x.id !== item.id)); }}
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
      <div className="relative rounded-brand border border-border-subtle/80 bg-transparent focus-within:border-brand-500 transition-colors px-2.5 py-1 flex flex-col gap-1">
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

        <CommandSuggestions
          value={text}
          store={useAiHistoryStore}
          isMobile={!hasKeyboard}
          activeIndex={suggestActive}
          onSelect={selectSuggestion}
        />

        {/* Textarea and clear button share a row: absolute-positioning the X on top of
            the text meant a long first line ran underneath it. */}
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

          {/* Wipe the draft without sending it, and only while there is one — an empty
              box shows the history door in this slot instead. */}
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
            {/* Model Selector Dropdown */}
            <div ref={modelMenuRef} className="relative min-w-0 flex items-center gap-1">
              <button
                type="button"
                disabled={isTurnRunning}
                onClick={() => { setModelMenuOpen((v) => !v); setTierMenuOpen(false); }}
                className="min-w-0 px-1.5 py-0.5 rounded text-[11px] font-medium flex items-center gap-1 font-mono text-text-muted hover:text-text hover:bg-surface-2 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                title={isTurnRunning ? "Cannot change model while turn is running" : "Select model (/model)"}
              >
                <img src={agentIconUrl(`${engine}-ui`)} alt="" className={`w-3.5 h-3.5 object-contain shrink-0 ${AGENT_ICON_CLS}`} />
                {/* dir=rtl keeps the tail visible when the id is too long, so the
                    version suffix (the part that distinguishes models) survives. */}
                <span dir="rtl" className="truncate min-w-0"><bdi>{displayModel}</bdi></span>
                <ChevronUp size={11} className={`text-text-muted shrink-0 transition-transform ${modelMenuOpen ? "" : "rotate-180"}`} />
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

              {/* Reasoning tier — its own button, so picking a level no longer costs a
                  trip through the model list. No background: it is a word, not a badge. */}
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
            {/* Attach a file or image — the host stages it where the CLI can read it */}
            <label
              className="p-1.5 rounded text-text-muted hover:text-text hover:bg-surface-2 transition-colors cursor-pointer flex items-center justify-center"
              title="Attach file or image"
            >
              <Paperclip size={15} />
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

      {/* Prompt history — the same modal the terminal uses, on the AI store so it
          lists prompts and pinned snippets rather than shell commands. */}
      <CommandHistoryModal
        isOpen={historyOpen}
        store={useAiHistoryStore}
        onSelect={selectSuggestion}
        onClose={() => setHistoryOpen(false)}
      />

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
