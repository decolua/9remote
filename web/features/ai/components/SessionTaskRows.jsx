"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, Loader2 } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useAiStore } from "@/shared/stores/aiStore";
import { useTreeCollapse } from "@/features/hosts/lib/treeCollapse";
import { foldTaskRecords, runningTasks, taskElapsedMs } from "../lib/harnessTasks";
import { clockText } from "../lib/taskClock";
import { reduceSessionEvents } from "../hooks/useAiSession";
import { AgentTaskModal } from "./modals/AgentTaskModal";

// One beat for every clock on the rows, none when nothing runs.
const TICK_MS = 1000;
// While the steps modal is open, how often the host is asked whether the log moved.
const PEEK_MS = 2000;

const labelOf = (t) => t.description || t.subagentType || "task";

/**
 * A session's running sub-agents and background shells, as rows under its tree row.
 *
 * The strip above the chat (AiAgentStrip) answers "what is running" for the OPEN pane;
 * this answers it for every session from the sidebar, read-only: records arrive on the
 * sessionTasks bus lane and fold through the same reader (lib/harnessTasks), so the row
 * never invents its own task spelling. Collapsed it is one summary line; expanded, one
 * row per task — and a tap hydrates that session's log (ai:create ack, the same snapshot
 * a pane replays) to open the very modal the strip opens, without the stop button.
 */
export default function SessionTaskRows({ sessionId = "", records = null, engine = "claude", mobile = false, hostKey = "", busRef = null }) {
  const tasks = useMemo(() => runningTasks(foldTaskRecords(records, null)), [records]);
  const { isCollapsed, toggle } = useTreeCollapse(hostKey);
  // The collapse store's set is reused as a persisted "pinned open" marker — its name
  // says collapsed, but default here must be CLOSED, so presence means expanded.
  const nodeKey = `tasks:${sessionId}`;
  const open = isCollapsed(nodeKey);

  const [now, setNow] = useState(() => Date.now());
  const [modalOpen, setModalOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const seqRef = useRef(0);
  // A pane already holding this session has the LIVE log with the sub-agent tree the
  // CLI's transcript cannot rebuild (sub-agents write their own files — see the poll
  // below). Its messages outrank anything fetched here.
  const storedMessages = useAiStore((s) => (s.bySession[sessionId]?.messages?.length ? s.bySession[sessionId].messages : null));
  const liveMessages = storedMessages || messages;

  useEffect(() => {
    if (tasks.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [tasks.length]);

  // Steps advance while the modal is open: read the log once, then poll the cheap seq
  // read and re-read the window only when the host says it moved. Wholesale replace on
  // every read — no incremental apply, so no double-apply against a pane the same
  // session may have open elsewhere. Skipped entirely while a live pane feeds us.
  useEffect(() => {
    if (!modalOpen || storedMessages) return;
    let dead = false;
    const hydrate = () => {
      busRef?.current?.emit("ai:create", { sessionId, engine }, (res) => {
        if (dead || !res?.ok || !Array.isArray(res.session?.events)) return;
        seqRef.current = res.session.seq || 0;
        setMessages(reduceSessionEvents(res.session.events, engine).messages);
      });
    };
    hydrate();
    const timer = setInterval(() => {
      busRef?.current?.emit("ai:peekSeq", { sessionId }, (res) => {
        if (res?.ok && typeof res.seq === "number" && res.seq > seqRef.current) hydrate();
      });
    }, PEEK_MS);
    return () => { dead = true; clearInterval(timer); };
  }, [modalOpen, storedMessages, busRef, sessionId, engine]);

  if (tasks.length === 0) return null;

  const agents = tasks.filter((t) => !t.background);
  const shells = tasks.filter((t) => t.background);
  // The oldest task carries the clock: "how long has this been going" is about the
  // whole hand-off, not its newest arrival (same rule as the strip's rows).
  const oldest = tasks.reduce((a, t) => (t.startedAt && (!a?.startedAt || t.startedAt < a.startedAt) ? t : a), null);

  const summary = [
    agents.length ? `${agents.length} agent${agents.length > 1 ? "s" : ""}` : null,
    shells.length ? `${shells.length} bg` : null
  ].filter(Boolean).join(" · ");

  const rowPad = mobile ? "pl-[38px] pr-3 py-1.5" : "pl-[26px] pr-2 py-1";

  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); vibrate(); toggle(nodeKey); }}
        className={`w-full flex items-center gap-1.5 ${rowPad} text-left ${mobile ? "text-[13px]" : "text-[11px]"} text-text-muted hover:text-text transition-colors`}
        aria-expanded={open}
      >
        <ChevronRight size={mobile ? 14 : 11} className={`flex-shrink-0 text-text-subtle transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
        <Loader2 size={mobile ? 13 : 11} className="flex-shrink-0 animate-spin text-brand-500" />
        <span className="truncate min-w-0 flex-1">{summary}</span>
        <span className="font-mono text-[10px] text-text-subtle shrink-0 tabular-nums">
          {oldest?.startedAt ? clockText(taskElapsedMs(oldest, now)) : ""}
        </span>
      </button>

      {open && tasks.map((t) => (
        <button
          key={t.taskId}
          type="button"
          onClick={(e) => { e.stopPropagation(); vibrate(); setModalOpen(true); }}
          title={labelOf(t)}
          className={`w-full flex items-center gap-1.5 ${rowPad} text-left ${mobile ? "text-[13px]" : "text-[11px]"} text-text-muted hover:text-text transition-colors`}
        >
          <span className="flex-shrink-0 invisible" aria-hidden="true"><ChevronRight size={mobile ? 14 : 11} /></span>
          <Loader2 size={mobile ? 13 : 11} className={`flex-shrink-0 animate-spin ${t.background ? "text-warning" : "text-brand-500"}`} />
          <span className="truncate min-w-0 flex-1">{labelOf(t)}</span>
          <span className="font-mono text-[10px] text-text-subtle shrink-0 tabular-nums">
            {t.startedAt ? clockText(taskElapsedMs(t, now)) : ""}
          </span>
        </button>
      ))}

      {modalOpen && typeof document !== "undefined" && createPortal(
        <AgentTaskModal
          tasks={tasks}
          messages={liveMessages}
          engine={engine}
          sessionId={sessionId}
          onClose={() => setModalOpen(false)}
        />,
        document.body
      )}
    </>
  );
}
