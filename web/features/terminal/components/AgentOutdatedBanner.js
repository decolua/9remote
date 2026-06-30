"use client";

import { useState, useCallback } from "react";
import { AlertCircle, Copy, Check } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { AGENT_UPDATE_COMMAND } from "@/shared/constants/API";

// True only when both versions known and differ (hidden by default until mismatch)
export function isAgentOutdated(agentVersion, webVersion) {
  return !!agentVersion && !!webVersion && agentVersion !== webVersion;
}

export default function AgentOutdatedBanner({ agentVersion, className = "" }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    vibrate();
    navigator.clipboard.writeText(AGENT_UPDATE_COMMAND);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);

  return (
    <div className={`p-3 bg-yellow-500/15 border border-yellow-500/40 rounded-brand-lg ${className}`}>
      <div className="flex items-start gap-2">
        <AlertCircle className="text-yellow-600 shrink-0 mt-0.5" size={16} />
        <div className="text-xs space-y-1.5 min-w-0 flex-1">
          <p className="text-yellow-600 font-semibold">
            {t("menu.versionMismatch", { version: agentVersion ? `v${agentVersion}` : "?" })}
          </p>
          <p className="text-text-muted">
            {t("menu.versionMismatchHint")}
          </p>
          <div className="flex items-center gap-2 bg-surface px-2 py-1.5 rounded">
            <code className="flex-1 min-w-0 text-brand-500 text-xs font-mono break-all select-all">
              {AGENT_UPDATE_COMMAND}
            </code>
            <button
              onClick={handleCopy}
              className="shrink-0 p-1 text-text-muted hover:text-brand-500 transition-colors"
              title={copied ? t("common.copied") : t("common.copy")}
              type="button"
            >
              {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
