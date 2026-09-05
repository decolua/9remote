"use client";

import { useEffect, useRef, useState } from "react";
import { useSortable } from "@dnd-kit/react/sortable";
import { Pencil, Trash2 } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { statusVisual } from "@/shared/utils/statusVisual";
import { vibrate } from "@/shared/utils/vibration";
import { useWorkspaceGit } from "@/features/terminal/hooks/useWorkspaceGit";
import { useConnectionStore } from "@/shared/stores/connectionStore";
import { shortenHomePath } from "@/features/terminal/lib/workspaceGrouping";
import { MAX_CHANGED_BADGE } from "@/features/terminal/constants/terminalConfig";

// The tail of a path carries the meaning (the leaf folder), so overflow trims the
// HEAD, not the tail. Width comes from the flexed span, so no pixel constants.
let _measureCtx = null;
function TailTruncate({ text, title, style, className = "" }) {
  const ref = useRef(null);
  const [head, setHead] = useState(0); // chars dropped from the front
  useEffect(() => {
    const el = ref.current;
    if (!el || el.clientWidth < 10) return;
    const fit = () => {
      if (!_measureCtx) _measureCtx = document.createElement("canvas").getContext("2d");
      _measureCtx.font = getComputedStyle(el).font;
      const avail = el.clientWidth;
      if (_measureCtx.measureText(text).width <= avail) return setHead(0);
      let h = 1;
      while (h < text.length && _measureCtx.measureText(`…${text.slice(h)}`).width > avail) h++;
      setHead(h);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);
  return (
    <span ref={ref} title={title ?? text} style={style} className={`truncate ${className}`}>
      {head ? `…${text.slice(head)}` : text}
    </span>
  );
}


// One terminal, one mini terminal window: titlebar with the classic dots, fake prompt
// body, status riding as a badge. A div, not a button: the titlebar actions cannot
// nest inside one. Hold starts a drag-reorder (dnd-kit); right-click opens the sheet.
export default function SessionCard({
  session, index, status, hasNotification, connected: propConnected,
  onSelect, onLongPress, onRename, onDelete,
  cwd, fileBus, homeDir, shellCount = 1
}) {
  const { t } = useI18n();
  const storeConnected = useConnectionStore((s) => s.connected);
  const connected = propConnected ?? storeConnected;
  const state = status?.state || "idle";
  const visual = statusVisual(state);
  // Live checkout of where the terminal actually sits, not of its fixed workspace root —
  // a `cd` into another worktree has to show that worktree's branch.
  const gitPath = cwd || session.workspacePath || null;
  const { branch, dirty, changedCount } = useWorkspaceGit(gitPath, fileBus, { enabled: connected });
  const basePath = session.workspacePath || null;
  // Prompt path: relative to the workspace root while inside it, ~-shortened outside.
  const promptPath = !gitPath ? "~"
    : basePath && gitPath === basePath ? "~"
    : basePath && gitPath.startsWith(`${basePath}/`) ? gitPath.slice(basePath.length + 1)
    : shortenHomePath(gitPath, homeDir) || "~";

  const { ref, isDragging } = useSortable({ id: session.id, index });

  return (
    <div
      ref={ref}
      onClick={() => { if (connected && !isDragging) { vibrate(); onSelect(session.id); } }}
      onContextMenu={(e) => { if (onLongPress) { e.preventDefault(); onLongPress(session); } }}
      className={`group relative select-none rounded-xl ${isDragging ? "opacity-70" : ""} ${
        connected ? "cursor-pointer active:scale-[0.98] hover:-translate-y-1" : "opacity-60"
      }`}
    >
      {/* Terminal window */}
      <div
        className={`rounded-xl overflow-hidden border ring-1 ${state !== "idle" ? `status-border-${state}` : ""}`}
        style={{
          background: connected ? "var(--card-term-bg)" : "var(--card-term-bg-off)",
          borderColor: "var(--card-border)",
          boxShadow: "var(--card-shadow)",
          ["--tw-ring-color"]: "var(--card-ring)"
        }}
      >
        {/* Titlebar */}
        <div
          className="flex items-center gap-2 px-2.5 py-1.5 border-b"
          style={{ background: "var(--card-titlebar-bg)", borderColor: "var(--card-titlebar-border)" }}
        >
          <div className={`flex items-center gap-1 flex-shrink-0 ${connected ? "" : "opacity-40 saturate-0"}`}>
            <span className="w-[7px] h-[7px] rounded-full bg-[#ff5f57]" />
            <span className="w-[7px] h-[7px] rounded-full bg-[#febc2e]" />
          </div>
          <span className="flex-1 min-w-0 text-center text-[11px] font-medium truncate" style={{ color: "var(--card-name-fg)" }} title={session.name || t("terminal.defaultName")}>
            {session.name || t("terminal.defaultName")}
          </span>
          <div className="flex items-center gap-2 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
            {onRename && (
              <button
                type="button"
                onClick={() => { vibrate(); onRename(session); }}
                disabled={!connected}
                className="p-1.5 rounded-md transition-colors hover:bg-amber-500/10 disabled:cursor-not-allowed"
                style={{ color: connected ? "var(--card-accent-amber)" : "var(--card-btn-disabled)" }}
                aria-label={t("sessions.editName")}
                title={t("sessions.editName")}
              >
                <Pencil size={16} />
              </button>
            )}
            {onDelete && (
              <button
                type="button"
                onClick={() => { vibrate(); onDelete(session); }}
                disabled={!connected}
                className="p-1.5 rounded-md transition-colors hover:bg-red-500/15 disabled:cursor-not-allowed"
                style={{ color: connected ? "var(--card-accent-red)" : "var(--card-btn-disabled)" }}
                aria-label={t("sessions.deleteTitle")}
                title={t("common.delete")}
              >
                <Trash2 size={16} />
              </button>
            )}
          </div>
        </div>

        {/* Body — fake terminal */}
        <div className="relative px-3 py-3 font-mono min-h-[128px]">
          {state !== "idle" && (
            <span
              className={`absolute top-1.5 right-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium ${visual.cls}`}
              style={{ background: `${visual.dot}22`, color: visual.dot }}
            >
              <span className={`w-1.5 h-1.5 rounded-full term-dot${visual.pulse ? ` pulse-${visual.pulse}` : ""}`} style={{ background: visual.dot }} />
              {t(visual.label)}
            </span>
          )}
          {/* Unread output on a terminal the user isn't looking at */}
          {hasNotification && (
            <span className="absolute top-1.5 left-1.5 w-2 h-2 rounded-full bg-brand-500" />
          )}
          <div className="text-[11.5px] leading-[1.7] space-y-0.5">
            <div className="flex items-center min-w-0">
              <span className="flex-shrink-0" style={{ color: "var(--card-accent-green)" }}>➜</span>
              {/* A bare "~" row says nothing — fall back to the session name to fill it */}
              {promptPath === "~" || !promptPath ? (
                <>
                  <span className="flex-shrink-0 mx-1" style={{ color: "var(--card-accent-cyan)" }}>~</span>
                  <span className="truncate" style={{ color: "var(--card-body-fg)" }}>{session.name || t("terminal.defaultName")}</span>
                </>
              ) : (
                <TailTruncate text={promptPath} title={gitPath || undefined} style={{ color: "var(--card-accent-cyan)" }} className="flex-1 min-w-0 mx-1" />
              )}
            </div>
            {connected ? (
              <>
                {branch && (
                  <div className="flex items-center min-w-0 gap-1.5" style={{ color: "var(--card-body-dim)" }}>
                    <span className="flex items-center min-w-0">
                      <span className="flex-shrink-0" style={{ color: "var(--card-accent-amber)" }}>⎇</span>
                      <span className="ml-1 truncate" title={branch}>{branch}{dirty ? "*" : ""}</span>
                    </span>
                    {changedCount > 0 && (
                      <span className="flex-shrink-0 px-1 leading-tight bg-brand-500/15 text-brand-400 rounded-[2px] font-medium">
                        {changedCount > MAX_CHANGED_BADGE ? `${MAX_CHANGED_BADGE}+` : changedCount}
                      </span>
                    )}
                  </div>
                )}
                {session.createdAt && (
                  <div className="truncate" style={{ color: "var(--card-body-dim)" }}>
                    <span style={{ color: "var(--card-accent-amber)" }}>●</span> {t("sessions.created", { time: new Date(session.createdAt).toLocaleTimeString(undefined, { hour12: false }) })}
                    {shellCount > 1 && session.shellId ? ` · ${session.shellId}` : ""}
                  </div>
                )}
              </>
            ) : (
              <div className="truncate" style={{ color: "var(--card-body-dim)", opacity: 0.7 }}>
                <span style={{ color: "var(--card-accent-red)" }}>✕</span> disconnected
              </div>
            )}
            <div className="flex items-center min-w-0">
              <span className="flex-shrink-0" style={{ color: "var(--card-accent-green)" }}>➜</span>
              <span className="inline-block flex-shrink-0 ml-1.5 w-[7px] h-[14px] animate-pulse" style={{ background: "var(--card-accent-green)", opacity: 0.8 }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
