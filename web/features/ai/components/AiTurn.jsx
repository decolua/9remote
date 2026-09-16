"use client";

import { memo, useEffect, useRef, useState, useMemo } from "react";
import { AiToolCard } from "./cards/AiToolCard";
import { StepWindow, WINDOW_STEPS } from "./StepWindow";
import { AiDiffCard } from "./cards/AiDiffCard";
import { AiQuestionCard } from "./cards/AiQuestionCard";
import { AiThinkingBlock } from "./cards/AiThinkingBlock";
import { renderToolCard } from "./cards/toolCards";
import { buildTurnRows, splitTurnBlocks } from "../lib/turnRows";
import MarkdownBody from "@/shared/components/ui/MarkdownBody";
import { Loader2 } from "@/shared/components/ui/Icon";

// How often the compaction row's clock ticks. One second: it prints whole seconds, so a
// faster beat would re-render for a number that has not changed.
const COMPACT_CLOCK_MS = 1000;

// The cards are the cards — a tool call renders the same row it always did, so one tap
// opens its output. What this adds is only the *window*: a long run of steps shows its
// tail, and the rest waits behind "N more".
function StepCard({ row, engine, workspacePath, deferred }) {
  if (row.kind === "thought") return <AiThinkingBlock text={row.text} isLive={row.isLive} />;
  // Checked before `row.tool`: a diff row carries no tool, and reading one off it threw.
  if (row.kind === "diff") {
    const d = row.diff;
    return (
      <AiDiffCard
        file={d.file}
        patch={d.patch}
        diff={d.diff}
        content={d.content}
        workspacePath={workspacePath}
      />
    );
  }

  const t = row.tool;
  // A tool family with its own card renders it; everything else is the generic row, which
  // reads any call from its name, input and output.
  return (
    renderToolCard(engine, t, { workspacePath, deferred }) ||
    <AiToolCard {...t} engine={engine} workspacePath={workspacePath} deferred={deferred} />
  );
}

// How long streamed prose holds its last parsed text.
const MARKDOWN_STREAM_MS = 80;

// The parse is O(content) and a streamed answer only grows, so re-parsing per frame
// costs O(content²) over one reply. While the turn is live the text advances on a fixed
// beat; the moment it settles the exact text is parsed once, so nothing is lost.
function useStreamedText(content, isLive) {
  const [shown, setShown] = useState(content);
  const latestRef = useRef(content);

  useEffect(() => { latestRef.current = content; }, [content]);

  useEffect(() => {
    if (!isLive) return;
    const timer = setInterval(() => {
      // Same value bails out of the render — a quiet beat costs nothing.
      setShown((prev) => (prev === latestRef.current ? prev : latestRef.current));
    }, MARKDOWN_STREAM_MS);
    return () => clearInterval(timer);
  }, [isLive]);

  return isLive ? shown : content;
}

// The harness's own levels, styled as the CLI would: dim for a note, amber for a warning,
// red for an error. `suggestion` is the CLI's word for a hint, so it reads like a note.
const NOTICE_CLS = {
  info: "text-text-muted",
  suggestion: "text-text-muted",
  warning: "text-warning",
  error: "text-danger"
};

/**
 * A line the harness asked the timeline to draw — a compaction, a local command, a
 * refused message, an API error. The pane decides nothing here: a record the CLI gave
 * `content` (or a formatted error) is one it means a person to read, and the rest are
 * bookkeeping that never reaches this row (see lib/harnessTasks.noticeFrom).
 */
function NoticeRow({ notice }) {
  if (!notice?.content) return null;
  const cls = `text-xs leading-relaxed py-1 px-2 my-0.5 rounded border-l-2 border-current/30 bg-surface-2/40 wrap-anywhere ${NOTICE_CLS[notice.level] || NOTICE_CLS.info}`;
  // A compaction in flight. The CLI states no progress for it — one status at the start,
  // one record at the end, 20–50s apart — so the row can only say what it is doing, not
  // how far along it is. The clock beside it is the client's own, started when the row
  // appeared; the real duration arrives with the boundary that replaces this row.
  if (notice.compacting) {
    return (
      <div className={`${cls} flex items-center gap-2`}>
        <Loader2 size={12} className="animate-spin text-brand-500 shrink-0" />
        <span>{notice.content}</span>
        <CompactingClock />
      </div>
    );
  }
  // Always a plain line. A row used to become a button when it named a file, for the one
  // notice that did — `edited_text_file`, which no longer draws at all (see
  // lib/harnessTasks.noticeFrom). Nothing produces a notice with a file now, so the door
  // went with it rather than staying wired to an empty hallway.
  return (
    <div className={cls}>
      {notice.content}
      {/* What the compaction cost and saved, in the CLI's own shorthand. Dropped when the
          record carried only its trigger — inventing a number there would be worse than
          the missing one. */}
      {notice.compact?.detail && <span className="text-text-muted"> · {notice.compact.detail}</span>}
      {notice.compact?.durationMs ? <span className="text-text-muted"> · {formatSeconds(notice.compact.durationMs)}</span> : null}
    </div>
  );
}

// Seconds, one decimal below a minute — the CLI reports 22885ms, and rounding that to
// "23s" loses the only precision the row has.
function formatSeconds(ms) {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

// The wait, counted where the wait is being watched. A live region so a screen reader
// is told once that it is running rather than on every tick.
function CompactingClock() {
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), COMPACT_CLOCK_MS);
    return () => clearInterval(timer);
  }, []);
  return <span className="text-text-muted/70 tabular-nums">{formatSeconds(now - startedAt)}</span>;
}

function ProseRow({ content, isLive }) {
  const text = useStreamedText(content, isLive);
  return (
    // wrap-anywhere, not break-words: only `anywhere` shrinks min-content, so a path
    // with no space to break on wraps instead of widening the column into a scrollbar.
    <div className="text-sm leading-relaxed text-text py-1.5 wrap-anywhere">
      <MarkdownBody content={text} />
      {isLive && <span className="inline-block w-1.5 h-3.5 bg-brand-500 animate-pulse ml-1 align-middle" />}
    </div>
  );
}

export const AiTurn = memo(function AiTurn({
  messages = [],
  engine = "claude",
  workspacePath = "",
  onResolvePermission,
  isLive = true
}) {
  const rows = useMemo(() => buildTurnRows(messages, engine), [messages, engine]);
  const blocks = useMemo(
    () => splitTurnBlocks(rows, WINDOW_STEPS, { deferred: !isLive }),
    [rows, isLive]
  );
  return (
    <div className="my-1">
      {blocks.map((b) => {
        if (b.type !== "steps") {
          // Prose sits outside the rail: it is the agent talking to the reader, not a
          // step it took, and indenting it would read as one more thing it did.
          if (b.row.kind === "prose") {
            return <ProseRow key={b.key} content={b.row.content} isLive={b.row.isLive} />;
          }
          if (b.row.kind === "notice") {
            return <NoticeRow key={b.key} notice={b.row.notice} />;
          }
          if (b.row.kind === "permission") {
            const p = b.row.permission;
            return (
              <AiQuestionCard
                key={b.key}
                requestId={p.requestId}
                questions={p.input?.questions || []}
                onResolve={onResolvePermission}
              />
            );
          }
          return null;
        }

        // The rail marks a run of steps as one piece of work, so a long turn still
        // reads as a unit without boxing every card.
        return (
          <div key={b.key} className="relative pl-2.5 border-l-2 border-border-subtle/50 my-1">
            <StepWindow total={b.rows.length}>
              {(hidden) =>
                (hidden > 0 ? b.rows.slice(hidden) : b.rows).map((row) => (
                  <StepCard key={row.id} row={row} engine={engine} workspacePath={workspacePath} deferred={!isLive} />
                ))
              }
            </StepWindow>
          </div>
        );
      })}
    </div>
  );
}, (prev, next) => {
  // `messages` is a freshly sliced array on every store update, so identity alone would
  // fail here and re-render every turn in the log once per streamed token. What matters
  // is whether the message objects themselves moved — a new delta replaces exactly one.
  if (prev.messages.length !== next.messages.length) return false;
  for (let i = 0; i < prev.messages.length; i++) {
    if (prev.messages[i] !== next.messages[i]) return false;
  }
  return (
    prev.engine === next.engine &&
    prev.workspacePath === next.workspacePath &&
    prev.isLive === next.isLive &&
    prev.onResolvePermission === next.onResolvePermission
  );
});
