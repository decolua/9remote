"use client";

import { useState, useCallback } from "react";
import { AlertCircle, Copy, Check, RefreshCw } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { AGENT_UPDATE_COMMAND } from "@/shared/constants/API";

// Compare semver x.y.z; returns true when a < b
function isVersionLower(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  }
  return false;
}

// True only when web build is older than agent (hidden until web < agent)
export function isAgentOutdated(agentVersion, webVersion) {
  return !!agentVersion && !!webVersion && isVersionLower(webVersion, agentVersion);
}

export default function AgentOutdatedBanner({ agentVersion, updateAvailable = null, onUpdate, className = "" }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [updating, setUpdating] = useState(false);

  const handleUpdate = useCallback(() => {
    vibrate();
    setUpdating(true);
    onUpdate?.();
  }, [onUpdate]);

  const handleCopy = useCallback(() => {
    vibrate();
    navigator.clipboard.writeText(AGENT_UPDATE_COMMAND);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);

  const handleReload = useCallback(() => {
    vibrate();
    setReloading(true);
    setTimeout(() => window.location.reload(), 400);
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
          {updateAvailable && onUpdate && (
            <button
              onClick={handleUpdate}
              disabled={updating}
              className="w-full px-2 py-1.5 bg-brand-500 hover:bg-brand-600 disabled:opacity-60 text-white rounded flex items-center justify-center gap-1.5 transition-colors"
              type="button"
            >
              <RefreshCw size={14} className={updating ? "animate-spin" : ""} />
              <span className="text-xs font-medium">
                {updating ? t("menu.updating") : t("menu.updateNow")}
              </span>
            </button>
          )}
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
          <button
            onClick={handleReload}
            disabled={reloading}
            className="w-full mt-1 px-2 py-1.5 bg-yellow-500/20 hover:bg-yellow-500/30 disabled:opacity-60 text-yellow-600 rounded flex items-center justify-center gap-1.5 transition-colors"
            type="button"
          >
            <RefreshCw size={14} className={reloading ? "animate-spin" : ""} />
            <span className="text-xs font-medium">{t("menu.reload")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
