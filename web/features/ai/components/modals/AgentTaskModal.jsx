"use client";

import { memo, useEffect, useMemo, useState } from "react";
import { Loader2, Bot, Terminal, Square, CheckCircle2, AlertCircle, History } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useAiStore } from "@/shared/stores/aiStore";
import { taskActivity, findTaskTool } from "../../lib/toolTree";
import { describeActivity, formatTokens } from "../../lib/liveStatus";
import { taskElapsedMs } from "../../lib/harnessTasks";
import { clockText, usageDurationMs } from "../../lib/taskClock";
import { renderToolCard } from "../cards/toolCards";
import { AiToolCard } from "../cards/AiToolCard";
import { ModalShell } from "./ModalShell";
import { anchorId } from "../PaneScope";

// The modal's own beat, so the header's total keeps moving while it is open. One timer
// for the whole panel — every row reads the same `now`.
const TICK_MS = 1000;

const KIND = {
  agent: { label: "Sub-agent", icon: Bot, cls: "bg-accent/15 text-accent" },
  shell: { label: "Background task", icon: Terminal, cls: "bg-warning/15 text-warning" }
};

// A task's status in the harness's own words, tinted by whether it is still going.
const STATUS_CLS = {
  running: "bg-sky-500/15 text-sky-400",
  completed: "bg-emerald-500/15 text-emerald-400",
  failed: "bg-danger/15 text-danger",
  killed: "bg-danger/15 text-danger",
  stopped: "bg-surface-2 text-text-muted",
  paused: "bg-warning/15 text-warning"
};

/**
 * Everything a pinned strip row could not say.
 *
 * The strip is a heading: it names the work and how long it has been going. This is the
 * page behind it — what the task was asked to do, what it is doing at this second, every
 * call it has made, and what it cost. Rows for the whole group when the strip row stood
 * for several tasks, so one tap answers "what are all of these".
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
  const statusCls = STATUS_CLS[task.status] || (running ? STATUS_CLS.running : STATUS_CLS.stopped);

  return (
    <ModalShell
      icon={<History size={14} />}
      iconClass="bg-brand-500/15 text-brand-500"
      title={running ? `Running for ${clockText(elapsed)}` : `Ended · ${clockText(elapsed)}`}
      subtitle={`${live.length} task${live.length > 1 ? "s" : ""} handed off`}
      onClose={onClose}
    >
      {/* One row per task in the group. A single task draws no picker — a list of one is
          a heading over nothing. */}
      {live.length > 1 && (
        <div className="flex gap-1 px-3 py-2 border-b border-border-subtle overflow-x-auto custom-scrollbar shrink-0">
          {live.map((t) => {
            const meta = KIND[t.background ? "shell" : "agent"];
            const Icon = meta.icon;
            const on = t.taskId === task.taskId;
            return (
              <button
                key={t.taskId}
                type="button"
                onClick={() => { vibrate(); setPicked(t.taskId); }}
                className={`flex items-center gap-1.5 shrink-0 px-2 py-1 rounded-full text-[11px] transition-colors ${
                  on ? "bg-brand-500/15 text-brand-400 font-semibold" : "text-text-muted hover:text-text hover:bg-surface-2"
                }`}
              >
                <Icon size={11} className="shrink-0" />
                <span className="max-w-[18ch] truncate">{t.description || t.subagentType || t.taskId}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="flex-1 overflow-y-auto custom-scrollbar">
        <Head task={task} elapsed={elapsed} statusCls={statusCls} />

        <div className="p-3">
          <Activity task={task} messages={messages} engine={engine} />

          {/* The task's own calls, newest first — the same cards the timeline draws, so a
              sub-agent's internals read here exactly as they do in the turn. */}
          <Calls task={task} messages={messages} engine={engine} sessionId={sessionId} />

          {/* What the CLI charged the task, in its own units. Only ever what the record
              actually carried: a completed task reports these, a running one does not. */}
          {task.usage && (
            <div className="flex flex-wrap gap-2 mt-3">
              <Stat label="TOKENS" value={formatTokens(task.usage.total_tokens)} />
              <Stat label="TOOLS" value={task.usage.tool_uses ?? 0} />
              {usageDurationMs(task.usage) > 0 && <Stat label="TOOK" value={clockText(usageDurationMs(task.usage))} />}
            </div>
          )}

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
      </div>

      {running && task.taskId && onStopTask && (
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
      )}
    </ModalShell>
  );
});

/** The one-line answer: what it is, what it was asked, and the clock. */
function Head({ task, elapsed, statusCls }) {
  const meta = KIND[task.background ? "shell" : "agent"];
  const Icon = meta.icon;
  return (
    <div className="px-4 py-3 border-b border-border-subtle flex items-start gap-3">
      <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${meta.cls}`}>
        <Icon size={15} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-text truncate">{task.description || task.subagentType || "task"}</span>
          <span className={`text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded ${statusCls}`}>
            {task.status}
          </span>
        </div>
        <div className="flex items-center gap-2 mt-1 text-[11px] text-text-muted font-mono flex-wrap">
          <span>{meta.label}</span>
          {task.subagentType && <><Dot /><span className="text-brand-500">{task.subagentType}</span></>}
          {task.taskType && <><Dot /><span>{task.taskType}</span></>}
          <Dot />
          {/* The clock's origin is named, because a number nobody can place is a number
              nobody trusts: the host logs each record with a time, so this counts from
              when the task was ANNOUNCED, not from when this panel was opened. */}
          <span className="text-text tabular-nums" title="since the agent logged the task's start">running {clockText(elapsed)}</span>
          <Dot />
          <span className="text-text-subtle">{task.taskId}</span>
        </div>
      </div>
    </div>
  );
}

/** What it is doing at this second, read off its own deepest running call. */
function Activity({ task, messages, engine }) {
  const node = taskActivity(messages, task.toolUseId);
  const line = describeActivity(node, engine);
  if (!line || !node) return null;
  const failed = node.status === "error";
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-brand bg-surface-2/40 border border-border-subtle/60">
      {task.status === "running" ? (
        <Loader2 size={12} className="animate-spin text-brand-500 shrink-0" />
      ) : failed ? (
        <AlertCircle size={12} className="text-danger shrink-0" />
      ) : (
        <CheckCircle2 size={12} className="text-success shrink-0" />
      )}
      <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted shrink-0">now</span>
      <span className="text-[11px] text-text truncate min-w-0" title={line}>{line}</span>
    </div>
  );
}

/**
 * Every call under the task's own card, as the TIMELINE would draw them.
 *
 * Not a list of my own rows: a sub-agent's diff, command or question already has a card
 * that says it better, and a second rendering here would drift from the one in the turn.
 * So the card is the row, and the generic card is the fallback for a tool with none.
 */
function Calls({ task, messages, engine, sessionId }) {
  const row = findTaskTool(messages, task.toolUseId);
  if (!row) return null;
  // A background shell's row IS the command — it has no children, and the output sitting
  // on it is the whole of what that task has to show. A sub-agent's is the other way
  // round: the card is a heading and the calls under it are the work.
  const calls = row.children?.length ? row.children : [row];
  return (
    <div className="mt-3" id={anchorId(sessionId, "calls", row.id)}>
      <div className="text-[10px] font-mono uppercase tracking-wider text-text-muted mb-1">
        {row.children?.length ? `${row.children.length} call${row.children.length > 1 ? "s" : ""}` : "command"}
      </div>
      {calls.map((c) => renderToolCard(engine, c, { engine }) || <AiToolCard key={c.id} {...c} engine={engine} />)}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="px-2.5 py-1.5 rounded-brand bg-surface-2/40 min-w-[68px]">
      <div className="text-[9px] font-mono text-text-muted tracking-wider">{label}</div>
      <div className="text-xs font-semibold text-text tabular-nums">{value}</div>
    </div>
  );
}

const Dot = () => <span className="text-text-subtle">·</span>;
