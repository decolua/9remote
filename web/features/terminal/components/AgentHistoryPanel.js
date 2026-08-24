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
export default function AgentHistoryPanel({ socketRef, cwd, onResume, onSelectSession, connected = true }) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);
  const sessions = useAgentSessions(socketRef, cwd);

  if (!cwd || !sessions?.length) return null;

  const shown = sessions.slice(0, AGENT_HISTORY_ROWS);

  return (
    <div
      className="flex-shrink-0 border-t border-border-subtle pt-1 flex flex-col"
      style={{ maxHeight: collapsed ? undefined : AGENT_HISTORY_MAX_HEIGHT }}
    >
      <button
        onClick={() => { vibrate(); setCollapsed((c) => !c); }}
        className="w-full pl-1 pr-2 py-0.5 flex items-center gap-1 text-text-subtle hover:text-text transition-colors"
      >
        <ChevronRight size={12} className={`flex-shrink-0 transition-transform duration-150 ${collapsed ? "" : "rotate-90"}`} />
        <History size={11} className="flex-shrink-0" />
        <span className="text-[11px] font-medium uppercase truncate">{t("agentHistory.title")}</span>
        <span className="ml-auto text-[10px] tabular-nums opacity-60">{sessions.length}</span>
      </button>

      {!collapsed && (
      <div className="overflow-y-auto modal-scrollable min-h-0">
      {shown.map((row) => {
        // Already live in a terminal: jumping to it beats resuming a second copy.
        const openId = row.openSessionId;
        return (
        <button
          key={`${row.agent}:${row.sessionId}`}
          onClick={() => { vibrate(); openId ? onSelectSession?.(openId) : onResume?.(row); }}
          disabled={!connected}
          className={`group w-full flex items-center gap-1.5 pl-3.5 pr-2 py-px text-left transition-colors disabled:opacity-40 hover:bg-text/5 hover:text-text ${
            openId ? "text-text font-medium bg-text/[0.04]" : "text-text-muted"
          }`}
          title={`${row.title || t("agentHistory.untitled")} · ${row.agent}${openId ? ` · ${t("agentHistory.openNow")}` : ""}`}
        >
          <img
            src={agentIconUrl(row.agent)}
            alt={row.agent}
            className={`w-2.5 h-2.5 rounded-[2px] flex-shrink-0 ${openId ? "" : "opacity-70"}`}
          />
          <span className="text-[11px] truncate flex-1 min-w-0">{row.title || t("agentHistory.untitled")}</span>
          {openId ? (
            <span className="w-1.5 h-1.5 rounded-full bg-brand-500 flex-shrink-0" title={t("agentHistory.openNow")} />
          ) : (
            <span className="text-[10px] text-text-subtle flex-shrink-0 opacity-0 group-hover:opacity-70 tabular-nums">
              {relativeAge(row.updatedAt, t)}
            </span>
          )}
        </button>
        );
      })}

      </div>
      )}
    </div>
  );
}
