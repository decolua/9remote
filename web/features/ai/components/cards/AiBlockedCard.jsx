"use client";

import { memo } from "react";
import { Shield, Sparkles, X } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";

// Shown when a CLI refuses an action because of its permission/sandbox policy.
// Unlike AiPermissionCard there is nothing to allow or deny here: codex `exec`
// and opencode `run` are non-interactive, so they cannot raise a prompt. The
// only remedy is a wider mode, which this card offers directly.
export const AiBlockedCard = memo(function AiBlockedCard({
  engine = "",
  message = "",
  reason = "",
  escalate = null, // { mode, label } — the mode that would allow this
  onEscalate,
  onDismiss
}) {
  const handleEscalate = () => {
    vibrate();
    onEscalate?.(escalate?.mode);
  };

  return (
    <div className="my-3 p-3 rounded-brand-lg border border-danger/40 bg-surface shadow-sm text-xs">
      <div className="flex items-center gap-2 mb-2 text-danger font-medium">
        <Shield size={16} />
        <span>Action blocked</span>
        {engine && (
          <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-danger/15 text-danger uppercase">
            {engine}
          </span>
        )}
      </div>

      <div className="p-2.5 rounded bg-bg text-[11px] text-text border border-border-subtle mb-3 whitespace-pre-wrap break-words max-h-[160px] overflow-y-auto">
        {message || reason || "The CLI refused this action under the current permission mode."}
      </div>

      <div className="flex items-center gap-2 justify-end">
        <button
          type="button"
          onClick={() => { vibrate(); onDismiss?.(); }}
          className="px-2.5 py-1.5 rounded text-text-muted hover:text-text hover:bg-surface-2 transition-colors flex items-center gap-1"
        >
          <X size={13} />
          <span>Dismiss</span>
        </button>

        {escalate?.mode && (
          <button
            type="button"
            onClick={handleEscalate}
            className="px-3.5 py-1.5 rounded bg-brand-500 hover:bg-brand-600 text-white flex items-center gap-1 font-medium transition-colors shadow-sm"
          >
            <Sparkles size={14} />
            <span>Switch to {escalate.label || escalate.mode}</span>
          </button>
        )}
      </div>
    </div>
  );
});
