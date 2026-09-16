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
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { vibrate } from "@/shared/utils/vibration";

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
  // A row that names a file is a door to it — the file was changed by a route the diff
  // card cannot see (a shell command), so this row is the only place the pane says so.
  if (notice.file) {
    return (
      <button
        type="button"
        onClick={() => { vibrate(); useTerminalStore.getState().openEditorFile(notice.file); }}
        className={`${cls} block w-full text-left hover:bg-surface-3 transition-colors cursor-pointer`}
        title={notice.file}
      >
        {notice.content}
      </button>
    );
  }
  return <div className={cls}>{notice.content}</div>;
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
