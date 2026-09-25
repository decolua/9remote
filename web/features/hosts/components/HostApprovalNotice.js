"use client";

import { Ban, Loader2 } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";
import { useFleetStore } from "@/shared/stores/fleetStore";

// Per-host device-admission notice, in the same slot the update progress sits:
// the leaves stay hidden and the row answers for itself. Retry reopens the bus
// (the host re-asks its approval prompt); cancel just drops it; remove deletes
// the saved key.
export default function HostApprovalNotice({ hostKey, approval, onDeleteHost = null }) {
  const { t } = useI18n();
  if (!approval) return null;
  const pending = approval === "pending";

  const retry = () => {
    vibrate();
    useFleetStore.getState().connectHost(hostKey);
  };

  return (
    <div className={`flex items-center gap-2 py-1.5 ${pending ? "" : "text-red-400"}`}>
      {pending ? (
        <Loader2 size={14} className="animate-spin text-text-subtle shrink-0" />
      ) : (
        <Ban size={14} className="shrink-0" />
      )}
      <span className="text-[11px] truncate flex-1 min-w-0" title={pending ? t("connection.approvalHint") : t("connection.rejectedDescription")}>
        {pending ? t("connection.waitingApproval") : t("connection.rejectedTitle")}
      </span>
      <button
        type="button"
        onClick={retry}
        className="px-2 py-0.5 text-[11px] text-text-muted hover:text-text bg-surface-2 hover:bg-surface-3 rounded-brand transition-colors shrink-0"
      >
        {t("common.retry")}
      </button>
      {pending ? (
        <button
          type="button"
          onClick={() => { vibrate(); useFleetStore.getState().disconnectHost(hostKey); }}
          className="px-2 py-0.5 text-[11px] text-text-muted hover:text-text bg-surface-2 hover:bg-surface-3 rounded-brand transition-colors shrink-0"
        >
          {t("common.cancel")}
        </button>
      ) : onDeleteHost && (
        <button
          type="button"
          onClick={() => { vibrate(); onDeleteHost(hostKey); }}
          className="px-2 py-0.5 text-[11px] text-red-400 hover:text-red-300 bg-red-500/10 hover:bg-red-500/20 rounded-brand transition-colors shrink-0"
        >
          {t("hosts.removeHost")}
        </button>
      )}
    </div>
  );
}
