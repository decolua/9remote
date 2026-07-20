"use client";

import { useEffect, useRef, useState } from "react";
import { Bell, Bot, X } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { AGENT_LABELS, AGENT_ICONS } from "../constants/agentLabels";

// Compact relative time (e.g. "now", "3m", "2h", "1d")
const timeAgo = (ts) => {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

// Notifications bell + badge + dropdown list. Shown on desktop only (hidden sm:flex);
// mobile keeps using the slide-out menu. Reads from sessionStatus (already on TerminalHeader).
export default function NotificationsBell({ sessions = [], allSessions = [], sessionStatus = {}, onSwitchSession }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  // done/blocked = need user attention; working is live, idle is nothing
  const items = Object.entries(sessionStatus)
    .map(([id, st]) => ({ id, ...st }))
    .filter((it) => it.state === "done" || it.state === "blocked")
    .sort((a, b) => (b.since || 0) - (a.since || 0));
  const count = items.length;

  // Resolve name from the full session list so cross-group notifications show
  // their real name instead of a truncated id.
  const nameOf = (id) => allSessions.find((s) => s.id === id)?.name || sessions.find((s) => s.id === id)?.name || id.slice(0, 8);

  // Close on outside click / Escape
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("touchstart", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("touchstart", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const handlePick = (id) => {
    setOpen(false);
    onSwitchSession?.(id);
  };

  return (
    <div ref={wrapRef} className="relative hidden sm:flex flex-shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative p-1.5 bg-surface-2 hover:bg-surface-3 text-text rounded-brand transition-all duration-150 ease-out active:scale-[0.94]"
        title={t("notifications.title")}
      >
        <Bell size={18} />
        {count > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-brand-500 text-white text-[10px] font-bold flex items-center justify-center">
            {count > 9 ? "9+" : count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 bg-surface-2 border border-border-subtle rounded-brand-lg shadow-lg w-72 max-h-[60vh] overflow-y-auto flex flex-col">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle flex-shrink-0">
            <span className="text-sm font-semibold">{t("notifications.title")}</span>
            <button
              onClick={() => setOpen(false)}
              className="p-1 text-text-muted hover:text-text rounded transition-colors"
              title={t("common.close")}
            >
              <X size={14} />
            </button>
          </div>

          {!items.length ? (
            <p className="px-3 py-6 text-center text-sm text-text-muted">{t("notifications.empty")}</p>
          ) : (
            <div className="flex flex-col">
              {items.map((it) => {
                const blocked = it.state === "blocked";
                return (
                  <button
                    key={it.id}
                    onClick={() => handlePick(it.id)}
                    className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-surface-3 text-left transition-colors"
                    title={nameOf(it.id)}
                  >
                    {AGENT_ICONS[it.tool] ? (
                      <img src={AGENT_ICONS[it.tool]} alt={it.tool} className="w-5 h-5 flex-shrink-0" />
                    ) : (
                      <Bot size={18} className="text-brand-500 flex-shrink-0" />
                    )}
                    <span className="flex-1 min-w-0 flex flex-col">
                      <span className="text-sm font-medium truncate">{nameOf(it.id)}</span>
                      <span className="text-xs text-text-muted truncate">
                        {AGENT_LABELS[it.tool] || t("notifications.agent")}
                        {" · "}
                        {blocked ? t("notifications.needsInput") : t("notifications.replied")}
                      </span>
                    </span>
                    <span className="text-[11px] text-text-muted flex-shrink-0">{timeAgo(it.since)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
