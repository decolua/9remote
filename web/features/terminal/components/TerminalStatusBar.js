"use client";

import { useEffect, useState } from "react";
import { Folder, GitBranch, Terminal } from "@/shared/components/ui/Icon";
import { useGitChangedCount } from "@/features/terminal/hooks/useGitChangedCount";
import { useI18n } from "@/shared/i18n";
import { statusVisual } from "@/shared/utils/statusVisual";
import { MAX_CHANGED_BADGE } from "@/features/terminal/constants/terminalConfig";

const POLL_BRANCH_MS = 10000;

const PLATFORM_LABEL = { darwin: "mac", win32: "win", linux: "linux" };

// Desktop-only status bar: session + cwd + git + agent/platform/version + connection + state.
export default function TerminalStatusBar({
  cwd,
  fileSocket,
  connected,
  sessionState = "idle",
  transport = "ws",
  sessionName = "",
  agentVersion = "",
  platform = "",
}) {
  const { t } = useI18n();
  const [branch, setBranch] = useState("");

  const changed = useGitChangedCount(cwd, fileSocket, { enabled: !!cwd && !!fileSocket });

  useEffect(() => {
    if (!cwd || !fileSocket) return;
    let cancelled = false;
    const fetchBranch = () => {
      fileSocket.gitBranch?.(cwd).then((res) => {
        if (cancelled) return;
        setBranch(res?.branch || res?.name || "");
      }).catch(() => {});
    };
    fetchBranch();
    const timer = setInterval(fetchBranch, POLL_BRANCH_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [cwd, fileSocket]);

  const v = statusVisual(sessionState);
  const stateLabel = sessionState === "working"
    ? t("common.statusWorking")
    : sessionState === "blocked"
      ? t("common.statusBlocked")
      : sessionState === "done"
        ? t("common.statusDone")
        : t("common.statusIdle");

  const cwdDisplay = cwd ? cwd.replace(/\\/g, "/") : "";
  const changedLabel = changed > MAX_CHANGED_BADGE ? `${MAX_CHANGED_BADGE}+` : changed;

  return (
    <div className="hidden sm:flex items-center gap-3 h-[26px] px-4 flex-shrink-0 bg-surface border-t border-border-subtle text-[11px] text-text-muted select-none">
      {/* Left: session name + cwd */}
      <span className="flex items-center gap-1.5 flex-shrink-0 max-w-[180px]">
        <Terminal size={12} className="opacity-60 flex-shrink-0" />
        <span className="truncate font-medium text-text" title={sessionName}>{sessionName || "—"}</span>
      </span>
      <span className="text-text-subtle flex-shrink-0">›</span>
      <span className="flex items-center gap-1.5 min-w-0 flex-shrink">
        <Folder size={12} className="opacity-60 flex-shrink-0" />
        <span className="truncate" title={cwdDisplay || ""}>{cwdDisplay || t("common.loading")}</span>
      </span>

      {/* Center-left: git branch + changed count */}
      {cwd && branch && (
        <span className="flex items-center gap-1.5 flex-shrink-0">
          <GitBranch size={12} className="opacity-60" />
          <span className="truncate max-w-[160px]">{branch}</span>
          {changed > 0 && (
            <span className="px-1 leading-tight bg-brand-500/15 text-brand-400 rounded-[2px] font-medium">
              {changedLabel}
            </span>
          )}
        </span>
      )}

      {/* Right: platform + agent version + connection + transport + session state */}
      <span className="ml-auto flex items-center gap-3 flex-shrink-0">
        {platform && (
          <span className="uppercase tracking-wide">{PLATFORM_LABEL[platform] || platform}</span>
        )}
        {agentVersion && (
          <span className="text-text-subtle">v{agentVersion}</span>
        )}
        <span className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${connected ? "bg-green-500" : "bg-red-500 animate-pulse"}`} />
          <span className="uppercase tracking-wide">{transport}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full term-dot ${v.cls}${v.pulse ? ` pulse-${v.pulse}` : ""}`} style={{ background: v.dot }} />
          <span>{stateLabel}</span>
        </span>
      </span>
    </div>
  );
}
