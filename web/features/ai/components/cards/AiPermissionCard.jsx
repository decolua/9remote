"use client";

import { memo, useState } from "react";
import { Shield, Check, X, CornerDownLeft } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";

export const AiPermissionCard = memo(function AiPermissionCard({
  requestId = "",
  tool = "",
  input = {},
  onResolve
}) {
  const [customMsg, setCustomMsg] = useState("");
  const [showInput, setShowInput] = useState(false);

  const command = input?.command || input?.path || JSON.stringify(input || {});

  const handleAllow = () => {
    vibrate();
    onResolve?.(requestId, "allow");
  };

  const handleDeny = () => {
    vibrate();
    onResolve?.(requestId, "deny", customMsg || "User denied");
  };

  return (
    <div className="my-3 p-3 rounded-brand-lg border border-amber-500/30 bg-surface shadow-sm text-xs">
      <div className="flex items-center gap-2 mb-2 text-amber-400 font-medium">
        <Shield size={16} />
        <span>Permission Request</span>
        <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 uppercase">
          {tool || "Action"}
        </span>
      </div>

      <div className="p-2.5 rounded bg-bg font-mono text-[11px] text-text break-all border border-border-subtle mb-3 max-h-[140px] overflow-y-auto">
        {command}
      </div>

      {showInput && (
        <div className="mb-3">
          <input
            type="text"
            value={customMsg}
            onChange={(e) => setCustomMsg(e.target.value)}
            placeholder="Reason for denial or alternative instructions..."
            className="w-full px-2.5 py-1.5 rounded bg-bg border border-border-subtle text-xs text-text placeholder-text-muted focus:outline-none focus:border-brand-500"
            autoFocus
          />
        </div>
      )}

      <div className="flex items-center gap-2 justify-end">
        {!showInput ? (
          <button
            type="button"
            onClick={() => setShowInput(true)}
            className="px-2.5 py-1.5 rounded text-text-muted hover:text-text hover:bg-surface-2 transition-colors"
          >
            Add note
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setShowInput(false)}
            className="px-2.5 py-1.5 rounded text-text-muted hover:text-text hover:bg-surface-2 transition-colors"
          >
            Hide note
          </button>
        )}

        <button
          type="button"
          onClick={handleDeny}
          className="px-3 py-1.5 rounded bg-surface-2 hover:bg-rose-500/20 text-rose-300 flex items-center gap-1 font-medium transition-colors"
        >
          <X size={14} />
          <span>Deny</span>
        </button>

        <button
          type="button"
          onClick={handleAllow}
          className="px-3.5 py-1.5 rounded bg-brand-500 hover:bg-brand-600 text-white flex items-center gap-1 font-medium transition-colors shadow-sm"
        >
          <Check size={14} />
          <span>Allow</span>
        </button>
      </div>
    </div>
  );
});
