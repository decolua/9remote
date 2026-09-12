"use client";

import { memo, useRef, useEffect, useState, useCallback, useMemo } from "react";
import { useAiStore } from "@/shared/stores/aiStore";
import { MessageBubble } from "./MessageBubble";
import { ENGINE_INFO, AI_TURN_VERBS, AI_TURN_VERB_INTERVAL_MS } from "../constants";
import { ArrowDown, Check, Loader2, Pencil } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { agentIconUrl, AGENT_ICON_CLS } from "@/features/terminal/constants/agentCli";

const EMPTY_MESSAGES = [];
// Dynamic byte budget per slice: adapts flexibly to message sizes. Long turns (diffs/code)
// stop early to keep DOM light; short turns ("ok", "yes") pack multiple exchanges.
const PAGE_BUDGET_BYTES = 32 * 1024; // 32 KB per load slice
const LOAD_MORE_THRESHOLD_PX = 120;

function estimateMessageBytes(msg) {
  if (!msg) return 0;
  let bytes = (msg.content?.length || 0) + (msg.thinking?.length || 0);
  if (Array.isArray(msg.tools)) {
    for (const t of msg.tools) {
      bytes += (t.command?.length || 0) + (t.output?.length || 0) + 120;
    }
  }
  if (Array.isArray(msg.diffs)) {
    for (const d of msg.diffs) {
      bytes += (d.diff?.length || 0) + (d.file?.length || 0) + 80;
    }
  }
  return Math.max(bytes, 100);
}

function countMessagesByBudget(messages, budgetBytes, minCount = 2) {
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  let accumulated = 0;
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    accumulated += estimateMessageBytes(messages[i]);
    count++;
    if (accumulated >= budgetBytes && count >= minCount) break;
  }
  return count;
}

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

// Token counts follow the CLI's shorthand: 1234 → 1.2k, 1234567 → 1.2M
function formatTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(v);
}

// Hosts report usage only at the end of a turn, so the live count would sit still and
// then jump. Estimate the running text instead (~4 chars/token) and let the real number
// replace it — the same trick the CLIs use to make the counter tick while streaming.
const ESTIMATED_CHARS_PER_TOKEN = 4;

function estimateTokens(text) {
  return Math.round((text?.length || 0) / ESTIMATED_CHARS_PER_TOKEN);
}

// The turn's own token count. Hidden until there is something to report.
function tokenReadout(outputTokens) {
  if (!outputTokens) return null;
  return (
    <>
      <span className="text-text-muted/60"> · </span>
      {formatTokens(outputTokens)} token
    </>
  );
}

// The turn's own line, at the tail of the history like the user's message: the running
// spinner and the finished summary are states of one row, so nothing jumps when it ends.
const AiTurnStatus = memo(function AiTurnStatus({ sessionId }) {
  const isTurnRunning = useAiStore((s) => s.bySession[sessionId]?.isTurnRunning);
  const turnStartedAt = useAiStore((s) => s.bySession[sessionId]?.turnStartedAt);
  const stats = useAiStore((s) => s.bySession[sessionId]?.stats);
  const turnBaseline = useAiStore((s) => s.bySession[sessionId]?.turnBaseline);
  const lastMsg = useAiStore((s) => {
    const list = s.bySession[sessionId]?.messages;
    return list && list.length > 0 ? list[list.length - 1] : null;
  });

  // The host reports a session-running total; the line shows only this turn's share.
  const turnOutput = Math.max(0, (stats?.outputTokens || 0) - (turnBaseline?.outputTokens || 0));

  const [now, setNow] = useState(Date.now());
  const [verbIdx, setVerbIdx] = useState(0);

  useEffect(() => {
    if (!isTurnRunning) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const verbTimer = setInterval(
      () => setVerbIdx((i) => (i + 1) % AI_TURN_VERBS.length),
      AI_TURN_VERB_INTERVAL_MS
    );
    return () => { clearInterval(timer); clearInterval(verbTimer); };
  }, [isTurnRunning]);

  // Freeze the summary against the same clock the live line used. Tokens and span are
  // both session-running totals, so they only ever climb — a resumed or rebuilt pane
  // keeps counting from where the host says the conversation already is.
  const [finished, setFinished] = useState(null);
  const prevRunningRef = useRef(isTurnRunning);
  useEffect(() => {
    if (prevRunningRef.current && !isTurnRunning && turnStartedAt) {
      const end = Date.now();
      setFinished({
        ms: end - turnStartedAt,
        doneAt: new Date(end),
        outputTokens: turnOutput
      });
    }
    if (isTurnRunning) setFinished(null);
    prevRunningRef.current = isTurnRunning;
  }, [isTurnRunning, turnStartedAt, turnOutput]);

  if (!isTurnRunning && !finished) return null;

  if (!isTurnRunning) {
    return (
      <div className="flex items-center gap-2 py-1 select-none text-xs text-text-muted">
        <Check size={14} className="text-emerald-400 shrink-0" />
        <span className="truncate font-mono text-[11px]">
          Worked for <span className="text-text">{formatDuration(finished.ms)}</span>
          <span className="text-text-muted/60"> · </span>
          done {pad2(finished.doneAt.getHours())}:{pad2(finished.doneAt.getMinutes())}
          {tokenReadout(finished.outputTokens)}
        </span>
      </div>
    );
  }

  const activeTool = lastMsg?.tools?.find((t) => t.status === "running");
  // The host's number lags the stream, so the live count is the last reported total plus
  // an estimate of what has arrived since. turn_complete replaces it with the real one.
  const liveOutput = turnOutput + estimateTokens(lastMsg?.content);

  return (
    <div className="flex items-center gap-2 py-1 select-none text-xs text-text-muted">
      <Loader2 size={13} className="animate-spin text-brand-500 shrink-0" />
      <span className="truncate font-mono text-[11px] ai-sheen-text">
        {activeTool ? (
          <>
            Running {activeTool.name}: {activeTool.command || activeTool.path || ""}
          </>
        ) : (
          <>{AI_TURN_VERBS[verbIdx]}…</>
        )}
        <span className="text-text-muted/60"> · </span>
        {formatDuration(now - (turnStartedAt || now))}
        {tokenReadout(liveOutput)}
      </span>
    </div>
  );
});

export const AiMessagesList = memo(function AiMessagesList({
  sessionId,
  engine = "claude",
  workspacePath = "",
  onSendPrompt,
  onResolvePermission,
  onRewind,
  hasOlder = false,
  onLoadOlder
}) {
  const scrollRef = useRef(null);
  // Marks the top of the mounted window — watched so paging also fires on first paint
  // (a tap on the header, a resize) and not only on a scroll gesture.
  const sentinelRef = useRef(null);
  const isAtBottomRef = useRef(true);
  const scrollTimerRef = useRef(null);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [visibleBytes, setVisibleBytes] = useState(PAGE_BUDGET_BYTES);

  // Subscribe ONLY to messages of this session
  const messages = useAiStore((s) => s.bySession[sessionId]?.messages) || EMPTY_MESSAGES;
  const engineMeta = ENGINE_INFO[engine] || ENGINE_INFO.claude;

  // A history rebuilt from the host log is a different list — start from the tail again
  useEffect(() => { setVisibleBytes(PAGE_BUDGET_BYTES); }, [sessionId]);

  const visibleCount = useMemo(
    () => countMessagesByBudget(messages, visibleBytes),
    [messages, visibleBytes]
  );

  const hiddenCount = Math.max(0, messages.length - visibleCount);
  const visibleMessages = hiddenCount > 0 ? messages.slice(hiddenCount) : messages;

  // Prepending shifts everything down; anchor on the old scrollHeight so the turn the
  // user was reading stays put.
  const handleLoadMore = useCallback(async () => {
    const el = scrollRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    const prevTop = el?.scrollTop ?? 0;
    // The in-RAM window grows first; past its end the older turns still live on the host.
    // The byte budget is measured from the END, so a freshly prepended chunk is hidden by
    // the same pagination that was showing the tail until the budget moves too.
    if (hiddenCount === 0 && hasOlder) await onLoadOlder?.();
    setVisibleBytes((b) => b + PAGE_BUDGET_BYTES);
    requestAnimationFrame(() => {
      if (el) el.scrollTop = prevTop + (el.scrollHeight - prevHeight);
    });
  }, [hiddenCount, hasOlder, onLoadOlder]);

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

  // Smart auto-scroll: only scroll if user hasn't scrolled up
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !isAtBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  const scrollToBottom = useCallback(() => {
    vibrate();
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    isAtBottomRef.current = true;
    setShowScrollBottom(false);
  }, []);

  const handleRewind = useCallback((messageId, newText) => {
    vibrate();
    onRewind?.(messageId, newText);
  }, [onRewind]);

  return (
    <div className="flex-1 min-h-0 relative flex flex-col overflow-hidden">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="ai-conversation flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 py-4 space-y-4 custom-scrollbar relative"
      >
        {(hiddenCount > 0 || hasOlder) && <div ref={sentinelRef} aria-hidden="true" className="h-px" />}
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 select-none">
            <div
              className="w-12 h-12 rounded-2xl flex items-center justify-center mb-3 shadow-md border border-border-subtle/40 backdrop-blur-sm"
              style={{ backgroundColor: `${engineMeta.color}15` }}
            >
              <img
                src={agentIconUrl(`${engine}-ui`)}
                alt={engineMeta.label}
                className={`w-7 h-7 object-contain ${AGENT_ICON_CLS}`}
              />
            </div>
            <h3 className="text-base font-semibold text-text mb-1">
              {engineMeta.label}
            </h3>
            <p className="text-xs text-text-muted max-w-sm mb-4 leading-relaxed">
              {engineMeta.desc}. Ask questions, request code edits, or run terminal commands.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2 max-w-md">
              <button
                type="button"
                onClick={() => onSendPrompt?.("/doctor")}
                className="px-2.5 py-1 rounded-full bg-surface-2 hover:bg-surface-3 text-[11px] text-text font-mono border border-border-subtle transition-colors"
              >
                /doctor
              </button>
              <button
                type="button"
                onClick={() => onSendPrompt?.("Explain this codebase structure")}
                className="px-2.5 py-1 rounded-full bg-surface-2 hover:bg-surface-3 text-[11px] text-text font-mono border border-border-subtle transition-colors"
              >
                Explain codebase structure
              </button>
              <button
                type="button"
                onClick={() => onSendPrompt?.("git status")}
                className="px-2.5 py-1 rounded-full bg-surface-2 hover:bg-surface-3 text-[11px] text-text font-mono border border-border-subtle transition-colors"
              >
                ! git status
              </button>
            </div>
          </div>
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
            {visibleMessages.map((msg) => (
              <MessageBubble
                key={msg.id}
                message={msg}
                engine={engine}
                workspacePath={workspacePath}
                onResolvePermission={onResolvePermission}
                onRewind={onRewind}
              />
            ))}
            <AiTurnStatus sessionId={sessionId} />
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