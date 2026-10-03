"use client";

import { memo, useEffect, useMemo, useState } from "react";
import { Bot, Terminal, Square, Loader2 } from "@/shared/components/ui/Icon";
import { agentIconUrl, AGENT_ICON_CLS } from "@/features/terminal/constants/agentCli";
import { vibrate } from "@/shared/utils/vibration";
import { useAiStore } from "@/shared/stores/aiStore";
import { findTaskTool } from "../../lib/toolTree";
import { taskElapsedMs } from "../../lib/harnessTasks";
import { clockText } from "../../lib/taskClock";
import { MessageBubble } from "../MessageBubble";
import { AiTurn } from "../AiTurn";
import { renderToolCard } from "../cards/toolCards";
import { AiToolCard } from "../cards/AiToolCard";
import { ModalShell } from "./ModalShell";

// The modal's own beat, so the header's total keeps moving while it is open. One timer
// for the whole panel — every row reads the same `now`.
const TICK_MS = 1000;

function TaskIcon({ background = false, engine = "claude", size = 16, className = "" }) {
  if (background) {
    return <Terminal size={size} className={className || "text-text"} />;
  }
  const iconSrc = agentIconUrl(engine);
  if (iconSrc) {
    return (
      <img
        src={iconSrc}
        alt={engine}
        draggable={false}
        style={{ width: size, height: size }}
        className={`flex-shrink-0 object-contain ${AGENT_ICON_CLS} ${className}`}
      />
    );
  }
  return <Bot size={size} className={className || "text-text"} />;
}

/**
 * Everything a pinned strip row could not say, drawn the way the agent itself is drawn.
 *
 * The strip names the work; this modal walks it: a chip per task when the tap
 * stood for several, then the task's own calls as the TIMELINE's tool cards — a
 * sub-agent's internals read here exactly as they do in the turn (its agent card even
 * draws its nested calls itself), and a background shell's card IS the command with its
 * output. Nothing else on the page: no stat tiles, no meta line — the cards are the
 * information, the modal is just the page they sit on.
 */
export const AgentTaskModal = memo(function AgentTaskModal({
  tasks = [],
  messages = [],
  engine = "claude",
  sessionId = "",
  onStopTask,
  onClose
}) {
  const [now, setNow] = useState(() => Date.now());
  // Which task the panel is showing. `null` follows the group: until the reader picks one,
  // the panel shows the task it was opened for — or, that one gone, whatever is left.
  const [picked, setPicked] = useState(null);
  const stored = useAiStore((s) => s.bySession[sessionId]?.harnessTasks);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  // The store is the authority on status: a task that ended while this panel was open is
  // ended, and the copy handed in at the tap is stale the moment the CLI says so. A task
  // the store does not hold (a session it never loaded) keeps the copy it came with.
  const live = useMemo(
    () => tasks.map((t) => stored?.find((h) => h.taskId === t.taskId) || t),
    [tasks, stored]
  );
  const task = live.find((t) => t.taskId === picked) || live[0];
  if (!task) return null;
  const elapsed = taskElapsedMs(task, now);
  const running = !task.endedAt && (task.status === "running" || task.status === "paused");

  return (
    <ModalShell
      icon={<TaskIcon background={task.background} engine={engine} size={16} />}
      iconClass=""
      title={task.description || task.subagentType || "Task"}
      subtitle={running ? `Running for ${clockText(elapsed)}` : `Ended · ${clockText(elapsed)}`}
      onClose={onClose}
      actions={running && task.taskId && onStopTask ? (
        <button
          type="button"
          onClick={() => { vibrate(); onStopTask(task.taskId); }}
          className="px-2.5 py-1 rounded-brand text-xs font-medium text-danger bg-danger/10 hover:bg-danger/20 transition-colors flex items-center gap-1.5"
          title="Stop this task"
        >
          <Square size={10} className="fill-current" />
          <span>Stop</span>
        </button>
      ) : null}
    >
      {/* Tabs when there are multiple tasks in the session */}
      {live.length > 1 && (
        <div className="px-4 py-2 border-b border-border-subtle bg-bg flex items-center gap-1 overflow-x-auto custom-scrollbar shrink-0">
          {live.map((t, i) => {
            const on = t.taskId === task.taskId;
            return (
              <button
                key={t.taskId || t.id || i}
                type="button"
                onClick={() => { vibrate(); setPicked(t.taskId); }}
                className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-brand text-xs transition-colors ${
                  on
                    ? "bg-surface-2 text-text font-medium"
                    : "text-text-muted hover:text-text hover:bg-surface-2/40"
                }`}
              >
                <TaskIcon background={t.background} engine={engine} size={13} className={on ? "opacity-100" : "opacity-60"} />
                <span className="truncate max-w-[140px]">
                  {t.description || t.subagentType || t.taskId}
                </span>
                <span className="font-mono text-[10px] opacity-60 tabular-nums">
                  {t.status === "running" ? clockText(taskElapsedMs(t, now)) : t.status}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* The task's card IS the interface — the very card the main timeline draws for
          it, bungled open: its header, its calls (a sub-agent's card draws those
          itself), its command and output (a background shell's card). */}
      <div className="p-3 flex-1 overflow-y-auto custom-scrollbar">
        <Calls task={task} messages={messages} engine={engine} running={running} />

        {task.summary && (
          <p className="mt-3 text-[11px] text-text-muted leading-relaxed">
            {task.summary}
          </p>
        )}

        {task.outputFile && (
          <p className="mt-3 font-mono text-[10px] text-text-subtle truncate" title={task.outputFile}>
            output · {task.outputFile}
          </p>
        )}
      </div>
    </ModalShell>
  );
});

/**
 * The task's work as the CLI itself prints it: prompt bubble, then its calls as flat
 * card rows — same cards the main timeline draws, but without the turn rail around
 * them, so the modal's narrow column keeps one level of indentation (a card's own
 * output border) instead of a staircase of nested rails.
 *
 * A background shell is a list of one: its card is the command with its output, and it
 * has no prompt bubble (nobody asked it anything).
 */
function Calls({ task, messages, engine, running }) {
  const row = findTaskTool(messages, task.toolUseId);
  if (!row) {
    return (
      <div className="flex flex-col items-center justify-center gap-2.5 py-14 text-text-muted select-none">
        {running ? (
          <>
            <Loader2 size={24} className="animate-spin text-brand-500 opacity-80" />
            <div className="text-center">
              <div className="text-xs font-medium text-text">Task is running...</div>
              <div className="text-[11px] text-text-subtle mt-0.5">Waiting for task calls or tool events</div>
            </div>
          </>
        ) : (
          <>
            <TaskIcon background={task.background} engine={engine} size={28} className="opacity-40" />
            <div className="text-center">
              <div className="text-xs font-medium text-text">No calls recorded</div>
              <div className="text-[11px] text-text-subtle mt-0.5">This task ended without child tool calls</div>
            </div>
          </>
        )}
      </div>
    );
  }
  const calls = row.children?.length ? row.children : [row];
  const prompt = row.input?.prompt || row.input?.description || "";
  const report = row.error || row.output || "";
  return (
    <div className="flex flex-col">
      {prompt && !row.async && (
        <MessageBubble message={{ id: `${row.id}:p`, role: "user", content: prompt }} engine={engine} />
      )}
      {calls.map((c) =>
        renderToolCard(engine, c, { deferred: !running, workspacePath: "" }) || (
          <AiToolCard key={c.id} {...c} engine={engine} workspacePath="" deferred={!running} />
        )
      )}
      {!running && report && (
        <AiTurn messages={[{ id: `${row.id}:r`, role: "assistant", content: String(report), isLive: false }]} engine={engine} isLive={false} />
      )}
    </div>
  );
}
