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

// What the reader was looking at, read off ONE NODE — the same element both times.
//
// Held as the element itself, not as an index or a key: React reconciles by key, so the
// div for a turn is the same DOM node before and after a page is prepended above it, only
// moved further down. Slot 0 is NOT that node afterwards, and re-finding it by key would
// mean a lookup table, a callback per turn and a way to escape the key — all to re-derive
// a node already in hand.
const measure = (el, node) => {
  if (!el || !node) return null;
  // Both rects in ONE reading, and `scrollTop` added to land in CONTENT coordinates —
  // the units that survive the correction being written, which is what makes the second
  // reading comparable to the first. `offsetTop` would have been measured against the
  // node's offsetParent, i.e. whichever positioned ancestor happens to be nearest, so a
  // class change on the scroller could silently move the mark.
  const content = el.getBoundingClientRect();
  return {
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    nodeTop: node.getBoundingClientRect().top - content.top + el.scrollTop
  };
};

// How many past conversations the empty state offers before deferring to /resume.
const RECENT_SESSIONS = 8;
const LOAD_MORE_THRESHOLD_PX = 120;
// How many times the pane re-asks whether this conversation is rewindable while waiting
// for the engine to make it so. Enough to cover a slow first turn, few enough that a
// host which will never say yes does not get polled.
const REWIND_ASKS_MAX = 6;

const pad2 = (n) => String(n).padStart(2, "0");

// "1m 12s" while it runs, "1m 12s" once done — both are the same wall-clock span.
function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${pad2(s)}s`;
  if (m > 0) return `${m}m ${pad2(s)}s`;
  return `${s}s`;
}

// The turn's own token count. Hidden until there is something to report.
function tokenReadout(outputTokens) {
  if (!outputTokens) return null;
  return (
    <>
      <span className="text-text-muted/60"> · </span>
      {formatTokens(outputTokens)} tokens
    </>
  );
}

// Lines the run changed, the way the CLIs report it at the end. Hidden when the turn
// touched no file — "+0 −0" would be noise on every question-answering turn.
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

// The chat is being rebuilt from the host. Shown in place of the empty state, which would
// otherwise claim the conversation is new while the ask is still unanswered. Once the
// re-ask ladder is spent the spinner is a lie, so it becomes a retry.
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

// The turn's own line, at the tail of the history like the user's message: the running
// spinner and the finished summary are states of one row, so nothing jumps when it ends.
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

  // Freeze the summary against the same clock the live line used. Tokens and span are
  // both session-running totals, so they only ever climb — a resumed or rebuilt pane
  // keeps counting from where the host says the conversation already is.
  const [finished, setFinished] = useState(null);
  const prevRunningRef = useRef(isTurnRunning);
  useEffect(() => {
    if (prevRunningRef.current && !isTurnRunning && turnStartedAt) {
      // The host measured the span when it ended the turn, and it watched from the real
      // start — this pane may have joined mid-turn, where its own clock reports a sliver.
      setFinished({
        ms: lastTurnMs || Date.now() - turnStartedAt,
        outputTokens: turnOutput,
        changes: countTurnChanges(turnMessages)
      });
    }
    if (isTurnRunning) setFinished(null);
    prevRunningRef.current = isTurnRunning;
    // turnMessages is read only on the falling edge; the guard above keeps the stream's
    // own re-renders from re-freezing the summary.
  }, [isTurnRunning, turnStartedAt, lastTurnMs, turnOutput, turnMessages]);

  // A pane that loaded after the turn ended never saw the falling edge above, so its own
  // clock has nothing to measure — the host's span is the only record of it. Changes come
  // from the replay; the turn's tokens do not survive it, so that readout is left off.
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
        {/* The counts sit outside the truncating span: an ellipsis eats the tail first,
            which is exactly where the changed-line and token readouts are. */}
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
  // The host's number lags the stream, so the live count is the last reported total plus
  // an estimate of what has arrived since. turn_complete replaces it with the real one.
  const liveOutput = turnOutput + estimateTurnTokens(turnMessages);
  // What the agent is doing, named from state the pane already holds (see lib/liveStatus).
  const live = describeLive({ connected, hydrating, retryStatus, activeTool, engine, lastMsg });

  return (
    <div className="flex items-center gap-2 py-1 select-none text-xs text-text-muted">
      {live.tone === "alert" ? (
        <span className="w-2 h-2 rounded-full bg-danger animate-pulse shrink-0" />
      ) : (
        <Loader2 size={13} className="animate-spin text-brand-500 shrink-0" />
      )}
      {/* The sheen owns the verb alone: `background-clip: text` re-anchors its gradient
          per element, so nesting children inside it broke the sweep across the line. */}
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

// Relative age the way the sidebar writes it: short, one unit.
function relativeAge(ms) {
  if (!ms) return "";
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

// What a brand-new conversation shows: where it will run, and what was already
// talked about here. Only mounted while the list is empty, so the session scan and
// the git poll stay off a chat that is under way.
const AiEmptyState = memo(function AiEmptyState({ engine, engineMeta, workspacePath, fileBus, onSendPrompt, onOpenResume }) {
  const { t } = useI18n();
  const [recent, setRecent] = useState([]);
  const [homedir, setHomedir] = useState(null);
  const git = useWorkspaceGit(workspacePath, fileBus, { enabled: Boolean(workspacePath) });

  // Home is only needed to print "~/…" — the git poll does not wait on it.
  useEffect(() => {
    if (!workspacePath) return;
    let live = true;
    fileBus?.getSystemInfo?.().then((res) => { if (live && res?.success) setHomedir(res.homedir || null); }).catch(() => {});
    return () => { live = false; };
  }, [fileBus, workspacePath]);

  // The same scan the sidebar and /resume read, so the rows match what those show.
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

      {/* Where this chat runs — the fact a phone user cannot get from anywhere else. */}
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
              // The host tags the row whose conversation a terminal is already
              // running. Resuming it would open a second copy of the same chat, so
              // the row says so and picks that terminal instead.
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
                  {/* Already running is the brighter row, the way the sidebar's history
                      says it — same idiom, no badge. */}
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
  // Marks the top of the mounted window — watched so paging also fires on first paint
  // (a tap on the header, a resize) and not only on a scroll gesture.
  const sentinelRef = useRef(null);
  const isAtBottomRef = useRef(true);
  const scrollTimerRef = useRef(null);
  // The element in slot 0 right now. Only ever read at the moment a fetch starts: what gets
  // held across the await is that ELEMENT, kept on the anchor itself, because React
  // reconciles by key — the div for that turn is the same DOM node after a page is
  // prepended, just moved further down. Slot 0 is NOT that node afterwards (an older turn
  // takes it), which is why the anchor carries the node and not an index or a key.
  const topRef = useRef(null);
  // The correction waiting for its commit. Armed by handleLoadMore, spent by the layout
  // effect below.
  const anchorRef = useRef(null);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [visibleBytes, setVisibleBytes] = useState(PAGE_BUDGET_BYTES);
  // The mounted window's top, kept across renders so appends never move it: recomputing it
  // from the newest message each render slid it down, hiding turns already shown.
  const [topId, setTopId] = useState(null);
  // How many open-time pages this session has already pulled, and for which session — a
  // pane repointed at another chat starts its budget over.
  const autoPagedRef = useRef({ sessionId: null, n: 0 });

  // Subscribe ONLY to messages of this session
  const messages = useAiStore((s) => s.bySession[sessionId]?.messages) || EMPTY_MESSAGES;
  const engineMeta = ENGINE_INFO[engine] || ENGINE_INFO.claude;

  // A history rebuilt from the host log is a different list — start from the tail again.
  useEffect(() => {
    setVisibleBytes(PAGE_BUDGET_BYTES);
    setTopId(null);
    // A correction measured against the log being replaced would be applied to this one.
    anchorRef.current = null;
  }, [sessionId]);

  // Derived during render, not through state, so the frame that receives a hydrate mounts
  // the right slice. Through state it would mount the previous slice for one frame — and
  // on a hydrate, where the ids are all new, that slice is the whole session.
  const { id: nextTopId, index: hiddenCount } = useMemo(
    () => windowTop(topId, messages, visibleBytes, MAX_MOUNTED_BYTES),
    [topId, messages, visibleBytes]
  );
  useEffect(() => { setTopId(nextTopId); }, [nextTopId]);

  const visibleMessages = hiddenCount > 0 ? messages.slice(hiddenCount) : messages;

  // One turn = a user message plus every assistant segment that followed it. The list
  // renders turns, not messages, because a turn is what folds (see AiTurn).
  //
  // Only an engine that can actually rewind gets the control on a prompt. A fresh chat
  // is refused until its conversation is readable, and when that happens depends on the
  // engine — claude binds an id at startup but writes its transcript once the turn is
  // underway. Rather than guess a trigger, the question is re-asked (a handful of times,
  // then left alone) each time the prompt count changes.
  const [rewind, setRewind] = useState(null);
  const rewindAsksRef = useRef(0);
  const promptCount = useMemo(() => messages.filter((m) => m.role === "user").length, [messages]);
  useEffect(() => {
    if (rewind?.ok || rewind?.supported === false) return;
    // The wait is for a transcript being written, which is a turn's work, not a chat's.
    if (rewindAsksRef.current >= REWIND_ASKS_MAX) return;
    rewindAsksRef.current += 1;
    let live = true;
    onListRewindPoints?.().then((r) => { if (live) setRewind(r); }).catch(() => {});
    return () => { live = false; };
    // Re-asked when the engine changes too: a pane can be repointed at another one.
  }, [onListRewindPoints, engine, sessionId, promptCount, rewind?.ok, rewind?.supported]);

  const canRewind = Boolean(rewind?.ok);

  // Which turn each bubble is, counted from the END of the thread.
  //
  // A bubble's id is minted in this client's store (`u-<timestamp>`) and means nothing
  // to a CLI, so the host cannot look the turn up by it. A position from the end is what
  // both sides always agree on, however much paging hid above.
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

  // Prepending shifts everything down; hold the turn the reader was on, so paging up does
  // not move what they are reading.
  //
  // The correction is taken BEFORE the await and settled in a LAYOUT effect (see
  // anchorRef below), never from a `scrollHeight` read across it. That was the
  // old way and it moved the reader: the fetch takes seconds, the scroller is clamped by
  // the browser while it runs, and the live turn kept streaming text into the tail — so
  // `scrollHeight` grew for reasons that had nothing to do with the page being prepended,
  // and the whole delta was added to `scrollTop`. On a phone, where one page is worth far
  // fewer pixels than on a desktop, the wrong part of the delta is the bigger part.
  const handleLoadMore = useCallback(async () => {
    const el = scrollRef.current;
    // The node the spec would pick too — nearest the block start edge. A page can only
    // ever land ABOVE it, which is what makes it a mark worth holding on to. Read through a
    // ref rather than from `turns`: the store appends a message per streamed token, so
    // anything this callback closed over would be rebuilt that often, and the observer
    // below is keyed on it.
    const node = topRef.current;
    const pending = node ? { ...anchorFrom(measure(el, node)), node } : null;
    // TEMP DIAGNOSTIC — scroll-up shows no older turns; log the decision inputs and the
    // outcome so we can tell "never asked the host" from "host had nothing" from "got it
    // but never mounted". Remove once the paging path is confirmed end to end.
    const diagBefore = { hiddenCount, hasOlder, scrollTop: el?.scrollTop ?? 0, scrollHeight: el?.scrollHeight ?? 0 };
    // The in-RAM window grows first; past its end the older turns still live on the host.
    // Dropping the mark is what reveals a page that arrived while it was still standing —
    // a held top wins over the page budget by design.
    let fetched = null;
    if (hiddenCount === 0 && hasOlder) fetched = await onLoadOlder?.();
    termLog("ai-page", "loadMore", { ...diagBefore, fetched });
    // The anchor is armed here and spent by the layout effect below, on the commit these
    // two setters cause. A second call that got through the hook's in-flight guard simply
    // overwrites it with a fresher reading of the same node — and settling twice on the
    // same node gives the same answer, so nothing compounds.
    anchorRef.current = pending;
    setTopId(null);
    setVisibleBytes((b) => b + PAGE_BUDGET_BYTES);
  }, [hiddenCount, hasOlder, onLoadOlder]);

  // The commit that reveals the page, closed before the browser paints.
  //
  // useLayoutEffect, not requestAnimationFrame: React runs this after the DOM is written
  // and before paint, so the reader never sees the shifted frame. A rAF lands at least one
  // paint later — one visible jump, and on iOS often several.
  //
  // Keyed on the two values that change the mounted slice — they ARE the commit — so there
  // is no tick to remember to bump. `anchorRef` is the guard: it is written only by
  // handleLoadMore and cleared here, so a commit with nothing pending does nothing.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const anchor = anchorRef.current;
    if (!el || !anchor) return;
    anchorRef.current = null;
    const target = anchoredScrollTop(anchor, measure(el, anchor.node) || {});
    if (target != null) el.scrollTop = target;
    // One reading for both flags, so the scroll handler does not fire a second correction
    // a moment later on the position this one just chose.
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    isAtBottomRef.current = distance < 8;
    setShowScrollBottom(distance > 140);
  }, [visibleBytes, topId]);

  // Open on a turn: the host answers a hydrate with a byte-measured tail, and one agentic
  // turn can run past that budget — a reopened chat then mounts a column of cards with no
  // prompt above them. Bounded, so a log whose turns all sit behind one window cannot
  // fetch itself to death; scroll-up still reaches the rest.
  useEffect(() => {
    const paged = autoPagedRef.current;
    // A pane repointed at another chat starts its budget over.
    if (paged.sessionId !== sessionId) { paged.sessionId = sessionId; paged.n = 0; }
    if (paged.n >= MAX_AUTO_PAGES) return;
    // Only on a settled hydrate — mid-hydrate the window still belongs to the old log.
    if (hydrating || !synced) return;
    if (!opensMidTurn(messages, hiddenCount, hasOlder)) return;
    paged.n += 1;
    handleLoadMore();
  }, [sessionId, messages, hiddenCount, hasOlder, hydrating, synced, handleLoadMore]);

  // Optimized scroll handler using requestAnimationFrame
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
      // Auto-load older turns as user scrolls near top
      if (el.scrollTop < LOAD_MORE_THRESHOLD_PX && (hiddenCount > 0 || hasOlder)) {
        handleLoadMore();
      }
    });
  }, [handleLoadMore, hiddenCount, hasOlder]);

  // Paging sentinel observer — fires when user scrolls up into the threshold.
  // Gated on !isAtBottomRef to prevent an infinite loop on initial paint when scrollTop is 0.
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

  // Structure, not content: changes when a step APPEARS (a new segment, tool, diff or
  // prose block), not while text streams into one that already exists. Auto-scroll keys
  // on this — scrolling per delta made the pane impossible to read upward, since every
  // keystroke of the agent's reply yanked the view back to the bottom.
  const structureKey = useMemo(
    () => messages.map((m) => `${m.id}:${m.thinking ? 1 : 0}:${m.content ? 1 : 0}:${m.tools?.length || 0}:${m.diffs?.length || 0}:${m.permission ? 1 : 0}`).join("|"),
    [messages]
  );

  // Ref callbacks are re-run on every render when they are re-created, so both live in refs
  // of their own: a callback that changes identity detaches and re-attaches the node each
  // pass, and on a streaming turn that is once per token.
  // Slot 0 is where a fetch takes its anchor node from — see topRef. On the element
  // itself, so React keeps it current without anything being recomputed at render time.
  const slot0Ref = useCallback((n) => { topRef.current = n; }, []);

  // Smart auto-scroll: only when the user is already at the bottom. A new step scrolls
  // into view; a growing one does not.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !isAtBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [structureKey]);

  // Soft keyboard, rotation, safe-area change: the container shrinks but scrollTop does
  // not, so the tail slides down under the composer and the user types blind. Re-pin
  // while they were already at the bottom; leave a reader who scrolled up where they are.
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

  // A turn scrolled into view is history, not a turn being watched — its cards open
  // collapsed so paging in old turns mounts rows instead of every output they hold.
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
          // An unanswered hydrate is not an empty chat. The empty state offers starter
          // prompts and past conversations — all of which a chat that already has history
          // would be lying about, so nothing is shown until the host has answered.
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
              // Slot 0 is the anchor: the top of the mounted window, which is exactly where
              // a page lands above. Nothing to recompute — it is a function of position, and
              // position is what the DOM already knows.
              // A user prompt stays a bubble of its own; everything the agent did in
              // response is one foldable turn under it. A window that starts mid-turn
              // has no prompt to show, so the whole thing is the turn.
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

      {/* Floating Scroll to Bottom button */}
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