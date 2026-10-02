"use client";

import { memo, useEffect, useMemo, useState } from "react";
import { Bot, Terminal, Square } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useAiStore } from "@/shared/stores/aiStore";
import { findTaskTool } from "../../lib/toolTree";
import { taskElapsedMs } from "../../lib/harnessTasks";
import { clockText } from "../../lib/taskClock";
import { MessageBubble } from "../MessageBubble";
import { AiTurn } from "../AiTurn";
import { ModalShell } from "./ModalShell";

// The modal's own beat, so the header's total keeps moving while it is open. One timer
// for the whole panel — every row reads the same `now`.
const TICK_MS = 1000;

const KIND = {
  agent: { label: "Sub-agent", icon: Bot, cls: "bg-accent/15 text-accent" },
  shell: { label: "Background task", icon: Terminal, cls: "bg-warning/15 text-warning" }
};

/**
 * Everything a pinned strip row could not say, drawn the way the agent itself is drawn.
 *
 * The strip names the work; this modal walks it: a pickable row per task when the tap
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
  const meta = KIND[task.background ? "shell" : "agent"];
  const Icon = meta.icon;

  return (
    <ModalShell
      icon={<Icon size={14} />}
      iconClass={meta.cls}
      title={task.description || task.subagentType || "Task"}
      subtitle={running ? `Running for ${clockText(elapsed)}` : `Ended · ${clockText(elapsed)}`}
      onClose={onClose}
      footer={running && task.taskId && onStopTask ? (
        <div className="px-3 py-2.5 border-t border-border-subtle bg-bg shrink-0">
          <button
            type="button"
            onClick={() => { vibrate(); onStopTask(task.taskId); }}
            className="w-full flex items-center justify-center gap-1.5 py-2 rounded-brand text-xs font-semibold text-danger bg-danger/10 hover:bg-danger/20 transition-colors"
          >
            <Square size={11} />
            Stop this task
          </button>
        </div>
      ) : null}
    >
      {/* One row per task in the group, the same pickable row every modal list uses. A
          single task draws no picker — a list of one is a heading over nothing. */}
      {live.length > 1 && (
        <div className="p-3 pb-0 flex flex-col gap-0.5 shrink-0 border-b border-border-subtle">
          {live.map((t, i) => {
            const m = KIND[t.background ? "shell" : "agent"];
            const RowIcon = m.icon;
            const on = t.taskId === task.taskId;
            return (
              <button
                key={t.taskId || t.id || i}
                type="button"
                onClick={() => { vibrate(); setPicked(t.taskId); }}
                className={`modal-row ${on ? "modal-row-active" : ""}`}
              >
                <RowIcon size={14} className={`shrink-0 ${on ? "text-brand-500" : "text-text-muted"}`} />
                <span className={`flex-1 min-w-0 truncate text-xs ${on ? "text-text font-medium" : "text-text-muted"}`}>
                  {t.description || t.subagentType || t.taskId}
                </span>
                <span className="text-[10px] font-mono text-text-subtle shrink-0">
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
          <p className="mt-3 text-[11px] text-text-muted leading-relaxed border-l-2 border-border-subtle pl-3">
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
 * The task's work as the SAME conversation the main pane draws: its prompt as a user
 * bubble, its calls as a turn (AiTurn's rail — the very renderer the main timeline
 * uses, cards full width), and its report as prose. Nothing here is a second rendering
 * of a piece the pane already draws — it IS the pane's renderer, fed the task's slice.
 *
 * A background shell is a turn of one: its card is the command with its output, and it
 * has no prompt bubble (nobody asked it anything).
 */
function Calls({ task, messages, engine, running }) {
  const row = findTaskTool(messages, task.toolUseId);
  if (!row) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-10 text-text-muted">
        <span className="text-xs">{running ? "Working — no calls yet." : "No calls recorded."}</span>
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
      <AiTurn messages={[{ id: row.id, role: "assistant", tools: calls, isLive: running }]} engine={engine} isLive={running} />
      {!running && report && (
        <AiTurn messages={[{ id: `${row.id}:r`, role: "assistant", content: String(report), isLive: false }]} engine={engine} isLive={false} />
      )}
    </div>
  );
}
