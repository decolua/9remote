"use client";

import { memo, useRef, useEffect, useState, useCallback } from "react";
import { useAiStore } from "@/shared/stores/aiStore";
import { MessageBubble } from "./MessageBubble";
import { ENGINE_INFO } from "../constants";
import { ArrowDown, Pencil } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { agentIconUrl } from "@/features/terminal/constants/agentCli";

const EMPTY_MESSAGES = [];
// Long histories get expensive to render: only the newest slice is mounted, the rest
// paged in on demand. The data is already client-side (the hydrate replays the whole
// event log) — this trims DOM, it does not fetch from the host.
const PAGE_SIZE = 30;
// Reveal the next page this far from the top, so older turns are there before you land
const LOAD_MORE_THRESHOLD_PX = 120;

export const AiMessagesList = memo(function AiMessagesList({
  sessionId,
  engine = "claude",
  onSendPrompt,
  onResolvePermission,
  onRewind
}) {
  const scrollRef = useRef(null);
  // Marks the top of the mounted window — watched so paging also fires on first paint
  // (a tap on the header, a resize) and not only on a scroll gesture.
  const sentinelRef = useRef(null);
  const isAtBottomRef = useRef(true);
  const scrollTimerRef = useRef(null);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // Subscribe ONLY to messages of this session
  const messages = useAiStore((s) => s.bySession[sessionId]?.messages) || EMPTY_MESSAGES;
  const engineMeta = ENGINE_INFO[engine] || ENGINE_INFO.claude;

  // A history rebuilt from the host log is a different list — start from the tail again
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [sessionId]);

  const hiddenCount = Math.max(0, messages.length - visibleCount);
  const visibleMessages = hiddenCount > 0 ? messages.slice(hiddenCount) : messages;

  // Prepending shifts everything down; anchor on the old scrollHeight so the turn the
  // user was reading stays put.
  const handleLoadMore = useCallback(() => {
    const el = scrollRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    const prevTop = el?.scrollTop ?? 0;
    setVisibleCount((c) => Math.min(c + PAGE_SIZE, messages.length));
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = prevTop + (el.scrollHeight - prevHeight);
    });
  }, [messages.length]);

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
    });
  }, []);

  // Paging on approach, not on gesture: the sentinel sits at the top of the mounted
  // window, so an intersection covers first paint, resize, and scroll alike. rootMargin
  // preloads a page before it is reached. Re-armed whenever the window grows, so a
  // container still shorter than the viewport keeps advancing instead of stalling.
  useEffect(() => {
    const root = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) handleLoadMore(); },
      { root, rootMargin: `${LOAD_MORE_THRESHOLD_PX}px` }
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [handleLoadMore, visibleCount, messages.length]);

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
        className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 py-4 space-y-4 custom-scrollbar relative"
      >
        {hiddenCount > 0 && <div ref={sentinelRef} aria-hidden="true" className="h-px" />}
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
            {hiddenCount > 0 && (
              <button
                type="button"
                onClick={() => { vibrate(); handleLoadMore(); }}
                className="w-full py-1.5 text-[11px] font-mono text-text-muted hover:text-text bg-surface-2/50 hover:bg-surface-2 border border-border-subtle/60 rounded-brand transition-colors"
              >
                Load older · {hiddenCount} more
              </button>
            )}
            {visibleMessages.map((msg) => (
              <MessageBubble
                key={msg.id}
                message={msg}
                engine={engine}
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