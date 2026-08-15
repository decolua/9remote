"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Shimmer from "@/shared/components/ui/Shimmer";
import { ChevronDown } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";
import { useAgentChat } from "@/features/agentChat/hooks/useAgentChat";
import { groupActivity } from "@/features/agentChat/lib/transcript";
import { PROMPT_KINDS, CONTENT_MAX_WIDTH } from "@/features/agentChat/constants/agentChatConfig";
import UserMessage from "./UserMessage";
import AssistantMessage from "./AssistantMessage";
import ThinkingRow from "./ThinkingRow";
import ToolCallRow from "./ToolCallRow";
import ToolGroupRow from "./ToolGroupRow";
import PermissionCard from "./PermissionCard";
import QuestionCard from "./QuestionCard";
import PlanCard from "./PlanCard";
import ChatComposer from "./ChatComposer";

const NEAR_BOTTOM_PX = 60;

/**
 * A second view of the same PTY: hook telemetry as a conversation, and the CLI's
 * blocking prompts as buttons. The terminal underneath stays the source of truth.
 */
export default function AgentChatPane({ socket, sessionId, isVisible, onOpenFile, className = "" }) {
  const { t } = useI18n();
  const {
    prompt, activity, optionCount, tool, stale, error, respond, sendText, interrupt,
  } = useAgentChat(socket, sessionId, { enabled: isVisible });

  const listRef = useRef(null);
  const [pinned, setPinned] = useState(true);

  const rows = useMemo(() => groupActivity(activity), [activity]);
  const isBusy = activity.some((e) => e.kind === "tool" && e.status === "running");

  // Follow new output only while the user is already at the bottom — yanking them down
  // mid-read is worse than a missed line.
  useEffect(() => {
    if (!pinned) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows, prompt, pinned]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    setPinned(el.scrollHeight - el.clientHeight - el.scrollTop <= NEAR_BOTTOM_PX);
  };

  const scrollToBottom = () => {
    vibrate();
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setPinned(true);
  };

  const renderPrompt = () => {
    if (!prompt) return null;
    // Remount on a new prompt id so a card never carries the previous question's selection.
    // `key` must be written literally — React ignores it inside a spread.
    const k = prompt.promptId;
    const shared = { prompt, onRespond: respond, busy: false };
    if (prompt.kind === PROMPT_KINDS.QUESTION) return <QuestionCard key={k} {...shared} />;
    if (prompt.kind === PROMPT_KINDS.PLAN) return <PlanCard key={k} {...shared} optionCount={optionCount} />;
    return <PermissionCard key={k} {...shared} />;
  };

  return (
    <div className={`chat-pane flex flex-col overflow-hidden rounded-sm bg-surface ${className}`}>
      <div className="login-mobile-glow pointer-events-none" aria-hidden />

      <div
        ref={listRef}
        onScroll={onScroll}
        className="scroll-thin-x relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 pt-3 sm:px-0"
      >
        <div className="mx-auto w-full space-y-2" style={{ maxWidth: CONTENT_MAX_WIDTH }}>
          {rows.length === 0 && !prompt && (
            <p className="py-8 text-center font-mono text-[11px] text-text-subtle">
              {t("terminalPane.agentChatEmpty")}
            </p>
          )}

          {rows.map((row) => {
            if (row.type === "userPrompt") return <UserMessage key={row.key} text={row.entry.text} />;
            if (row.type === "assistantText") return <AssistantMessage key={row.key} text={row.entry.text} tool={tool} />;
            if (row.type === "thinking") return <ThinkingRow key={row.key} text={row.entry.text} />;
            if (row.type === "group") return <ToolGroupRow key={row.key} row={row} onOpenFile={onOpenFile} />;
            if (row.type === "tool") return <ToolCallRow key={row.key} entry={row.entry} onOpenFile={onOpenFile} />;
            return null;
          })}

          {isBusy && !prompt && (
            <div className="chat-row inline-flex items-center gap-2 rounded-full border border-border-subtle bg-surface-2/60 px-3 py-1.5 font-mono text-[11px] text-text-muted">
              <span className="h-1.5 w-1.5 animate-pulse-glow rounded-full bg-brand-500" />
              <Shimmer>{t("terminalPane.agentChatThinking")}</Shimmer>
              <span className="inline-block h-[13px] w-[7px] animate-cursor-blink bg-brand-500 align-middle" />
            </div>
          )}

          {prompt && <div className="chat-row pb-1 pt-1">{renderPrompt()}</div>}

          {stale && (
            <p className="rounded-[8px] bg-surface-2 px-3 py-2 text-[11px] text-text-muted">
              {t("terminalPane.agentChatStaleNotice")}
            </p>
          )}
          {error && (
            <p className="rounded-[8px] bg-danger/10 px-3 py-2 font-mono text-[11px] text-danger">{error}</p>
          )}

          <div className="h-2" />
        </div>
      </div>

      {!pinned && (
        <button
          type="button"
          onClick={scrollToBottom}
          aria-label={t("terminalPane.agentChatScrollToBottom")}
          className="absolute bottom-24 left-1/2 z-10 grid h-8 w-8 -translate-x-1/2 place-items-center rounded-full bg-surface-2 text-text shadow-md transition-all duration-150 hover:bg-surface-3 active:scale-[0.94]"
        >
          <ChevronDown size={16} />
        </button>
      )}

      <ChatComposer
        onSend={sendText}
        onInterrupt={interrupt}
        busy={isBusy}
        // The CLI is blocked on a selector — free text would be swallowed by it.
        disabled={!!prompt}
      />
    </div>
  );
}
