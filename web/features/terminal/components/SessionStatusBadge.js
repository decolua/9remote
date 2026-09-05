"use client";

import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { statusVisual } from "@/shared/utils/statusVisual";
import { attentionSummary } from "../lib/sessionStatusSummary";
import { useNotificationStore } from "@/shared/stores/notificationStore";

// Mobile counterpart to NotificationsBell: the phone has no room for the dropdown,
// so the count itself is the whole signal and a tap goes straight to the terminal
// that needs the user. Hidden on desktop, where the bell already says this.
export default function SessionStatusBadge({ sessionStatus: propStatus, allSessions = [], onSwitchSession }) {
  const { t } = useI18n();
  const storeStatus = useNotificationStore((s) => s.sessionStatus);
  const sessionStatus = propStatus || storeStatus;
  const { blocked, done, total, targetId } = attentionSummary(sessionStatus, allSessions);
  if (!total) return null;

  const parts = [
    { key: "blocked", count: blocked, state: "blocked" },
    { key: "done", count: done, state: "done" }
  ].filter((p) => p.count > 0);

  return (
    <button
      onClick={() => { vibrate(); if (targetId) onSwitchSession?.(targetId); }}
      className="sm:hidden flex items-center gap-1.5 px-2 py-1.5 rounded-brand bg-surface-2 text-text transition-all duration-150 ease-out active:scale-[0.94] flex-shrink-0"
      title={t("notifications.badgeTitle", { blocked, done })}
    >
      {parts.map(({ key, count, state }) => {
        const v = statusVisual(state);
        return (
          <span key={key} className="flex items-center gap-1">
            <span
              className={`w-2 h-2 rounded-full term-dot ${v.cls}${v.pulse ? ` pulse-${v.pulse}` : ""}`}
              style={{ background: v.dot }}
            />
            <span className="text-xs font-semibold tabular-nums">{count > 9 ? "9+" : count}</span>
          </span>
        );
      })}
    </button>
  );
}
