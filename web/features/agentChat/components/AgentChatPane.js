"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Shimmer from "@/shared/components/ui/Shimmer";
import { ChevronDown } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";
import { useAgentChat } from "@/features/agentChat/hooks/useAgentChat";
import { XtermScreenReader } from "@/features/agentChat/lib/screen/screenReader";
import { detectCli } from "@/features/agentChat/lib/screen/detector";
import { ScreenEventExtractor } from "@/features/agentChat/lib/screen/extractor";
import { useScreenTick } from "@/features/agentChat/hooks/useScreenTick";
import { groupActivity } from "@/features/agentChat/lib/transcript";
import { PROMPT_KINDS, CONTENT_MAX_WIDTH } from "@/features/agentChat/constants/agentChatConfig";
import UserMessage from "./UserMessage";
import AssistantMessage from "./AssistantMessage";
import ThinkingRow from "./ThinkingRow";
import ToolCallRow from "./ToolCallRow";
import ToolGroupRow from "./ToolGroupRow";
import ToolDiffView from "./ToolDiffView";
import PermissionCard from "./PermissionCard";
import QuestionCard from "./QuestionCard";
import PlanCard from "./PlanCard";
import ChatComposer from "./ChatComposer";

const NEAR_BOTTOM_PX = 60;

/**
 * A second view of the same PTY: hook telemetry as a conversation, and the CLI's
 * blocking prompts as buttons. The terminal underneath stays the source of truth.
 */
export default function AgentChatPane({ socket, sessionId, isVisible, onOpenFile, getTerm, className = "" }) {
  const { t } = useI18n();
  const {
    prompt, activity: serverActivity, optionCount, tool, source, live, stale, error, respond, sendText, interrupt, refresh,
  } = useAgentChat(socket, sessionId, { enabled: isVisible });

  const listRef = useRef(null);
  const [pinned, setPinned] = useState(true);

  // Client-side parse: xterm's buffer is the exact, colour-preserving screen. When the
  // agent has no transcript for this CLI, read it here instead of trusting an 8KB mirror.
  const clientTick = useScreenTick(isVisible && source === "screen");
  const activity = useMemo(() => {
    if (source !== "screen" || !getTerm) return serverActivity;
    try {
      const lines = new XtermScreenReader(getTerm()).readLines();
      const profile = detectCli(lines);
      if (!profile) return serverActivity;
      return new ScreenEventExtractor(profile).extract(lines);
    } catch {
      return serverActivity;
    }
    // clientTick is the re-parse cadence: same inputs, newer screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, serverActivity, clientTick, getTerm]);

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
          {source === "screen" && (
            <p className="rounded-[8px] border border-border-subtle bg-surface-2/60 px-3 py-2 text-[11px] text-text-subtle">
              {t("terminalPane.agentChatScreenMode")}
            </p>
          )}

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
            if (row.type === "diff") return <ToolDiffView key={row.key} filePath="" oldContent="" newContent={row.entry.text} isNew={false} />;
            if (row.type === "text") {
              return (
                <div key={row.key} className="chat-row rounded-[8px] border border-border-subtle bg-surface-2/60 px-3 py-2 font-mono text-[11px] whitespace-pre-wrap break-words text-text-muted">
                  {row.entry.text}
                  {row.entry.truncated != null && (
                    <span className="mt-1 block text-[10px] text-text-subtle">
                      +{row.entry.truncated} {t("terminalPane.agentChatTruncatedLines")}
                    </span>
                  )}
                </div>
              );
            }
            return null;
          })}

          {(isBusy || live?.working) && !prompt && (
            <div className="chat-row inline-flex items-center gap-2 rounded-full border border-border-subtle bg-surface-2/60 px-3 py-1.5 font-mono text-[11px] text-text-muted">
              <span className="h-1.5 w-1.5 animate-pulse-glow rounded-full bg-brand-500" />
              <Shimmer>{live?.working ? `${live.working}…` : t("terminalPane.agentChatThinking")}</Shimmer>
              {live?.tool && <span className="text-text-subtle">· {live.tool}</span>}
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
