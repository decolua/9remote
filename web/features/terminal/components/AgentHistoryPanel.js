"use client";

import { useState } from "react";
import { ChevronRight, History, ExternalLink, Trash2 } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";
import { agentIconUrl, AGENT_ICON_CLS } from "@/features/terminal/constants/agentCli";
import { useAgentSessions } from "../hooks/useAgentSessions";
import { AGENT_HISTORY_MAX_HEIGHT } from "../constants/terminalConfig";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import AgentHistoryModal from "@/shared/components/ui/AgentHistoryModal";

const SIDEBAR_HISTORY_LIMIT = 40;

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
export default function AgentHistoryPanel({
  busRef,
  cwd,
  onResume,
  onSelectSession,
  liveSessionIds,
  activeSessionId,
  connected = true,
  variant = "section"
}) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [deletingSession, setDeletingSession] = useState(null);
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

  const shown = asList ? sessions : sessions.slice(0, SIDEBAR_HISTORY_LIMIT);
  const hasMore = !asList && sessions.length > SIDEBAR_HISTORY_LIMIT;

  const handleConfirmDelete = () => {
    if (!deletingSession) return;
    const { agent, sessionId } = deletingSession;
    vibrate();

    const nextSessions = (sessions || []).filter((s) => !(s.agent === agent && s.sessionId === sessionId));
    useTerminalStore.getState().setAgentHistory(cwd, nextSessions);

    busRef?.current?.emit("deleteAgentSession", { agent, sessionId, cwd }, (res) => {
      if (!res?.success) {
        busRef?.current?.emit("getAgentSessions", { cwd }, (r) => {
          if (Array.isArray(r?.sessions)) useTerminalStore.getState().setAgentHistory(cwd, r.sessions);
        });
      }
    });

    setDeletingSession(null);
  };

  return (
    <>
      <div
        className={asList ? "flex-1 min-h-0 flex flex-col" : "flex-shrink-0 border-t border-border-subtle pt-1 flex flex-col"}
        style={asList ? undefined : { maxHeight: collapsed ? undefined : AGENT_HISTORY_MAX_HEIGHT }}
      >
        {!asList && (
          <div className="w-full pl-1 pr-1 py-0.5 flex items-center justify-between text-text-subtle">
            <button
              onClick={() => { vibrate(); setCollapsed((c) => !c); }}
              className="flex items-center gap-1 hover:text-text transition-colors flex-1 min-w-0"
            >
              <ChevronRight size={12} className={`flex-shrink-0 transition-transform duration-150 ${collapsed ? "" : "rotate-90"}`} />
              <History size={11} className="flex-shrink-0" />
              <span className="text-[11px] font-medium uppercase truncate">{t("agentHistory.title")}</span>
              <span className="ml-1 text-[10px] tabular-nums opacity-60">({sessions.length})</span>
            </button>
            <button
              onClick={() => { vibrate(); setModalOpen(true); }}
              className="p-1 hover:text-text hover:bg-surface-2 rounded transition-colors text-text-subtle"
              title={t("agentHistory.manageHistory")}
              aria-label={t("agentHistory.manageHistory")}
            >
              <ExternalLink size={12} />
            </button>
          </div>
        )}

        {(asList || !collapsed) && (
          <div className={`overflow-y-auto modal-scrollable min-h-0 ${asList ? "flex-1 px-1.5 pb-2" : ""}`}>
            {shown.map((row) => {
              // The host tags the terminal already running this conversation — a chat
              // UI session included, since the host records its conversation too — so
              // an open row focuses that terminal instead of resuming a second copy.
              const openId = row.openSessionId && liveSessionIds?.has(row.openSessionId)
                ? row.openSessionId
                : null;
              const isActive = !!openId && openId === activeSessionId;
              const title = row.title || t("agentHistory.untitled");

              return (
                <div
                  key={`${row.agent}:${row.sessionId}`}
                  className={`group relative w-full flex items-center gap-1 text-left transition-colors rounded-brand hover:bg-text/5 ${
                    asList ? "gap-2 px-2.5 py-1.5" : "pl-3 pr-1 py-px"
                  } ${isActive ? "bg-text/8" : ""}`}
                >
                  <button
                    onClick={() => { vibrate(); if (openId) onSelectSession?.(openId); else onResume?.(row); }}
                    disabled={!connected}
                    className={`flex items-center gap-1.5 flex-1 min-w-0 text-left transition-colors disabled:opacity-40 hover:text-text touch-manipulation touch-pan-y ${
                      asList ? "gap-2.5" : ""
                    } ${openId ? "text-text font-medium" : "text-text-muted"}`}
                    title={`${title} · ${row.agent}${openId ? ` · ${t("agentHistory.openNow")}` : ""}`}
                  >
                    <img
                      src={agentIconUrl(row.mode === "ui" ? `${row.agent}-ui` : row.agent)}
                      alt={row.agent}
                      className={`flex-shrink-0 ${AGENT_ICON_CLS} ${asList ? "w-4 h-4" : "w-2.5 h-2.5"} ${openId ? "" : "opacity-70"}`}
                    />
                    <span className={`truncate flex-1 min-w-0 ${asList ? "text-sm" : "text-[11px]"}`} data-tip={title}>
                      {title}
                    </span>
                    {/* The time is the row's last in-flow item; the ExplorerRow door
                        floats the delete button over it on hover with a backdrop. */}
                    <span className={`text-[10px] text-text-subtle flex-shrink-0 opacity-70 tabular-nums whitespace-nowrap ${asList ? "mr-1" : ""}`}>
                      {relativeAge(row.updatedAt, t)}
                    </span>
                  </button>

                  {asList ? (
                    <button
                      onClick={(e) => { e.stopPropagation(); setDeletingSession(row); }}
                      disabled={!connected || !!openId}
                      className={`flex-shrink-0 p-1 rounded-[4px] text-text-subtle transition-colors hover:bg-red-500/15 hover:text-red-400 opacity-60 hover:opacity-100 ${openId ? "invisible" : ""}`}
                      title={openId ? t("agentHistory.openNow") : t("agentHistory.delete")}
                      aria-label={t("agentHistory.delete")}
                    >
                      <Trash2 size={14} />
                    </button>
                  ) : (
                    <button
                      onClick={(e) => { e.stopPropagation(); setDeletingSession(row); }}
                      disabled={!connected || !!openId}
                      className={`absolute right-1 top-1/2 -translate-y-1/2 pl-1.5 pr-0.5 rounded-[4px] bg-surface-2 text-text-subtle group-hover:text-red-400 hover:bg-red-500/15 transition-colors opacity-0 group-hover:opacity-100 ${openId ? "invisible" : ""}`}
                      title={openId ? t("agentHistory.openNow") : t("agentHistory.delete")}
                      aria-label={t("agentHistory.delete")}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              );
            })}

            {hasMore && (
              <button
                onClick={() => { vibrate(); setModalOpen(true); }}
                className="w-full py-1.5 px-2 mt-1 mb-0.5 flex items-center justify-center gap-1.5 text-[10px] font-medium text-text-subtle hover:text-text bg-surface-2/50 hover:bg-surface-2 border border-border-subtle/50 rounded transition-all"
              >
                <History size={11} className="opacity-60" />
                <span>{t("agentHistory.showAll")} ({sessions.length})</span>
              </button>
            )}
          </div>
        )}
      </div>

      {modalOpen && (
        <AgentHistoryModal
          isOpen={modalOpen}
          onClose={() => setModalOpen(false)}
          busRef={busRef}
          cwd={cwd}
          onResume={onResume}
          onSelectSession={onSelectSession}
          liveSessionIds={liveSessionIds}
          activeSessionId={activeSessionId}
          connected={connected}
        />
      )}

      {deletingSession && (
        <ConfirmDialog
          isOpen={true}
          onClose={() => setDeletingSession(null)}
          onConfirm={handleConfirmDelete}
          title={t("agentHistory.deleteTitle")}
          message={t("agentHistory.deleteMessage", { title: deletingSession.title || t("agentHistory.untitled") })}
        />
      )}
    </>
  );
}
