"use client";

import { memo, useState } from "react";
import { Shield, Check, X, CornerDownLeft } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { permissionGrantText } from "../../lib/permissionGrant";

export const AiPermissionCard = memo(function AiPermissionCard({
  requestId = "",
  tool = "",
  input = {},
  failed = false,
  onResolve
}) {
  const [customMsg, setCustomMsg] = useState("");
  const [showInput, setShowInput] = useState(false);

  // A permission GRANT (codex asking for more than the thread opened with) has no command
  // to show: what it wants is a profile — network, or paths outside the sandbox — and the
  // CLI's own sentence about why. Printed as those lines, because the raw JSON of a
  // profile is a wall of nulls nobody can decide on. Every other gate keeps its command.
  const command = permissionGrantText(input)
    || input?.command || input?.path || JSON.stringify(input || {});

  const handleAllow = () => {
    vibrate();
    onResolve?.(requestId, "allow");
  };

  const handleDeny = () => {
    vibrate();
    onResolve?.(requestId, "deny", customMsg || "User denied");
  };

  return (
    <div className="my-3 p-3 rounded-brand-lg border border-warning/30 bg-surface shadow-sm text-xs">
      <div className="flex items-center gap-2 mb-2 text-warning font-medium">
        <Shield size={16} />
        <span>Permission Request</span>
        {/* MCP tools are named mcp__<server>__<tool> — one unbreakable word. Without wrapping
            it runs past the card and scrolls the pane sideways; the full name stays in title. */}
        <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-warning/15 text-warning uppercase min-w-0 break-all" title={tool}>
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

      {failed && (
        <div className="mb-3 text-[11px] text-danger leading-snug">
          Not sent — the host did not answer. Try again.
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
          className="px-3 py-1.5 rounded bg-surface-2 hover:bg-danger/20 text-danger flex items-center gap-1 font-medium transition-colors"
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
