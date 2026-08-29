"use client";

import { useState } from "react";
import { ChevronRight, History } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";
import { agentIconUrl } from "@/features/terminal/constants/agentCli";
import { useAgentSessions } from "../hooks/useAgentSessions";
import { AGENT_HISTORY_ROWS, AGENT_HISTORY_MAX_HEIGHT } from "../constants/terminalConfig";

// Coarse age of a past conversation — enough to tell today from last week.
function relativeAge(ms, t) {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 60) return t("agentHistory.minutesAgo", { n: Math.max(1, mins) });
  const hours = Math.round(mins / 60);
  if (hours < 24) return t("agentHistory.hoursAgo", { n: hours });
  return t("agentHistory.daysAgo", { n: Math.round(hours / 24) });
}

// Conversations the agent CLIs already hold for the directory the active
// terminal is standing in — resuming one opens a terminal there and types the
// CLI's own resume command, so the transcript comes back rather than restarting.
export default function AgentHistoryPanel({ busRef, cwd, onResume, onSelectSession, liveSessionIds, activeSessionId, connected = true, variant = "section" }) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);
  const sessions = useAgentSessions(busRef, cwd);

  // A modal tab owns its whole panel: it is already a titled, scrolling surface, so
  // it drops the collapsible section header and the height share meant for a sidebar.
  const asList = variant === "list";

  if (!cwd) return null;
  if (!sessions?.length) {
    if (!asList) return null;
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center px-6 py-10 text-center text-sm text-text-muted">
        {t("agentHistory.empty")}
      </div>
    );
  }

  const shown = asList ? sessions : sessions.slice(0, AGENT_HISTORY_ROWS);

  return (
    <div
      className={asList ? "flex-1 min-h-0 flex flex-col" : "flex-shrink-0 border-t border-border-subtle pt-1 flex flex-col"}
      style={asList ? undefined : { maxHeight: collapsed ? undefined : AGENT_HISTORY_MAX_HEIGHT }}
    >
      {!asList && (
      <button
        onClick={() => { vibrate(); setCollapsed((c) => !c); }}
        className="w-full pl-1 pr-2 py-0.5 flex items-center gap-1 text-text-subtle hover:text-text transition-colors"
      >
        <ChevronRight size={12} className={`flex-shrink-0 transition-transform duration-150 ${collapsed ? "" : "rotate-90"}`} />
        <History size={11} className="flex-shrink-0" />
        <span className="text-[11px] font-medium uppercase truncate">{t("agentHistory.title")}</span>
        <span className="ml-auto text-[10px] tabular-nums opacity-60">{sessions.length}</span>
      </button>
      )}

      {(asList || !collapsed) && (
      <div className={`overflow-y-auto modal-scrollable min-h-0 ${asList ? "flex-1 px-1.5 pb-2" : ""}`}>
      {shown.map((row) => {
        // Already live in a terminal: jumping to it beats resuming a second copy.
        // The rows are a snapshot, so a terminal named here may have closed since
        // — treat a vanished one as not open and resume instead of focusing air.
        const openId = row.openSessionId && liveSessionIds?.has(row.openSessionId)
          ? row.openSessionId
          : null;
        // Open in some terminal reads as brighter text; only the row whose
        // terminal is the one on screen takes the selected background, matching
        // how the session list above marks the active terminal.
        const isActive = !!openId && openId === activeSessionId;
        return (
        <button
          key={`${row.agent}:${row.sessionId}`}
          onClick={() => { vibrate(); if (openId) onSelectSession?.(openId); else onResume?.(row); }}
          disabled={!connected}
          className={`group w-full flex items-center gap-1.5 text-left transition-colors disabled:opacity-40 hover:bg-text/5 hover:text-text ${
            asList ? "gap-2.5 px-2.5 py-2 rounded-brand" : "pl-3.5 pr-2 py-px"
          } ${openId ? "text-text font-medium" : "text-text-muted"} ${isActive ? "bg-text/8" : ""}`}
          title={`${row.title || t("agentHistory.untitled")} · ${row.agent}${openId ? ` · ${t("agentHistory.openNow")}` : ""}`}
        >
          <img
            src={agentIconUrl(row.agent)}
            alt={row.agent}
            className={`rounded-[2px] flex-shrink-0 ${asList ? "w-4 h-4" : "w-2.5 h-2.5"} ${openId ? "" : "opacity-70"}`}
          />
          <span className={`truncate flex-1 min-w-0 ${asList ? "text-sm" : "text-[11px]"}`} data-tip={row.title || t("agentHistory.untitled")}>{row.title || t("agentHistory.untitled")}</span>
          {/* Out of flow until hovered: reserving room for an age nobody is reading
              cost the title characters on every row. A touch surface has no hover,
              so the list variant keeps the age on screen instead. */}
          <span className={`text-[10px] text-text-subtle flex-shrink-0 opacity-70 tabular-nums whitespace-nowrap ${asList ? "" : "hidden group-hover:inline"}`}>
            {relativeAge(row.updatedAt, t)}
          </span>
        </button>
        );
      })}

      </div>
      )}
    </div>
  );
}
