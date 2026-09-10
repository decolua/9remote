"use client";

import { memo, useRef, useEffect, useState, useCallback } from "react";
import { useAiStore } from "@/shared/stores/aiStore";
import { MessageBubble } from "./MessageBubble";
import { ENGINE_INFO } from "../constants";
import { ArrowDown, Pencil } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { agentIconUrl } from "@/features/terminal/constants/agentCli";

const EMPTY_MESSAGES = [];

export const AiMessagesList = memo(function AiMessagesList({
  sessionId,
  engine = "claude",
  onSendPrompt,
  onResolvePermission,
  onRewind
}) {
  const scrollRef = useRef(null);
  const isAtBottomRef = useRef(true);
  const scrollTimerRef = useRef(null);
  const [showScrollBottom, setShowScrollBottom] = useState(false);

  // Subscribe ONLY to messages of this session
  const messages = useAiStore((s) => s.bySession[sessionId]?.messages || EMPTY_MESSAGES);
  const engineMeta = ENGINE_INFO[engine] || ENGINE_INFO.claude;

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
          messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              onResolvePermission={onResolvePermission}
              onRewind={onRewind}
            />
          ))
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