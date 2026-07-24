import { useState, useEffect, useRef, useMemo } from "preact/hooks";
import Icon from "./Icon";
import { useI18n } from "../i18n";
import { statusVisual } from "../lib/statusVisual";
import TerminalPane from "./TerminalPane";
import NotificationsBell from "./NotificationsBell";
import SettingsMenu from "./SettingsMenu";
import FileExplorer from "./FileExplorer";
import GitPanel from "./GitPanel";
import FileWorkspaceDesktop from "./FileWorkspaceDesktop";
import CommandSuggestions, { pickCommandItems } from "./CommandSuggestions";
import PathSuggestion from "./PathSuggestion";
import CommandHistoryModal from "./CommandHistoryModal";
import { useFileSocket } from "../lib/fileExplorer/useFileSocket";
import { ACTIVITY_PANELS } from "../lib/fileExplorer/constants";
import { loadHistory, addHistory, removeHistory, clearHistory } from "../lib/history";
import { parsePathInput, pickMatches, makeDirCache } from "../lib/pathSuggest";
import {
  DESKTOP_BREAKPOINT, PANE_MIN_WIDTH, COMMON_COMMANDS, PATH_SUGGEST, INPUT_CONTROL_KEYS,
  MAX_ATTACHMENT_SIZE, MAX_ATTACHMENTS, CLIPBOARD_ATTACH_TIMEOUT, CLIPBOARD_ATTACH_GAP
} from "../lib/constants";

const UNGROUPED = { id: null, name: "Ungrouped" };

// Full-screen terminal overlay — mirrors web workspace (split panes + tabs + group selector)
export default function TerminalView({ socket, sessions, groups = [], openedIds, activeId, connected, theme = "dark", terminalFont, terminalThemeKey = "default", showFolderButton = true, showGitButton = true, showNoteButton = true, webglEnabled, onSetWebgl, onSetShowFolder, onSetShowGit, onSetShowNote, onSetTerminalFont, onSetTerminalTheme, onStop, onShutdown, finishedIds, sessionStatus = {}, clearFinished, updateCwd, onSwitch, onCreate, onCreateNamed, onRename, onDelete, onSelectGroup, onBack }) {
  const { t } = useI18n();
  const [isDesktop, setIsDesktop] = useState(typeof window !== "undefined" ? window.innerWidth >= DESKTOP_BREAKPOINT : false);
  const [showGroupMenu, setShowGroupMenu] = useState(false);
  const [textInput, setTextInput] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [history, setHistory] = useState(() => loadHistory());
  const [showHistory, setShowHistory] = useState(false);
  const attachIdRef = useRef(0);
  const [tabMenu, setTabMenu] = useState({ sessionId: null, x: 0, y: 0 });
  const tabMenuRef = useRef(null);
  const [editingTabId, setEditingTabId] = useState(null);
  const [editTabName, setEditTabName] = useState("");
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [newTerminalName, setNewTerminalName] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  // Overlay: files | git panel — opened from TerminalPane header buttons
  const [overlay, setOverlay] = useState(null);
  const fileSocket = useFileSocket();
  const groupMenuRef = useRef(null);
  const tabsRef = useRef(null);
  const activeTabRef = useRef(null);
  const createInputRef = useRef(null);
  const tabInputRef = useRef(null);
  const textInputRef = useRef(null);
  // Physical ArrowUp/Down navigate command history; -1 = editing live draft.
  const historyIndexRef = useRef(-1);
  const draftRef = useRef("");
  const paneEls = useRef({});

  // Active session object (input bar target) — undefined when no active pane
  const activeSession = sessions.find((s) => s.id === activeId);

  // Path-aware suggestions (mirrors web MobileKeyboard logic)
  const [pathItems, setPathItems] = useState([]);
  const dirCacheRef = useRef(makeDirCache());
  const lastSuggestRef = useRef(0);
  // Keyboard-highlighted row in each suggest dropdown (-1 = none). Tab cycles, Enter accepts.
  const [pathActive, setPathActive] = useState(-1);
  const [cmdActive, setCmdActive] = useState(-1);
  // Ranked command list (same as CommandSuggestions renders), lifted here so Tab can cycle it.
  // Empty while path-suggest is open so the two dropdowns never compete for the same Tab.
  const cmdItems = useMemo(
    () => (pathItems.length > 0 ? [] : pickCommandItems(textInput, history, COMMON_COMMANDS)),
    [textInput, history, pathItems]
  );
  // Clamp highlight into range as the list shrinks (-1 stays -1, else modular-wrap).
  const wrap = (i, len) => (i < 0 || !len ? -1 : ((i % len) + len) % len);
  const pathActiveClamped = wrap(pathActive, pathItems.length);
  const cmdActiveClamped = wrap(cmdActive, cmdItems.length);

  useEffect(() => {
    const cwd = activeSession?.cwd;
    const parsed = cwd != null ? parsePathInput(textInput, cwd) : null;
    if (!parsed) { setPathItems([]); return; }
    const token = ++lastSuggestRef.current;
    const timer = setTimeout(async () => {
      const now = Date.now();
      let entries = dirCacheRef.current.get(parsed.dir, now);
      if (entries == null) {
        const res = await fileSocket.getFiles(parsed.dir, false);
        if (lastSuggestRef.current !== token) return;
        if (!res?.success) { setPathItems([]); return; }
        entries = res.files;
        dirCacheRef.current.set(parsed.dir, entries, now);
      }
      setPathItems(pickMatches(entries, parsed.prefix, parsed));
    }, PATH_SUGGEST.debounceMs);
    return () => clearTimeout(timer);
  }, [textInput, activeSession?.cwd, activeSession?.id]);

  // Clear cache + items on session switch
  useEffect(() => {
    dirCacheRef.current.clear();
    setPathItems([]);
    setPathActive(-1);
    setCmdActive(-1);
  }, [activeSession?.id]);

  // Read a File → base64 attachment entry, skipping oversized ones.
  const fileToAttachment = (file) => new Promise((resolve) => {
    if (file.size > MAX_ATTACHMENT_SIZE) return resolve(null);
    const reader = new FileReader();
    reader.onload = () => {
      const content = reader.result.split(",")[1];
      const isImage = file.type.startsWith("image/");
      const name = file.name || `paste_${attachIdRef.current}.${isImage ? (file.type.split("/")[1] || "png") : "bin"}`;
      resolve({ id: ++attachIdRef.current, name, type: file.type, size: file.size, content, isImage });
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });

  const addFiles = async (files) => {
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) return;
    const entries = (await Promise.all(Array.from(files).slice(0, room).map(fileToAttachment))).filter(Boolean);
    if (entries.length) setAttachments((prev) => [...prev, ...entries]);
  };

  const removeAttachment = (id) => setAttachments((prev) => prev.filter((a) => a.id !== id));

  // Push one attachment into the host clipboard + Ctrl+V (image) or type path (file),
  // waiting for ack so the CLI consumes each before the next overwrites the clipboard.
  const sendOneAttachment = (att) => new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    socket.emit("clipboard-attach", { sessionId: activeSession.id, filename: att.name, type: att.type, content: att.content }, finish);
    setTimeout(finish, CLIPBOARD_ATTACH_TIMEOUT);
  });

  // Attachments first (serially), then text + Enter — mirrors web send flow.
  const sendText = async () => {
    if (!socket || !activeSession) return;
    clearFinished?.(activeSession.id);

    const pending = attachments;
    if (pending.length) setAttachments([]);
    for (const att of pending) {
      await sendOneAttachment(att);
      await new Promise((r) => setTimeout(r, CLIPBOARD_ATTACH_GAP));
    }

    const text = textInput;
    if (text === "") {
      if (!pending.length) socket.emit("input", { sessionId: activeSession.id, data: "\r" });
    } else {
      // Send text first, then Enter after a short delay so PTY reliably receives both.
      socket.emit("input", { sessionId: activeSession.id, data: text });
      setTimeout(() => socket.emit("input", { sessionId: activeSession.id, data: "\r" }), 40);
      setHistory(addHistory(text));
      setTextInput("");
      historyIndexRef.current = -1;
    }
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

  // Control keys (Esc, Ctrl+C/D/Z/L) from the input → straight to terminal.
  const handleControlKey = (e) => {
    const cfg = INPUT_CONTROL_KEYS[e.key];
    if (!cfg || (cfg.ctrl && !e.ctrlKey) || e.metaKey || e.altKey) return false;
    const el = e.target;
    if (cfg.requireNoSelection && el.selectionStart !== el.selectionEnd) return false;
    e.preventDefault();
    if (socket && activeSession) {
      clearFinished?.(activeSession.id);
      socket.emit("input", { sessionId: activeSession.id, data: cfg.data });
    }
    return true;
  };

  // Close tab context menu on outside click / Escape
  useEffect(() => {
    if (!tabMenu.sessionId) return;
    const onDoc = (e) => { if (tabMenuRef.current && !tabMenuRef.current.contains(e.target)) setTabMenu({ sessionId: null, x: 0, y: 0 }); };
    const onKey = (e) => { if (e.key === "Escape") setTabMenu({ sessionId: null, x: 0, y: 0 }); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("touchstart", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("touchstart", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [tabMenu.sessionId]);

  const handleTabContextMenu = (e, session) => {
    e.preventDefault();
    setTabMenu({ sessionId: session.id, x: e.clientX, y: e.clientY });
  };

  const startTabRename = (session) => {
    setEditingTabId(session.id);
    setEditTabName(session.name || "");
    setTabMenu({ sessionId: null, x: 0, y: 0 });
  };

  const saveTabRename = (sessionId) => {
    if (editTabName.trim()) onRename?.(sessionId, editTabName.trim());
    setEditingTabId(null);
    setEditTabName("");
  };

  const handleCreateSubmit = () => {
    const name = newTerminalName.trim() || null;
    setCreateModalOpen(false);
    setNewTerminalName("");
    if (onCreateNamed) onCreateNamed(activeGroupId, name);
    else onCreate?.(activeGroupId);
  };

  const suggestTerminalName = (groupId) => {
    const count = sessions.filter((s) => (s.groupId || null) === groupId).length;
    return `Term ${count + 1}`;
  };

  useEffect(() => {
    let t = 0;
    const check = () => { clearTimeout(t); t = setTimeout(() => setIsDesktop(window.innerWidth >= DESKTOP_BREAKPOINT), 50); };
    window.addEventListener("resize", check);
    return () => { clearTimeout(t); window.removeEventListener("resize", check); };
  }, []);

  // Close group menu on outside click
  useEffect(() => {
    if (!showGroupMenu) return;
    const onDoc = (e) => { if (groupMenuRef.current && !groupMenuRef.current.contains(e.target)) setShowGroupMenu(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [showGroupMenu]);

  // Auto-scroll active tab into center when switching (web parity)
  useEffect(() => {
    if (activeTabRef.current && tabsRef.current) {
      activeTabRef.current.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    }
  }, [activeId]);

  // Desktop split: scroll the focused pane into center of viewport (web parity)
  useEffect(() => {
    if (!isDesktop) return;
    const el = paneEls.current[activeId];
    if (!el) return;
    const id = requestAnimationFrame(() => el.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" }));
    return () => cancelAnimationFrame(id);
  }, [activeId, isDesktop, openedIds]);

  // Reliable focus+select for create modal / tab rename (autoFocus is flaky on conditional mount)
  useEffect(() => { if (createModalOpen) requestAnimationFrame(() => { createInputRef.current?.focus(); createInputRef.current?.select(); }); }, [createModalOpen]);
  useEffect(() => { if (editingTabId) requestAnimationFrame(() => { tabInputRef.current?.focus(); tabInputRef.current?.select(); }); }, [editingTabId]);

  const active = sessions.find((s) => s.id === activeId);
  const activeGroupId = active?.groupId || null;
  const groupSessions = sessions.filter((s) => (s.groupId || null) === activeGroupId);
  const openedGroup = groupSessions.filter((s) => openedIds.includes(s.id));
  const multi = openedGroup.length > 1;

  // Ctrl+←/→ prev/next tab (wrap), Ctrl+1..9 jump tab N (9 = last if longer)
  useEffect(() => {
    const onKey = (e) => {
      // Shortcuts active only while the text input is focused
      if (document.activeElement !== textInputRef.current) return;
      if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      const list = groupSessions;
      if (list.length < 2) return;
      const idx = list.findIndex((s) => s.id === activeId);
      let target;
      if (e.key === "ArrowRight") target = list[(idx + 1) % list.length];
      else if (e.key === "ArrowLeft") target = list[(idx - 1 + list.length) % list.length];
      else if (e.key >= "1" && e.key <= "9") target = list[Math.min(+e.key - 1, list.length - 1)];
      else return;
      e.preventDefault();
      if (target && target.id !== activeId) onSwitch?.(target.id);
      // Double rAF keeps focus on input, beating pane term.focus()
      requestAnimationFrame(() => requestAnimationFrame(() => textInputRef.current?.focus()));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [groupSessions, activeId, onSwitch]);

  const hasUngrouped = sessions.some((s) => !s.groupId);
  const groupOptions = [...groups, ...(hasUngrouped ? [UNGROUPED] : [])];
  const activeGroupName = groups.find((g) => g.id === activeGroupId)?.name || UNGROUPED.name;
  const showGroupSelector = groupOptions.length > 1;
  // A group is "finished" if any of its sessions has an unseen finished badge — surfaces cross-group dots
  const groupHasFinished = (gid) => sessions.some((s) => (s.groupId || null) === gid && finishedIds?.has(s.id));

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: "var(--bg-body)" }}>
      {/* Header — back + group selector + tabs + new (web TerminalHeader parity) */}
      <div className="px-2 sm:px-4 pt-2 pb-1 flex items-center gap-2 flex-shrink-0 relative z-20">
        <button
        onClick={onBack}
        title={t("terminal.backToSessions")}
          className="p-1.5 rounded-lg transition-all duration-150 ease-out active:scale-[0.94] flex-shrink-0 term-btn"
          style={{ background: "var(--surface-2)", color: "var(--text-main)" }}
        >
          <Icon name="chevronLeft" size={18} />
        </button>

        {/* Group selector — shown when >1 group option */}
        {showGroupSelector && (
          <div ref={groupMenuRef} className="relative flex-shrink-0">
            <button
              onClick={() => setShowGroupMenu((v) => !v)}
              className="px-2 py-1.5 rounded-lg transition-all duration-150 ease-out flex items-center gap-1 max-w-[160px] term-btn"
              style={{ background: "var(--surface-2)", color: "var(--text-main)" }}
              title={t("terminal.switchGroup")}
            >
              <span className="truncate text-sm font-medium">{activeGroupName}</span>
              {/* Dot when a NON-active group has a finished session, so user knows to switch */}
              {groupOptions.some((g) => g.id !== activeGroupId && groupHasFinished(g.id)) && (
                <span className="w-1.5 h-1.5 rounded-full term-tab-done-dot" style={{ background: "#f59e0b" }} />
              )}
              <Icon name="chevronDown" size={14} />
            </button>
            {showGroupMenu && (
              <div className="absolute left-0 top-full mt-1 z-30 rounded-lg shadow-lg py-1 min-w-[160px]" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
                {groupOptions.map((g) => (
                  <button
                    key={g.id || "ungrouped"}
                    onClick={() => { onSelectGroup?.(g.id); setShowGroupMenu(false); }}
                    className="w-full text-left px-3 py-1.5 text-sm transition term-group-item flex items-center justify-between gap-2"
                    style={{ color: g.id === activeGroupId ? "var(--brand-500)" : "var(--text-main)" }}
                  >
                    <span className="truncate">{g.name}</span>
                    {groupHasFinished(g.id) && <span className="w-1.5 h-1.5 rounded-full term-tab-done-dot flex-shrink-0" style={{ background: "#f59e0b" }} />}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Tabs */}
        <div ref={tabsRef} className="flex-1 overflow-x-auto overflow-y-hidden">
          <div className="flex gap-0.5 min-w-max items-center">
            {groupSessions.map((s) => {
              const isActive = s.id === activeId;
              const v = statusVisual(sessionStatus[s.id]?.state || "idle");
              return (
                <button
                  key={s.id}
                  ref={isActive ? activeTabRef : null}
                  onClick={() => onSwitch?.(s.id)}
                  onContextMenu={(e) => handleTabContextMenu(e, s)}
                  className={`px-2 sm:px-3 py-1.5 text-sm font-medium transition-all duration-150 ease-out flex items-center gap-1.5 sm:gap-2 whitespace-nowrap term-tab${isActive ? " term-tab-active" : ""}`}
                  style={{ color: isActive ? "var(--brand-500)" : "var(--text-muted)" }}
                >
                  <span className={`w-1.5 h-1.5 rounded-full term-dot${v.pulse ? ` pulse-${v.pulse}` : ""}`} style={{ background: v.dot }} title={t(v.label)} />
                  {editingTabId === s.id ? (
                    <input
                      type="text"
                      ref={tabInputRef}
                      value={editTabName}
                      onClick={(e) => e.stopPropagation()}
                      onInput={(e) => setEditTabName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveTabRename(s.id);
                        if (e.key === "Escape") { setEditingTabId(null); setEditTabName(""); }
                      }}
                      onBlur={() => saveTabRename(s.id)}
                      className="bg-transparent border-b outline-none max-w-[120px]"
                      style={{ borderColor: "var(--brand-500)", color: "var(--text-main)" }}
                    />
                  ) : (
                    <span className="truncate max-w-[120px]">{s.name || s.id}</span>
                  )}
                </button>
              );
            })}
            <button
              onClick={() => connected && (setNewTerminalName(suggestTerminalName(activeGroupId)), setCreateModalOpen(true))}
              disabled={!connected}
              title={t("terminal.newTerminal")}
              className="p-1.5 ml-1 rounded-lg transition-all duration-150 ease-out active:scale-[0.94] flex-shrink-0 term-btn"
              style={{ background: "var(--surface-2)", color: "var(--text-muted)", opacity: connected ? 1 : 0.4, cursor: connected ? "pointer" : "not-allowed" }}
            >
              <Icon name="plus" size={18} />
            </button>
          </div>
        </div>

        <NotificationsBell
          sessions={sessions}
          allSessions={sessions}
          sessionStatus={sessionStatus}
          groups={groups}
          onSwitchSession={onSwitch}
        />
        <SettingsMenu
          theme={theme}
          terminalFont={terminalFont}
          setTerminalFont={onSetTerminalFont}
          terminalThemeKey={terminalThemeKey}
          setTerminalTheme={onSetTerminalTheme}
          webglEnabled={webglEnabled}
          setWebglEnabled={onSetWebgl}
          showFolderButton={showFolderButton}
          setShowFolderButton={onSetShowFolder}
          showGitButton={showGitButton}
          setShowGitButton={onSetShowGit}
          showNoteButton={showNoteButton}
          setShowNoteButton={onSetShowNote}
          isStopped={!connected}
          onStop={onStop}
          onShutdown={onShutdown}
          variant="compact"
        />
      </div>

      {/* Panes: desktop = horizontal split, mobile = active pane only */}
      <div className={`flex-1 min-h-0 relative z-10 ${isDesktop ? "flex flex-row gap-3 overflow-x-auto overflow-y-hidden p-2" : "relative p-2"}`}>
        {openedGroup.map((s) => {
          const isFocused = s.id === activeId;
          // Desktop: rounded pane with focus border on wrapper (web workspace parity).
          // Mobile: stacked, focused pane visible only.
          // Non-focused + non-idle status → dashed border in state color (replaces muted border).
          const st = sessionStatus[s.id]?.state || "idle";
          const statusBorder = !isFocused && st !== "idle";
          const desktopClass = isFocused
            ? "flex-1 h-full rounded-xl overflow-hidden border-2 p-0"
            : `flex-1 h-full rounded-xl overflow-hidden border p-px${statusBorder ? " border-dashed" : ""}`;
          const desktopStyle = {
            minWidth: `${PANE_MIN_WIDTH}px`,
            borderColor: isFocused
              ? "var(--brand-500)"
              : statusBorder ? statusVisual(st).dot : "color-mix(in srgb, var(--text-muted) 25%, transparent)",
          };
          return (
            <div
              key={s.id}
              ref={(el) => { if (el) paneEls.current[s.id] = el; else delete paneEls.current[s.id]; }}
              className={isDesktop
                ? desktopClass
                : `absolute inset-0 ${isFocused ? "opacity-100 z-10" : "opacity-0 z-0 pointer-events-none"}`}
              style={isDesktop ? desktopStyle : undefined}
            >
              <TerminalPane
                socket={socket}
                sessionId={s.id}
                theme={theme}
                terminalFont={terminalFont}
                terminalThemeKey={terminalThemeKey}
                showFolderButton={showFolderButton}
                showGitButton={showGitButton}
                showNoteButton={showNoteButton}
                isFocused={isFocused}
                cwd={s.cwd}
                onActivate={onSwitch}
                onInput={clearFinished}
                onCwd={(cwd) => updateCwd?.(s.id, cwd)}
                onOpenFiles={(cwd) => setOverlay({ type: "files", cwd })}
                onOpenGit={(cwd) => setOverlay({ type: "git", cwd })}
                showFocusBorder={false}
                showDoneBorder={finishedIds?.has(s.id)}
              />
            </div>
          );
        })}
      </div>

      {/* Text input bar — web MobileKeyboard parity (send raw text or lone Enter).
          Temporarily hidden: incomplete vs web; xterm direct input suffices for now. */}
      {false && activeSession && (
        <div className="flex items-end gap-2 px-2 py-1.5 flex-shrink-0 relative z-10" style={{ background: "var(--surface)", borderTop: "1px solid var(--border)" }}>
          <div className="relative flex-1 rounded-lg" style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
            {pathItems.length > 0 ? (
              <PathSuggestion
                items={pathItems}
                activeIndex={pathActiveClamped}
                onSelect={(cmd) => { setTextInput(cmd); setPathActive(-1); textInputRef.current?.focus(); }}
              />
            ) : (
              <CommandSuggestions
                value={textInput}
                history={history}
                commonCommands={COMMON_COMMANDS}
                activeIndex={cmdActiveClamped}
                onSelect={(cmd) => { setTextInput(cmd); setCmdActive(-1); textInputRef.current?.focus(); }}
              />
            )}
            {attachments.length > 0 && (
              <div className="flex gap-2 px-2 pt-2 overflow-x-auto">
                {attachments.map((att) => (
                  <div key={att.id} className="relative flex-shrink-0">
                    {att.isImage ? (
                      <img src={`data:${att.type};base64,${att.content}`} alt={att.name}
                        className="w-10 h-10 object-cover rounded" style={{ border: "1px solid var(--border)" }} />
                    ) : (
                      <div className="w-10 h-10 flex flex-col items-center justify-center rounded px-1"
                        style={{ border: "1px solid var(--border)", background: "var(--surface)" }}>
                        <Icon name="paperclip" size={12} />
                        <span className="text-[8px] truncate w-full text-center" style={{ color: "var(--text-muted)" }}>{att.name}</span>
                      </div>
                    )}
                    <button
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => removeAttachment(att.id)}
                      className="absolute -top-1.5 -right-1.5 w-4 h-4 flex items-center justify-center rounded-full"
                      style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text-muted)" }}
                    >
                      <Icon name="x" size={9} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <label className="absolute left-1.5 bottom-1.5 w-6 h-6 flex items-center justify-center cursor-pointer" style={{ color: "var(--text-muted)" }}>
              <Icon name="paperclip" size={15} />
              <input type="file" multiple className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
            </label>
            <textarea
              ref={textInputRef}
              value={textInput}
              rows={Math.min(2, (textInput.match(/\n/g) || []).length + 1)}
              onInput={(e) => {
                setTextInput(e.target.value);
                historyIndexRef.current = -1;
              }}
              onFocus={(e) => {
                const len = e.target.value.length;
                e.target.selectionStart = e.target.selectionEnd = len;
              }}
              onPaste={handleAttachPaste}
              onKeyDown={(e) => {
                // Physical ArrowUp/Down (no modifier) navigate history only at caret boundaries (multi-line aware).
                if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
                  const el = e.target;
                  const firstNL = el.value.indexOf("\n");
                  const atFirstLine = el.selectionStart <= (firstNL === -1 ? el.value.length : firstNL);
                  const lastNL = el.value.lastIndexOf("\n");
                  const atLastLine = el.selectionEnd >= (lastNL === -1 ? 0 : lastNL + 1);
                  if (e.key === "ArrowUp" && !atFirstLine) return;
                  if (e.key === "ArrowDown" && !atLastLine) return;
                  if (!history.length) return;
                  e.preventDefault();
                  if (historyIndexRef.current === -1) draftRef.current = e.target.value;
                  let next = historyIndexRef.current + (e.key === "ArrowUp" ? 1 : -1);
                  if (next >= history.length) next = history.length - 1;
                  if (next < -1) next = -1;
                  historyIndexRef.current = next;
                  setTextInput(next === -1 ? draftRef.current : history[next]);
                  requestAnimationFrame(() => {
                    const el = textInputRef.current;
                    if (el) { el.selectionStart = el.selectionEnd = el.value.length; }
                  });
                  return;
                }
                // Tab cycles the active suggestion (path or command); bare Tab with none open falls through.
                if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
                  if (pathItems.length > 0) {
                    e.preventDefault();
                    setPathActive((i) => wrap(i + 1, pathItems.length));
                    return;
                  }
                  if (cmdItems.length > 0) {
                    e.preventDefault();
                    setCmdActive((i) => wrap(i + 1, cmdItems.length));
                    return;
                  }
                }
                // Enter: accept a keyboard-highlighted suggestion, else send.
                if (e.key === "Enter" && !e.shiftKey) {
                  if (pathItems.length > 0 && pathActiveClamped >= 0) {
                    e.preventDefault();
                    setTextInput(pathItems[pathActiveClamped].full);
                    setPathActive(-1);
                    return;
                  }
                  if (cmdItems.length > 0 && cmdActiveClamped >= 0) {
                    e.preventDefault();
                    setTextInput(cmdItems[cmdActiveClamped].cmd);
                    setCmdActive(-1);
                    return;
                  }
                  e.preventDefault();
                  sendText();
                  return;
                }
                handleControlKey(e);
              }}
              placeholder={t("terminal.typeCommand")}
              className="term-input block w-full pl-9 pr-8 py-1.5 rounded-lg text-sm resize-none focus:outline-none leading-5"
              style={{ background: "transparent", color: "var(--text-main)" }}
            />
            {textInput ? (
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { setTextInput(""); textInputRef.current?.focus(); }}
                title={t("terminal.clearInput")}
                className="absolute right-1.5 bottom-1.5 w-5 h-5 flex items-center justify-center"
                style={{ color: "var(--text-muted)" }}
              >
                <Icon name="x" size={14} />
              </button>
            ) : (
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setShowHistory(true)}
                title={t("history.title")}
                className="absolute right-1.5 bottom-1.5 w-5 h-5 flex items-center justify-center"
                style={{ color: "var(--text-muted)" }}
              >
                <Icon name="history" size={14} />
              </button>
            )}
          </div>
          <button
            onClick={sendText}
            className="btn-primary px-4 py-1.5 text-sm font-semibold flex-shrink-0 min-w-[72px] flex items-center justify-center"
          >
            {textInput.trim() || attachments.length ? t("terminal.send") : <Icon name="cornerDownLeft" size={16} strokeWidth={2.5} />}
          </button>
        </div>
      )}

      {/* Tab right-click context menu */}
      {tabMenu.sessionId && (
        <div
          ref={tabMenuRef}
          className="fixed z-[60] py-1 min-w-[140px]"
          style={{
            left: tabMenu.x, top: tabMenu.y,
            background: "var(--surface-2)", border: "1px solid var(--border)",
            borderRadius: "var(--radius-brand)", boxShadow: "var(--header-shadow, 0 2px 12px rgba(0,0,0,0.3))",
          }}
        >
          <button
            onClick={() => startTabRename(sessions.find((s) => s.id === tabMenu.sessionId))}
            className="w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 card-act"
            style={{ color: "var(--text-main)" }}
          >
            <Icon name="pencil" size={14} /> {t("common.rename")}
          </button>
          <button
            onClick={() => {
              const s = sessions.find((x) => x.id === tabMenu.sessionId);
              setDeleteConfirm({ id: s?.id, name: s?.name || s?.id });
              setTabMenu({ sessionId: null, x: 0, y: 0 });
            }}
            className="w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 card-del"
            style={{ color: "var(--text-main)" }}
          >
            <Icon name="trash" size={14} /> {t("common.delete")}
          </button>
        </div>
      )}

      {/* New terminal modal */}
      {createModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.6)" }}
          onClick={() => setCreateModalOpen(false)}
        >
          <div className="glass-card p-5 w-80" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm font-semibold mb-3" style={{ color: "var(--text-main)" }}>New Terminal</p>
            <div className="relative mb-4">
              <input
                type="text"
                ref={createInputRef}
                value={newTerminalName}
                placeholder={suggestTerminalName(activeGroupId)}
                onInput={(e) => setNewTerminalName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreateSubmit();
                  if (e.key === "Escape") setCreateModalOpen(false);
                }}
                className="w-full px-3 py-2 pr-8 rounded-lg text-sm focus:outline-none"
                style={{ background: "var(--surface-2)", color: "var(--text-main)", border: "1px solid var(--border)" }}
              />
              {newTerminalName && (
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setNewTerminalName("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded-full"
                  style={{ color: "var(--text-muted)" }}
                >
                  <Icon name="plus" size={14} className="rotate-45" />
                </button>
              )}
            </div>
            <div className="flex gap-2">
              <button onClick={handleCreateSubmit} className="btn-primary flex-1 py-2 text-sm font-semibold">
                {t("common.create")}
              </button>
              <button
                onClick={() => { setNewTerminalName(""); setCreateModalOpen(false); }}
                className="glass-btn flex-1 py-2 text-sm"
                style={{ color: "var(--text-muted)" }}
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm */}
      {deleteConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.6)" }}
          onClick={() => setDeleteConfirm(null)}
        >
          <div className="glass-card p-5 w-80" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm mb-4" style={{ color: "var(--text-main)" }}>
              {t("terminal.deleteConfirm", { name: deleteConfirm.name })}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  if (deleteConfirm?.id) onDelete?.(deleteConfirm.id);
                  setDeleteConfirm(null);
                }}
                className="flex-1 py-2 text-sm font-semibold text-white rounded-lg"
                style={{ background: "#ef4444" }}
              >
                {t("common.delete")}
              </button>
              <button
                onClick={() => setDeleteConfirm(null)}
                className="glass-btn flex-1 py-2 text-sm"
                style={{ color: "var(--text-muted)" }}
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      {showHistory && (
        <CommandHistoryModal
          history={history}
          onSelect={(cmd) => { setTextInput(cmd); textInputRef.current?.focus(); }}
          onRemove={(cmd) => setHistory(removeHistory(cmd))}
          onClear={() => setHistory(clearHistory())}
          onClose={() => setShowHistory(false)}
        />
      )}

      {/* Full-screen file/git overlay (opened from TerminalPane header) */}
      {overlay && (
        <div className="absolute inset-0 z-[80]" style={{ background: "var(--bg-body)" }}>
          {isDesktop && (overlay.type === "files" || overlay.type === "git") ? (
            <FileWorkspaceDesktop
              workspace={overlay.cwd}
              fileSocket={fileSocket}
              socket={socket}
              connected={connected}
              sessions={sessions}
              onCreateTerminalSession={onCreate}
              onDeleteTerminalSession={onDelete}
              onRenameTerminalSession={onRename}
              initialPanel={overlay.type === "git" ? ACTIVITY_PANELS.scm : undefined}
              onBack={() => setOverlay(null)}
            />
          ) : overlay.type === "files" ? (
            <FileExplorer
              workspace={overlay.cwd}
              initialPath={overlay.cwd}
              fileSocket={fileSocket}
              onBack={() => setOverlay(null)}
              onOpenGit={() => setOverlay({ type: "git", cwd: overlay.cwd })}
            />
          ) : (
            <GitPanel
              workspace={overlay.cwd}
              fileSocket={fileSocket}
              onBack={() => setOverlay(null)}
            />
          )}
        </div>
      )}
    </div>
  );
}
