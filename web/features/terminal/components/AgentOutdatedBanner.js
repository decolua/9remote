"use client";

import { useState, useCallback } from "react";
import { AlertCircle, RefreshCw, Download } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";

// Compare semver x.y.z; returns true when a < b
function isVersionLower(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  }
  return false;
}

// Agent update is determined solely by the agent reporting updateAvailable (npm registry check)
export function isAgentOutdated() {
  return false;
}
// Web older than agent → needs page reload
export function isWebOutdated(agentVersion, webVersion) {
  return !!agentVersion && !!webVersion && isVersionLower(webVersion, agentVersion);
}

const MANUAL_UPDATE_CMD = "npm i -g 9remote@latest";

// Compact single-row banner. Four distinct states:
//   agent < web + canSelfUpdate → "Update" button (triggers agent self-update)
//   agent < web + !canSelfUpdate → old agent: show manual `npm i -g` command
//   updateAvailable (npm registry) → same as agent < web (registry confirms)
//   web < agent → web build is stale → "Reload" button (refresh page)
export default function AgentOutdatedBanner({ agentVersion, webVersion, updateAvailable = null, canSelfUpdate = false, onUpdate, className = "" }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);

  const handleUpdate = useCallback(() => {
    vibrate();
    setBusy(true);
    onUpdate?.();
  }, [onUpdate]);

  const handleReload = useCallback(() => {
    vibrate();
    setBusy(true);
    setTimeout(() => window.location.reload(), 400);
  }, []);

  // Determine which side is outdated: update banner only shows when agent confirms via updateAvailable
  const agentOld = !!updateAvailable;
  const webOld = isWebOutdated(agentVersion, webVersion);

  // Old agent has an update but can't self-update → guide manual npm install
  const isManual = !!(agentOld && !canSelfUpdate);
  if (isManual) {
    return (
      <div className={`px-3 py-2 bg-brand-500/10 border border-brand-500/30 rounded-brand-lg flex items-center gap-2.5 ${className}`}>
        <Download size={16} className="text-brand-500 shrink-0" />
        <div className="min-w-0 flex-1">
          <span className="text-xs font-medium text-text">{t("menu.updateAvailableTitle")}</span>
          {updateAvailable?.version && <span className="text-xs text-text-muted ml-1.5">v{updateAvailable.version}</span>}
          <div className="text-xs text-text-muted mt-0.5">{t("menu.versionMismatchHint")}</div>
        </div>
        <code className="shrink-0 px-2 py-1 bg-surface-2 border border-border text-text text-xs rounded font-mono">{MANUAL_UPDATE_CMD}</code>
      </div>
    );
  }

  const isUpdate = !!(agentOld && onUpdate);
  const version = isUpdate ? (updateAvailable?.version || agentVersion) : agentVersion;
  const title = isUpdate ? t("menu.updateAvailableTitle") : t("menu.webReloadTitle");
  const btnLabel = isUpdate ? t("menu.updateNow") : t("menu.reloadWeb");
  const Icon = isUpdate ? Download : RefreshCw;

  if (!agentOld && !webOld) return null;

  return (
    <div className={`px-3 py-2 bg-brand-500/10 border border-brand-500/30 rounded-brand-lg flex items-center gap-2.5 ${className}`}>
      <Icon size={16} className="text-brand-500 shrink-0" />
      <div className="min-w-0 flex-1">
        <span className="text-xs font-medium text-text">{title}</span>
        {version && <span className="text-xs text-text-muted ml-1.5">v{version}</span>}
      </div>
      <button
        onClick={isUpdate ? handleUpdate : handleReload}
        disabled={busy}
        className="shrink-0 px-3 py-1 bg-brand-500 hover:bg-brand-600 disabled:opacity-60 text-white text-xs font-medium rounded-brand flex items-center gap-1.5 transition-colors"
        type="button"
      >
        <Icon size={13} className={busy ? "animate-spin" : ""} />
        {btnLabel}
      </button>
    </div>
  );
}
