"use client";

import { memo, useRef, useEffect, useState, useCallback, useMemo } from "react";
import { useAiStore } from "@/shared/stores/aiStore";
import { MessageBubble } from "./MessageBubble";
import { ENGINE_INFO } from "../constants";
import { ArrowDown, Pencil } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { agentIconUrl } from "@/features/terminal/constants/agentCli";

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
                src={agentIconUrl(engine)}
                alt={engineMeta.label}
                className="w-7 h-7 object-contain"
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