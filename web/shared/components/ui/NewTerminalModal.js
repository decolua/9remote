"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, Terminal, Bot, Sparkles, Zap, Check, History, CornerDownLeft, Plus, Loader2 } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import transliterate from "@sindresorhus/transliterate";
import { shortenHomePath, suggestWorktreePath } from "@/features/terminal/lib/workspaceGrouping";
import { useAgentClis } from "@/features/terminal/hooks/useAgentClis";
import { agentIconUrl, AGENT_ICON_CLS, canSkipPermissions, loadShellPref, loadTerminalPrefs, savePref, TERMINAL_PREF_KEYS } from "@/features/terminal/constants/agentCli";
import { isMac } from "@/features/terminal/constants/shortcuts";
import LocationPicker from "@/features/terminal/components/LocationPicker";
import { PlainShellGlyph } from "@/features/terminal/components/SessionAgentIcon";
import AgentHistoryPanel from "@/features/terminal/components/AgentHistoryPanel";
import FolderPickerModal from "@/features/terminal/components/FolderPickerModal";
import { AI_UI_OPTIONS } from "@/features/ai/constants";
import { connOf } from "@/shared/transport/hostConn";

const QUICK_KEYS_MAC = ["⌥", "⇧", "↵"];
const QUICK_KEYS_PC = ["Ctrl", "⇧", "↵"];

const TAB_DEFS = [
  { id: "new", icon: Terminal, labelKey: "terminal.newTerminal" },
  { id: "history", icon: History, labelKey: "agentHistory.title" }
];

// Shared "New terminal" modal: where it starts (workspace root / a repo's worktree),
// what to launch (plain shell or a TUI agent CLI detected on the host's PATH), how it
// runs, and what to call it — decision first, its dependents under it, name last.
// Used by workspace TerminalHeader/Sidebar and home SessionList. Remount via `key` to reset.
// Agent logo, falling back to a neutral glyph when an agent ships no bundled icon
function AgentAvatar({ agent }) {
  const [broken, setBroken] = useState(false);
  if (!agent) return <PlainShellGlyph size={16} />;
  if (broken) return <Bot size={16} className="text-text-muted" />;
  return (
    <img
      src={agentIconUrl(agent.id)}
      alt=""
      width={16}
      height={16}
      onError={() => setBroken(true)}
      className={`w-4 h-4 object-contain ${AGENT_ICON_CLS}`}
    />
  );
}

export default function NewTerminalModal({
  onClose, onCreate, shells = [], suggestName = "", busRef = null,
  workspacePath = null, workspaceName = "", fileBus = null, homeDir = null,
  onResumeAgentSession = null, liveSessionIds = null, activeSessionId = null,
  onSelectSession = null, connected = true, hostKey = "main"
}) {
  const { t } = useI18n();
  // One door: file API + cache scope resolve from the host this modal creates on —
  // callers stop hand-picking buses (hostKey "main" = the main connection). Conn
  // wins over any fileBus prop: a main-scoped prop on a foreign workspace would
  // browse the wrong machine.
  const modalConn = connOf(hostKey !== "main" ? hostKey : null);
  const modalFileBus = modalConn.head ? modalConn.fileBus : (fileBus || modalConn.fileBus);
  const modalScope = modalConn.scope;
  const agentClis = useAgentClis(busRef, hostKey);
  // "" = plain terminal. Held as an id (not the object) so the last-used agent
  // restores from localStorage before detection lands, with no effect/setState race.
  const [agentId, setAgentId] = useState(() => loadTerminalPrefs().agentId);
  const [name, setName] = useState("");
  // null = inherit the workspace's last cwd, same as before this picker existed
  const [cwd, setCwd] = useState(null);
  const [browsing, setBrowsing] = useState(false);
  // Pending worktree: typed below the location picker, but only created when the
  // modal's own Create runs — cancelling the modal must not leave a worktree behind.
  const [wtOpen, setWtOpen] = useState(false);
  const [wtName, setWtName] = useState("");
  const [wtRepo, setWtRepo] = useState(null);
  const [wtBusy, setWtBusy] = useState(false);
  const [wtError, setWtError] = useState(null);
  const [repos, setRepos] = useState(null); // lazy repo scan [{path,name,branch}]
  const wtInputRef = useRef(null);
  // On by default — the agent acts without approval prompts unless the user opted out before
  const [skipPermissions, setSkipPermissions] = useState(() => loadTerminalPrefs().yolo);
  const [shellId, setShellId] = useState(() => {
    const saved = loadShellPref();
    if (saved && shells.some((s) => s.id === saved)) return saved;
    return shells[0]?.id || "";
  });
  // Past conversations live behind a second tab rather than a separate surface: both
  // answer "which terminal am I opening", so they belong in one place. Only offered
  // when the caller can actually resume one and there is a directory to look in.
  const [tab, setTab] = useState("new");
  const nameRef = useRef(null);
  const listRef = useRef(null);
  const didScrollToPickRef = useRef(false);

  useEffect(() => {
    // No autofocus on touch — the popping keyboard shoves the centered modal up abruptly
    if (!window.matchMedia("(pointer: fine)").matches) return;
    requestAnimationFrame(() => nameRef.current?.focus());
  }, []);

  const quickKeys = isMac() ? QUICK_KEYS_MAC : QUICK_KEYS_PC;

  // Free-form name → git-safe branch: transliterate to ASCII (sửa → sua) so any
  // language reads as words, non-word runs collapse to one dash, edges trimmed.
  const wtBranch = transliterate(wtName.trim())
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // The worktree hangs off whatever the location picker points at (a repo root or
  // one of its worktrees — git adds siblings from any checkout); scan+workspace
  // only back the untouched default.
  const wtRepoPath = cwd || wtRepo || workspacePath;
  // Staged = a valid branch typed in; survives collapsing the input, so Create is
  // what actually creates it.
  const stagedWorktree = wtBranch ? { repo: wtRepoPath, branch: wtBranch, path: suggestWorktreePath(wtRepoPath, wtBranch) } : null;

  const expandWorktree = () => {
    vibrate();
    setWtError(null);
    setWtOpen(true);
    // Lazy: pick the workspace's root repo silently — a multi-repo folder gets the
    // first repo at its root, no chooser UI.
    if (repos === null && modalFileBus?.gitScanRepos) {
      modalFileBus.gitScanRepos(workspacePath).then((res) => {
        const list = res?.success ? res.repos || [] : [];
        setRepos(list);
        setWtRepo((prev) => prev || list.find((r) => !r.relPath)?.path || list[0]?.path || null);
      });
    }
    // Tap IS the intent to type — focus on touch too, unlike mount-time autofocus
    requestAnimationFrame(() => wtInputRef.current?.focus());
  };
  const unstageWorktree = () => {
    vibrate();
    setWtOpen(false);
    setWtName("");
    setWtError(null);
  };
  const stageWorktree = () => {
    if (!stagedWorktree) return;
    vibrate();
    setWtError(null);
    setWtOpen(false);
  };

  // Bring the restored pick into view once, after detection populates the list.
  // Not per-render: re-scrolling on every keystroke would fight the user's scroll.
  useEffect(() => {
    if (didScrollToPickRef.current || !agentClis?.length || !agentId) return;
    didScrollToPickRef.current = true;
    listRef.current?.querySelector("[data-picked=true]")?.scrollIntoView({ block: "nearest" });
  }, [agentClis, agentId]);

  // Detected agent CLIs, each with its UI variant — but a UI only shows when its
  // CLI is installed on THIS host (no Claude Code on the machine, no Claude UI).
  //  empty spacer → Claude CLI → Claude UI → other pairs (CLI then UI) → CLI-only
  const visibleAiUis = AI_UI_OPTIONS;
  const allAgents = (agentClis || []).flatMap((a) => {
    const ui = visibleAiUis.find((u) => u.aiEngine === a.id);
    return ui ? [a, ui] : [a];
  });

  // Build a lookup: base engine id → its UI option (if any)
  const uiById = new Map(visibleAiUis.map((u) => [u.aiEngine, u]));
  const pairBases = new Set(uiById.keys()); // engines that have a UI variant

  const claudeCli = allAgents.find((a) => a.id === "claude");
  const claudeUi = allAgents.find((a) => a.id === "claude-ui");

  // Non-claude pairs: each base appears as CLI then UI
  const sortedPairs = [];
  const seenBases = new Set(["claude"]);
  for (const a of allAgents) {
    const base = a.isAiUi ? a.aiEngine : a.id;
    if (seenBases.has(base)) continue;
    if (!pairBases.has(base)) continue;
    seenBases.add(base);
    const cli = allAgents.find((x) => !x.isAiUi && x.id === base);
    const ui = uiById.get(base);
    if (cli) sortedPairs.push(cli);
    if (ui) sortedPairs.push(ui);
  }

  // CLI-only agents (no UI variant at all)
  const cliOnly = allAgents.filter((a) => !a.isAiUi && !pairBases.has(a.id) && a.id !== "claude");

  const agent = (agentId && allAgents.find((a) => a.id === agentId)) || null;
  // Slot 0: Plain terminal (row 1 left)
  // Slot 1: empty spacer (row 1 right) — keeps pairs aligned on the same row
  // Slot 2+: Claude CLI, Claude UI, then pairs CLI→UI, then CLI-only
  const options = [null, { empty: true }, ...(claudeCli ? [claudeCli] : []), ...(claudeUi ? [claudeUi] : []), ...sortedPairs, ...cliOnly];
  const canSkip = !agent?.isAiUi && canSkipPermissions(agent);
  // The agent's own skip-mode token, e.g. --yolo / GOOSE_MODE=auto — null for plain shells
  const skipFlag = agent?.yolo
    || (agent?.yoloEnv ? Object.entries(agent.yoloEnv).map(([k, v]) => `${k}=${v}`).join(" ") : null);

  const pick = (picked) => { vibrate(); setAgentId(picked?.id || ""); };

  // Roving focus across the 2-column grid — a radiogroup is arrow-navigated, not tabbed.
  const onGridKey = (e, index) => {
    const delta = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 2, ArrowUp: -2 }[e.key];
    if (delta === undefined) return;
    e.preventDefault();
    let next = index + delta;
    if (options[next]?.empty) next += delta > 0 ? 1 : -1;
    next = Math.max(0, Math.min(options.length - 1, next));
    if (options[next]?.empty) return;
    pick(options[next]);
    listRef.current?.querySelector(`[data-index="${next}"]`)?.focus();
  };

  // Agent tabs default to "<Agent> <n>" so two Claude terminals stay tellable apart;
  // suggestName already carries the caller's per-workspace counter.
  // Short name keeps the mobile placeholder tidy; buttons keep the full label.
  const suggestIndex = suggestName.match(/\d+$/)?.[0];
  const defaultName = stagedWorktree
    ? stagedWorktree.branch
    : agent
      ? `${agent.short || agent.label}${suggestIndex ? ` ${suggestIndex}` : ""}`
      : (suggestName || t("terminal.defaultName"));

  // Where to look for past conversations: whatever the location picker points at,
  // falling back to the workspace root it defaults to.
  const historyCwd = cwd || workspacePath;
  const canShowHistory = !!onResumeAgentSession && !!historyCwd;
  const showHistory = canShowHistory && tab === "history";

  const submit = (picked = agent) => {
    vibrate();
    if (wtBusy) return;
    const finalize = (effCwd) => {
      if (!picked && shellId) savePref(TERMINAL_PREF_KEYS.shell, shellId);
      savePref(TERMINAL_PREF_KEYS.agent, picked?.id || "");
      savePref(TERMINAL_PREF_KEYS.yolo, skipPermissions ? "1" : "0");
      const yolo = skipPermissions && canSkipPermissions(picked);
      // An agent tab left unnamed takes the agent's name, not the host's generic "Term N";
      // a staged worktree names the tab after its branch instead.
      const suffix = suggestIndex ? ` ${suggestIndex}` : "";
      const typed = name.trim();
      const finalName = typed || (stagedWorktree ? stagedWorktree.branch : (picked ? `${picked.short || picked.label}${suffix}` : null));
      // A name we filled in ourselves is still the terminal's to lose: it keeps
      // following its conversation's title, unlike one the user actually typed.
      onCreate?.(finalName, !picked ? (shellId || null) : null, picked, yolo, effCwd, !typed);
      onClose?.();
    };
    // Create is the commit point: the worktree is made here, never while typing.
    if (!stagedWorktree) return finalize(cwd);
    if (!modalFileBus?.gitWorktreeAdd) {
      setWtError("This agent version does not support worktrees");
      setWtOpen(true);
      return;
    }
    setWtBusy(true);
    setWtError(null);
    modalFileBus.gitWorktreeAdd(stagedWorktree.repo, stagedWorktree.path, stagedWorktree.branch, true)
      .then((res) => {
        setWtBusy(false);
        if (!res?.success) {
          // Keep the input up with the typed name — fix it and press Create again
          setWtError(res?.error || "Failed to create worktree");
          setWtOpen(true);
          return;
        }
        finalize(res.path || stagedWorktree.path);
      });
  };

  const submitRef = useRef(submit);
  useEffect(() => {
    submitRef.current = submit;
  });

  // Keyboard navigation: Enter to create, Escape to close
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (browsing) return;
      // Keys born inside the worktree-create form belong to it — its input submits
      // the form and Escape backs out to the list, never the whole modal.
      if (e.target?.closest?.("[data-wt-form]")) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose?.();
      } else if (e.key === "Enter" && tab === "new") {
        if (e.target?.tagName === "BUTTON") {
          if (e.target?.getAttribute("role") === "radio") {
            e.preventDefault();
            e.stopPropagation();
            submitRef.current();
          }
          return;
        }
        if (e.target?.tagName === "SELECT") return;
        e.preventDefault();
        e.stopPropagation();
        submitRef.current();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [browsing, tab, onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <>
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center px-4 bg-black/60 backdrop-blur-[2px] animate-in fade-in duration-150"
      style={{ paddingTop: "max(1rem, env(safe-area-inset-top))", paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="newTerminalTitle"
        className="card-elev w-[26rem] max-w-full overflow-hidden flex flex-col my-auto max-h-[min(85%,calc(var(--app-height,85vh)-2rem))] animate-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Title, then where the terminal will start — context before choices */}
        <div className={`px-4 pt-4 space-y-2.5 ${showHistory ? "pb-0" : "pb-3"}`}>
          <div className={`flex gap-2 ${canShowHistory ? "items-stretch -mx-4 px-4 border-b border-border-subtle" : "items-center"}`}>
            {canShowHistory ? (
              // Underline tabs, same shape as the right panel's — the app already has
              // one tab idiom, and a second one made of pills would read as a toolbar.
              <div role="tablist" className="flex-1 min-w-0 flex items-stretch gap-3">
                {TAB_DEFS.map(({ id, icon: TabIcon, labelKey }) => (
                  <button
                    key={id}
                    role="tab"
                    aria-selected={tab === id}
                    onClick={() => { vibrate(); setTab(id); }}
                    className={`pb-2 -mb-px flex items-center gap-1.5 text-sm font-semibold border-b-2 transition-colors ${
                      tab === id ? "text-text border-brand-500" : "text-text-muted border-transparent hover:text-text"
                    }`}
                  >
                    <TabIcon size={14} className="shrink-0" />
                    <span className="truncate">{t(labelKey)}</span>
                  </button>
                ))}
              </div>
            ) : (
              <h2 id="newTerminalTitle" className="flex-1 text-sm font-semibold text-text">{t("terminal.newTerminal")}</h2>
            )}
            <button onClick={onClose} aria-label={t("common.cancel")} className="text-text-muted hover:text-text shrink-0 self-center">
              <X size={18} />
            </button>
          </div>
          {workspacePath && !showHistory && (
            <>
            <LocationPicker
              workspacePath={workspacePath}
              workspaceName={workspaceName}
              fileBus={modalFileBus}
              homeDir={homeDir}
              value={cwd}
              onChange={(p) => setCwd(p)}
              onBrowse={() => setBrowsing(true)}
              staged={stagedWorktree}
            />
            {wtOpen ? (
              <div data-wt-form className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <div className="relative flex-1 min-w-0">
                    <input
                      type="text"
                      ref={wtInputRef}
                      value={wtName}
                      disabled={wtBusy}
                      onChange={(e) => setWtName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); stageWorktree(); }
                        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); unstageWorktree(); }
                      }}
                      placeholder={t("workspaces.worktreeName")}
                      className="w-full pl-2.5 pr-7 py-1.5 rounded-brand bg-surface-2 text-xs text-text placeholder-text-subtle border border-border-subtle focus:outline-none focus:border-brand-500"
                    />
                    {wtName && !wtBusy && (
                      <button
                        type="button"
                        onClick={() => { vibrate(); setWtName(""); wtInputRef.current?.focus(); }}
                        aria-label={t("common.clear")}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-text-subtle hover:text-text rounded transition-colors"
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={stageWorktree}
                    disabled={!stagedWorktree || wtBusy}
                    className="p-1.5 rounded-brand bg-brand-500 hover:bg-brand-600 text-white transition-colors disabled:opacity-50 disabled:pointer-events-none shrink-0"
                    aria-label={t("workspaces.addWorktree")}
                  >
                    <Check size={12} />
                  </button>
                  {/* Touch has no Escape — this is how the form closes on a phone.
                      Named in words, not a second X: the input already has one. */}
                  <button
                    type="button"
                    onClick={unstageWorktree}
                    disabled={wtBusy}
                    className="px-2 py-1.5 rounded-brand text-xs text-text-muted hover:text-text hover:bg-surface-2 transition-colors disabled:opacity-50 shrink-0"
                  >
                    {t("common.cancel")}
                  </button>
                </div>
                {/* A name that transliterates to nothing can't become a branch — say why */}
                {wtName.trim() && !wtBranch && (
                  <p className="text-[10px] text-red-500 leading-tight">{t("workspaces.worktreeNameAscii")}</p>
                )}
                {/* Path preview — the directory is derived, never typed */}
                <p className="truncate text-[10px] text-text-subtle leading-tight" title={stagedWorktree?.path}>
                  {shortenHomePath(suggestWorktreePath(wtRepoPath, wtBranch || "…"), homeDir)}
                </p>
                {wtError && <p className="text-[10px] text-red-500 break-words">{wtError}</p>}
              </div>
            ) : (
              <button
                type="button"
                onClick={expandWorktree}
                title={stagedWorktree ? stagedWorktree.path : undefined}
                className="w-full flex items-center gap-1.5 px-2.5 py-1 rounded-brand text-xs transition-colors hover:bg-surface-2"
              >
                <Plus size={13} className="shrink-0 text-brand-500" />
                {stagedWorktree ? (
                  <>
                    <span className="truncate text-text font-medium">{stagedWorktree.branch}</span>
                    <span className="truncate text-[10px] text-text-subtle">{shortenHomePath(stagedWorktree.path, homeDir)}</span>
                  </>
                ) : (
                  <span className="text-text-muted">{t("workspaces.addWorktree")}</span>
                )}
              </button>
            )}
            </>
          )}
        </div>

        {showHistory ? (
          <AgentHistoryPanel
            variant="list"
            busRef={busRef}
            scope={modalScope}
            cwd={historyCwd}
            onResume={(row) => { onResumeAgentSession?.(row); onClose?.(); }}
            onSelectSession={(id) => { onSelectSession?.(id); onClose?.(); }}
            liveSessionIds={liveSessionIds}
            activeSessionId={activeSessionId}
            connected={connected}
          />
        ) : (
        <>
        {/* What to launch — the decision the fields below depend on */}
        <div
          ref={listRef}
          role="radiogroup"
          aria-label={t("terminal.newTerminal")}
          className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-3 pb-1 grid grid-cols-2 gap-1.5 content-start"
        >
          {options.map((a, i) => {
            if (a?.empty) {
              return <div key="__empty_spacer" aria-hidden="true" className="pointer-events-none select-none" />;
            }
            const active = (a?.id || "") === (agent?.id || "");
            return (
              <button
                type="button"
                role="radio"
                aria-checked={active}
                tabIndex={active ? 0 : -1}
                key={a?.id || "__plain"}
                onClick={() => pick(a)}
                onDoubleClick={() => submit(a)}
                onKeyDown={(e) => onGridKey(e, i)}
                data-picked={active}
                data-index={i}
                className={`modal-row text-left min-w-0 outline-none focus:outline-none focus:ring-0 ${
                  active ? "modal-row-active text-text" : "text-text-muted hover:text-text"
                }`}
              >
                <AgentAvatar agent={a} />
                <span className="flex-1 text-sm font-medium truncate">{a ? a.label : t("terminal.plainShell")}</span>
                {active && (
                  <>
                    <span className="hidden sm:inline-flex items-center gap-0.5 shrink-0 select-none">
                      {quickKeys.map((k) => (
                        <kbd key={k} className="inline-flex items-center justify-center px-1 py-0.5 text-[10px] font-mono leading-none rounded bg-surface-3 text-text-muted">
                          {k}
                        </kbd>
                      ))}
                    </span>
                    <Check size={14} className="text-brand-400 shrink-0 sm:hidden" />
                  </>
                )}
              </button>
            );
          })}
        </div>

        <div className="px-4 pt-3 pb-4 space-y-3">
          {/* Dependent on the pick above, so they sit right under it */}
          {!agent && shells.length > 0 && (
            <select
              value={shellId}
              onChange={(e) => setShellId(e.target.value)}
              aria-label={t("terminal.shell")}
              className="w-full px-3 py-2 bg-surface-2 rounded-brand text-sm text-text focus:outline-none"
            >
              {shells.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
          )}
          {/* Always mounted — dimmed when the pick has no skip mode, so switching picks never resizes */}
          <label className={`flex items-center gap-2 px-0.5 select-none ${canSkip ? "cursor-pointer" : "opacity-50 cursor-not-allowed"}`}>
            <input
              type="checkbox"
              checked={canSkip && skipPermissions}
              disabled={!canSkip}
              onChange={(e) => setSkipPermissions(e.target.checked)}
              className="w-4 h-4 accent-brand-500 cursor-pointer disabled:cursor-not-allowed"
            />
            {skipFlag ? (
              <code className="min-w-0 text-xs font-mono text-text-muted truncate">{skipFlag}</code>
            ) : (
              <span className="text-xs text-text-muted">{t("terminal.skipPermissions")}</span>
            )}
          </label>
          <div className="space-y-1">
            <label htmlFor="newTerminalName" className="block text-[11px] font-medium text-text-muted px-0.5">
              {t("terminal.nameLabel")}
            </label>
            <div className="relative">
              <input
                id="newTerminalName"
                type="text"
                ref={nameRef}
                value={name}
                placeholder={defaultName}
                onInput={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    listRef.current?.querySelector("[data-picked=true]")?.focus();
                  }
                }}
                className="w-full pl-3 pr-8 py-2 bg-surface-2 rounded-brand text-sm text-text placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-brand-500/40"
              />
              {name && (
                <button
                  type="button"
                  onClick={() => { vibrate(); setName(""); nameRef.current?.focus(); }}
                  aria-label={t("common.clear")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-text-subtle hover:text-text rounded transition-colors"
                >
                  <X size={13} />
                </button>
              )}
            </div>
          </div>
          {/* Primary action last, at the end of the reading direction */}
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="flex-1 py-2 text-sm text-text-muted bg-surface-2 hover:bg-surface-3 rounded-brand transition-colors flex items-center justify-center gap-1.5"
            >
              <span>{t("common.cancel")}</span>
              <kbd className="hidden sm:inline-flex items-center text-[10px] font-mono px-1 py-0.5 rounded bg-surface-3 text-text-muted leading-none">Esc</kbd>
            </button>
            <button
              onClick={() => submit()}
              disabled={wtBusy || (wtOpen && !stagedWorktree)}
              className="flex-1 py-2 text-sm font-semibold text-white bg-brand-500 hover:bg-brand-600 rounded-brand transition-colors flex items-center justify-center gap-1.5 disabled:opacity-60"
            >
              {wtBusy ? <Loader2 size={14} className="animate-spin" /> : <span>{t("common.create")}</span>}
              {!wtBusy && (
                <kbd className="hidden sm:inline-flex items-center justify-center w-4 h-4 rounded bg-white/20 text-white">
                  <CornerDownLeft size={10} strokeWidth={2.5} />
                </kbd>
              )}
            </button>
          </div>
        </div>
        </>
        )}
      </div>

      </div>

      {/* Sibling, not child: its backdrop click must not bubble into this modal's close */}
      {browsing && (
        <FolderPickerModal
          fileBus={modalFileBus}
          scope={modalScope}
          initialPath={cwd || workspacePath}
          onSelect={(p) => { setBrowsing(false); if (p) setCwd(p); }}
          onClose={() => setBrowsing(false)}
        />
      )}
    </>,
    document.body
  );
}
