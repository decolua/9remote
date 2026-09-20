"use client";

import { memo, useRef, useEffect, useLayoutEffect, useState, useCallback, useMemo } from "react";
import { useAiStore } from "@/shared/stores/aiStore";
import { useConnectionStore } from "@/shared/stores/connectionStore";
import { MessageBubble } from "./MessageBubble";
import { AiTurn } from "./AiTurn";
import { ENGINE_INFO, STARTER_PROMPTS } from "../constants";
import { ArrowDown, Check, Loader2, Pencil, History } from "@/shared/components/ui/Icon";
import { describeLive, estimateTurnTokens, countTurnChanges, formatTokens } from "../lib/liveStatus";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { termLog } from "@/shared/utils/termLog";
import { agentIconUrl, AGENT_ICON_CLS } from "@/features/terminal/constants/agentCli";
import { useWorkspaceGit } from "@/features/terminal/hooks/useWorkspaceGit";
import { OPEN_SESSION_EVENT } from "@/features/terminal/constants/terminalConfig";
import { shortenHomePath } from "@/features/terminal/lib/workspaceGrouping";
import { PAGE_BUDGET_BYTES, MAX_MOUNTED_BYTES, MAX_AUTO_PAGES, windowTop, opensMidTurn } from "../lib/messageWindow";
import { anchorFrom, anchoredScrollTop } from "../lib/scrollAnchor";

const EMPTY_MESSAGES = [];

// Hold element directly: React reconciles by key so the node survives prepend.
const measure = (el, node) => {
  if (!el || !node) return null;
  // Content coordinates survive correction; offsetTop is vulnerable to positioned ancestors.
  const content = el.getBoundingClientRect();
  return {
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    nodeTop: node.getBoundingClientRect().top - content.top + el.scrollTop
  };
};

const RECENT_SESSIONS = 8;
const LOAD_MORE_THRESHOLD_PX = 120;
// Cooldown prevents back-to-back page fetches when collapsed turns leave scrollTop under threshold.
const PAGE_COOLDOWN_MS = 300;
// Poll limit while waiting for engine to make conversation rewindable.
const REWIND_ASKS_MAX = 6;

const pad2 = (n) => String(n).padStart(2, "0");

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${pad2(s)}s`;
  if (m > 0) return `${m}m ${pad2(s)}s`;
  return `${s}s`;
}

function tokenReadout(outputTokens) {
  if (!outputTokens) return null;
  return (
    <>
      <span className="text-text-muted/60"> · </span>
      {formatTokens(outputTokens)} tokens
    </>
  );
}

function changeReadout({ added, removed }) {
  if (!added && !removed) return null;
  return (
    <>
      <span className="text-text-muted/60"> · </span>
      {added > 0 && <span className="text-success">+{added}</span>}
      {added > 0 && removed > 0 && " "}
      {removed > 0 && <span className="text-danger">−{removed}</span>}
    </>
  );
}

// Shown during rebuild so fresh chat state is not shown before the host answers.
const AiLoadingState = memo(function AiLoadingState({ engine = "claude", failed = false, onRetry }) {
  const engineMeta = ENGINE_INFO[engine] || ENGINE_INFO.claude;
  if (failed) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 text-center p-6 select-none">
        <span className="font-mono text-[12px] text-danger">Couldn&apos;t load this conversation</span>
        <span className="text-[11px] font-mono text-text-muted/70">{engineMeta.label}</span>
        <button
          type="button"
          onClick={() => { vibrate(); onRetry?.(); }}
          className="px-3 py-1.5 rounded-brand text-[11px] font-mono text-text bg-surface-2 hover:bg-surface-3 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 text-center p-6 select-none">
      <Loader2 size={20} className="animate-spin text-brand-500" />
      <span className="ai-sheen-text font-mono text-[12px] text-text-muted">Syncing…</span>
      <span className="text-[11px] font-mono text-text-muted/70">{engineMeta.label}</span>
    </div>
  );
});

// Running spinner and finished summary share one row so layout does not jump.
const AiTurnStatus = memo(function AiTurnStatus({ sessionId, engine = "", hydrating = false }) {
  const isTurnRunning = useAiStore((s) => s.bySession[sessionId]?.isTurnRunning);
  const turnStartedAt = useAiStore((s) => s.bySession[sessionId]?.turnStartedAt);
  const lastTurnMs = useAiStore((s) => s.bySession[sessionId]?.lastTurnMs);
  const stats = useAiStore((s) => s.bySession[sessionId]?.stats);
  const turnBaseline = useAiStore((s) => s.bySession[sessionId]?.turnBaseline);
  const connected = useConnectionStore((s) => s.connected);
  const retryStatus = useConnectionStore((s) => s.retryStatus);
  // The whole turn, not just the last message: a tool call closes the streaming
  // segment, so reading the tail alone made the count fall back on every command.
  // One subscription serves both — the tail is read off the end of this same list.
  const turnMessages = useAiStore((s) => s.bySession[sessionId]?.messages) || EMPTY_MESSAGES;
  const lastMsg = turnMessages[turnMessages.length - 1] || null;

  // The host reports a session-running total; the line shows only this turn's share.
  const turnOutput = Math.max(0, (stats?.outputTokens || 0) - (turnBaseline?.outputTokens || 0));

  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!isTurnRunning) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isTurnRunning]);

  // Freeze summary against the live clock so resumed panes continue from host values.
  const [finished, setFinished] = useState(null);
  const prevRunningRef = useRef(isTurnRunning);
  useEffect(() => {
    if (prevRunningRef.current && !isTurnRunning && turnStartedAt) {
      // Prefer host duration over local elapsed time in case of mid-turn joins.
      setFinished({
        ms: lastTurnMs || Date.now() - turnStartedAt,
        outputTokens: turnOutput,
        changes: countTurnChanges(turnMessages)
      });
    }
    if (isTurnRunning) setFinished(null);
    prevRunningRef.current = isTurnRunning;
    // Guard on falling edge keeps streaming re-renders from re-freezing summary.
  }, [isTurnRunning, turnStartedAt, lastTurnMs, turnOutput, turnMessages]);

  // For panes mounted after turn ended, host lastTurnMs is the only timing record.
  const reopened = useMemo(
    () => (!finished && !isTurnRunning && lastTurnMs
      ? { ms: lastTurnMs, outputTokens: 0, changes: countTurnChanges(turnMessages) }
      : null),
    [finished, isTurnRunning, lastTurnMs, turnMessages]
  );
  const summary = finished || reopened;

  if (!isTurnRunning && !summary) return null;

  if (!isTurnRunning) {
    return (
      <div className="flex items-center gap-2 py-1 select-none text-xs text-text-muted">
        <Check size={14} className="text-emerald-400 shrink-0" />
        {/* Counts sit outside truncating span so ellipsis does not hide them */}
        <span className="flex items-center min-w-0 font-mono text-[11px]">
          <span className="truncate">
            Worked for <span className="text-text">{formatDuration(summary.ms)}</span>
          </span>
          <span className="shrink-0">
            {changeReadout(summary.changes)}
            {tokenReadout(summary.outputTokens)}
          </span>
        </span>
      </div>
    );
  }

  const activeTool = lastMsg?.tools?.find((t) => t.status === "running");
  // Live count estimates un-reported tokens until turn_complete.
  const liveOutput = turnOutput + estimateTurnTokens(turnMessages);
  const live = describeLive({ connected, hydrating, retryStatus, activeTool, engine, lastMsg });

  return (
    <div className="flex items-center gap-2 py-1 select-none text-xs text-text-muted">
      {live.tone === "alert" ? (
        <span className="w-2 h-2 rounded-full bg-danger animate-pulse shrink-0" />
      ) : (
        <Loader2 size={13} className="animate-spin text-brand-500 shrink-0" />
      )}
      {/* background-clip: text re-anchors per element; keep children unnested */}
      <span className="flex items-center min-w-0 font-mono text-[11px]">
        <span className="truncate">
          <span className={`ai-sheen-text${live.tone === "alert" ? " !text-danger" : ""}`}>{live.verb}…</span>
          {live.detail && <span className="text-text-subtle"> {live.detail}</span>}
          <span className="text-text-muted/60"> · </span>
          {formatDuration(now - (turnStartedAt || now))}
        </span>
        <span className="shrink-0">{tokenReadout(liveOutput)}</span>
      </span>
    </div>
  );
});

function relativeAge(ms) {
  if (!ms) return "";
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

// Mounted only for empty chats so git/session polls do not run during active turns.
const AiEmptyState = memo(function AiEmptyState({ engine, engineMeta, workspacePath, fileBus, onSendPrompt, onOpenResume }) {
  const { t } = useI18n();
  const [recent, setRecent] = useState([]);
  const [homedir, setHomedir] = useState(null);
  const git = useWorkspaceGit(workspacePath, fileBus, { enabled: Boolean(workspacePath) });

  useEffect(() => {
    if (!workspacePath) return;
    let live = true;
    fileBus?.getSystemInfo?.().then((res) => { if (live && res?.success) setHomedir(res.homedir || null); }).catch(() => {});
    return () => { live = false; };
  }, [fileBus, workspacePath]);

  useEffect(() => {
    if (!workspacePath) return;
    let live = true;
    const bus = useConnectionStore.getState().bus;
    if (!bus?.emit) return;
    bus.emit("getAgentSessions", { cwd: workspacePath }, (res) => {
      if (!live) return;
      const rows = Array.isArray(res?.sessions) ? res.sessions : [];
      // Another engine's transcript is unreadable to this CLI, so it is not offered.
      setRecent(rows.filter((r) => !engine || r.agent === engine).slice(0, RECENT_SESSIONS));
    });
    return () => { live = false; };
  }, [workspacePath, engine]);

  const dirLabel = workspacePath ? shortenHomePath(workspacePath, homedir) : "";

  return (
    <div className="h-full flex flex-col items-center justify-center text-center p-6 select-none overflow-y-auto custom-scrollbar">
      <div
        className="w-12 h-12 rounded-2xl flex items-center justify-center mb-3 shadow-md border border-border-subtle/40 backdrop-blur-sm shrink-0"
        style={{ backgroundColor: `${engineMeta.color}15` }}
      >
        <img
          src={agentIconUrl(`${engine}-ui`)}
          alt={engineMeta.label}
          className={`w-7 h-7 object-contain ${AGENT_ICON_CLS}`}
        />
      </div>
      <h3 className="text-base font-semibold text-text mb-1">{engineMeta.label}</h3>

      {dirLabel && (
        <div className="flex items-center justify-center gap-2 mb-3 text-[11px] font-mono text-text-muted" title={workspacePath}>
          <span className="truncate max-w-[220px]">{dirLabel}</span>
          {git.branch && (
            <>
              <span className="text-text-muted/50">·</span>
              <span className="truncate max-w-[140px]">{git.branch}</span>
              {git.dirty && <span className="text-amber-400" title={`${git.changedCount} changed`}>●{git.changedCount}</span>}
            </>
          )}
        </div>
      )}

      {recent.length > 0 && (
        <div className="w-full max-w-md mb-4 text-left">
          <div className="flex items-center gap-1.5 mb-1.5 px-1 text-[10px] uppercase tracking-wide text-text-muted">
            <History size={11} />
            <span>Recent in this project</span>
          </div>
          <div className="max-h-[38vh] overflow-y-auto custom-scrollbar rounded-brand border border-border-subtle bg-surface-2/30">
            {recent.map((row) => {
              // If session is already open in a terminal, switch to it instead of resuming.
              const isOpen = !!row.openSessionId;
              const onPick = () => {
                if (isOpen) window.dispatchEvent(new CustomEvent(OPEN_SESSION_EVENT, { detail: { sessionId: row.openSessionId } }));
                else onOpenResume?.(row);
              };
              return (
                <button
                  key={`${row.agent}:${row.sessionId}`}
                  type="button"
                  onClick={() => { vibrate(); onPick(); }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left border-b border-border-subtle/50 last:border-b-0 hover:bg-surface-2 transition-colors"
                  title={isOpen ? t("agentHistory.openNow") : undefined}
                >
                  <span className={`flex-1 min-w-0 truncate text-[11px] ${isOpen ? "text-text font-medium" : "text-text-muted"}`}>
                    {row.title || "Untitled conversation"}
                  </span>
                  <span className="shrink-0 text-[10px] font-mono text-text-muted">{relativeAge(row.updatedAt)}</span>
                </button>
              );
            })}
          </div>
          {recent.length >= RECENT_SESSIONS && (
            <button
              type="button"
              onClick={() => { vibrate(); onOpenResume?.(); }}
              className="mt-1.5 px-1 text-[10px] font-mono text-text-muted hover:text-text transition-colors"
            >
              All conversations →
            </button>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-center gap-2 max-w-md shrink-0">
        {STARTER_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            onClick={() => onSendPrompt?.(prompt)}
            className="px-2.5 py-1 rounded-full bg-surface-2 hover:bg-surface-3 text-[11px] text-text font-mono border border-border-subtle transition-colors"
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  );
});

export const AiMessagesList = memo(function AiMessagesList({
  sessionId,
  engine = "claude",
  workspacePath = "",
  fileBus = null,
  onSendPrompt,
  onResolvePermission,
  hasOlder = false,
  onLoadOlder,
  onRewind,
  onPreviewRewind,
  onCutLocal,
  onListRewindPoints,
  onOpenResume,
  hydrating = false,
  synced = true,
  hydrateFailed = false,
  onReload
}) {
  const scrollRef = useRef(null);
  // Sentinel at top of window triggers paging on resize/paint in addition to scroll.
  const sentinelRef = useRef(null);
  const isAtBottomRef = useRef(true);
  const scrollTimerRef = useRef(null);
  // Anchor holds DOM element across await because React key reconciliation preserves the node.
  const topRef = useRef(null);
  // Pending scroll correction armed by handleLoadMore, applied in useLayoutEffect.
  const anchorRef = useRef(null);
  // Timestamp of last page fetch for cooldown gating.
  const pageAtRef = useRef(0);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [visibleBytes, setVisibleBytes] = useState(PAGE_BUDGET_BYTES);
  // The mounted window's top, kept across renders so appends never move it: recomputing it
  // from the newest message each render slid it down, hiding turns already shown.
  const [topId, setTopId] = useState(null);
  // How many open-time pages this session has already pulled, and for which session — a
  // pane repointed at another chat starts its budget over.
  const autoPagedRef = useRef({ sessionId: null, n: 0 });

  const messages = useAiStore((s) => s.bySession[sessionId]?.messages) || EMPTY_MESSAGES;
  const engineMeta = ENGINE_INFO[engine] || ENGINE_INFO.claude;

  // Reset window state when switching sessions.
  useEffect(() => {
    setVisibleBytes(PAGE_BUDGET_BYTES);
    setTopId(null);
    anchorRef.current = null;
  }, [sessionId]);

  // Derived in render so hydrated messages mount with correct slice on first frame.
  const { id: nextTopId, index: hiddenCount } = useMemo(
    () => windowTop(topId, messages, visibleBytes, MAX_MOUNTED_BYTES),
    [topId, messages, visibleBytes]
  );
  useEffect(() => { setTopId(nextTopId); }, [nextTopId]);

  const visibleMessages = hiddenCount > 0 ? messages.slice(hiddenCount) : messages;

  // Poll rewind capability on prompt count change until engine writes transcript.
  const [rewind, setRewind] = useState(null);
  const rewindAsksRef = useRef(0);
  const promptCount = useMemo(() => messages.filter((m) => m.role === "user").length, [messages]);
  useEffect(() => {
    if (rewind?.ok || rewind?.supported === false) return;
    if (rewindAsksRef.current >= REWIND_ASKS_MAX) return;
    rewindAsksRef.current += 1;
    let live = true;
    onListRewindPoints?.().then((r) => { if (live) setRewind(r); }).catch(() => {});
    return () => { live = false; };
  }, [onListRewindPoints, engine, sessionId, promptCount, rewind?.ok, rewind?.supported]);

  const canRewind = Boolean(rewind?.ok);

  // Turn index counted from thread end so host and client agree regardless of paging.
  const rewindIndex = useMemo(() => {
    const out = new Map();
    let n = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== "user") continue;
      out.set(messages[i].id, n++);
    }
    return out;
  }, [messages]);

  const turns = useMemo(() => {
    const out = [];
    for (const m of visibleMessages) {
      if (m.role === "user" || out.length === 0) out.push({ key: m.id, messages: [m] });
      else out[out.length - 1].messages.push(m);
    }
    return out;
  }, [visibleMessages]);

  // Preserve scroll position across prepend by anchoring to top visible node before await.
  const handleLoadMore = useCallback(async ({ auto = false } = {}) => {
    const el = scrollRef.current;
    const now = Date.now();
    if (!auto && now - pageAtRef.current < PAGE_COOLDOWN_MS) return;
    pageAtRef.current = now;
    // Read anchor node through ref to avoid recreating callback on every streamed token.
    const node = topRef.current;
    const a = node ? anchorFrom(measure(el, node)) : null;
    // User-requested paging preserves position; only auto open-time paging pins tail.
    const pending = a ? { ...a, atBottom: auto && isAtBottomRef.current, node } : null;
    const diagBefore = { hiddenCount, hasOlder, scrollTop: el?.scrollTop ?? 0, scrollHeight: el?.scrollHeight ?? 0 };
    // Expand in-RAM window first; fetch from host only when top is reached.
    let fetched = null;
    if (hiddenCount === 0 && hasOlder) fetched = await onLoadOlder?.();
    termLog("ai-page", "loadMore", { ...diagBefore, fetched });
    // Arm anchor correction to be applied on layout effect commit.
    anchorRef.current = pending;
    setTopId(null);
    setVisibleBytes((b) => b + PAGE_BUDGET_BYTES);
  }, [hiddenCount, hasOlder, onLoadOlder]);

  // Apply scroll correction before paint via useLayoutEffect to prevent visible jumps.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const anchor = anchorRef.current;
    if (!el || !anchor) return;
    anchorRef.current = null;
    const target = anchoredScrollTop(anchor, measure(el, anchor.node) || {});
    if (target != null) el.scrollTop = target;
    // Sync scroll flags immediately so onScroll does not fight the corrected position.
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    isAtBottomRef.current = distance < 8;
    setShowScrollBottom(distance > 140);
  }, [visibleBytes, topId]);

  // Auto-page older turns if initial hydrate landed mid-turn, bounded by MAX_AUTO_PAGES.
  useEffect(() => {
    const paged = autoPagedRef.current;
    if (paged.sessionId !== sessionId) { paged.sessionId = sessionId; paged.n = 0; }
    if (paged.n >= MAX_AUTO_PAGES) return;
    // Wait for settled hydrate before auto-paging.
    if (hydrating || !synced) return;
    // Only auto-page if user is still at bottom to avoid fighting scroll-up.
    if (!isAtBottomRef.current) return;
    if (!opensMidTurn(messages, hiddenCount, hasOlder)) return;
    paged.n += 1;
    handleLoadMore({ auto: true });
  }, [sessionId, messages, hiddenCount, hasOlder, hydrating, synced, handleLoadMore]);

  const handleScroll = useCallback(() => {
    if (scrollTimerRef.current) return;
    scrollTimerRef.current = requestAnimationFrame(() => {
      scrollTimerRef.current = null;
      const el = scrollRef.current;
      if (!el) return;
      const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      const atBottom = distanceToBottom < 80;
      isAtBottomRef.current = atBottom;
      setShowScrollBottom(!atBottom && distanceToBottom > 140);
      if (el.scrollTop < LOAD_MORE_THRESHOLD_PX && (hiddenCount > 0 || hasOlder)) {
        handleLoadMore();
      }
    });
  }, [handleLoadMore, hiddenCount, hasOlder]);

  // IntersectionObserver triggers loadMore when sentinel enters threshold while not at bottom.
  useEffect(() => {
    const root = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !isAtBottomRef.current) {
          handleLoadMore();
        }
      },
      { root, rootMargin: `${LOAD_MORE_THRESHOLD_PX}px` }
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [handleLoadMore]);

  // Auto-scroll triggers on new message structure, not on every streaming token.
  const structureKey = useMemo(
    () => messages.map((m) => `${m.id}:${m.thinking ? 1 : 0}:${m.content ? 1 : 0}:${m.tools?.length || 0}:${m.diffs?.length || 0}:${m.permission ? 1 : 0}`).join("|"),
    [messages]
  );

  // Stable ref callback tracks slot 0 element for scroll anchoring.
  const slot0Ref = useCallback((n) => { topRef.current = n; }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !isAtBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [structureKey]);

  // Re-pin to bottom on container resize (e.g. keyboard) if already at bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (!isAtBottomRef.current) return;
      el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const scrollToBottom = useCallback(() => {
    vibrate();
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    isAtBottomRef.current = true;
    setShowScrollBottom(false);
  }, []);

  // Older turns render collapsed to keep mounted DOM light.
  const isLiveTurn = useCallback((turn) => turn.messages.some((m) => m.isLive), []);

  return (
    <div className="flex-1 min-h-0 relative flex flex-col overflow-hidden">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="ai-conversation flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 py-4 space-y-4 custom-scrollbar relative"
      >
        {(hiddenCount > 0 || hasOlder) && <div ref={sentinelRef} aria-hidden="true" className="h-px" />}
        {messages.length === 0 ? (
          // Show loading until host answers hydrate, avoiding false empty state.
          synced ? (
            <AiEmptyState
              engine={engine}
              engineMeta={engineMeta}
              workspacePath={workspacePath}
              fileBus={fileBus}
              onSendPrompt={onSendPrompt}
              onOpenResume={onOpenResume}
            />
          ) : (
            <AiLoadingState engine={engine} failed={hydrateFailed} onRetry={onReload} />
          )
        ) : (
          <>
            {(hiddenCount > 0 || hasOlder) && (
              <button
                type="button"
                onClick={() => { vibrate(); handleLoadMore(); }}
                className="w-full py-1.5 text-[11px] font-mono text-text-muted hover:text-text bg-surface-2/50 hover:bg-surface-2 border border-border-subtle/60 rounded-brand transition-colors"
              >
                {hiddenCount > 0 ? `Load older · ${hiddenCount} more` : "Load older turns"}
              </button>
            )}
            {turns.map((turn, turnIdx) => {
              const [first, ...rest] = turn.messages;
              // Slot 0 is the anchor for prepending older pages.
              if (first.role !== "user") {
                return (
                  <div key={turn.key} ref={turnIdx === 0 ? slot0Ref : undefined}>
                    <AiTurn
                      messages={turn.messages}
                      engine={engine}
                      workspacePath={workspacePath}
                      onResolvePermission={onResolvePermission}
                      isLive={isLiveTurn(turn)}
                    />
                  </div>
                );
              }
              return (
                <div key={turn.key} ref={turnIdx === 0 ? slot0Ref : undefined}>
                  <MessageBubble
                    message={first}
                    engine={engine}
                    workspacePath={workspacePath}
                    onResolvePermission={onResolvePermission}
                    onRewind={onRewind}
                    onPreviewRewind={onPreviewRewind}
                    onCutLocal={onCutLocal}
                    rewindIndex={rewindIndex.get(first.id)}
                    canRewind={canRewind}
                  />
                  <AiTurn
                    messages={rest}
                    engine={engine}
                    workspacePath={workspacePath}
                    onResolvePermission={onResolvePermission}
                    isLive={isLiveTurn(turn)}
                  />
                </div>
              );
            })}
            <AiTurnStatus sessionId={sessionId} engine={engine} hydrating={hydrating} />
          </>
        )}
      </div>

      {showScrollBottom && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-4 right-6 p-2 rounded-full bg-surface-2 border border-border-subtle shadow-lg hover:bg-surface-3 text-text transition-all duration-150 z-30"
          title="Scroll to bottom"
        >
          <ArrowDown size={16} />
        </button>
      )}
    </div>
  );
});