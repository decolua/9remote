"use client";

import { useEffect, useState } from "react";
import { Folder, GitBranch, Terminal } from "@/shared/components/ui/Icon";
import { useGitChangedCount } from "@/features/terminal/hooks/useGitChangedCount";
import { useQuota } from "@/features/quota/hooks/useQuota";
import QuotaSegments from "@/features/quota/components/QuotaSegments";
import { useI18n } from "@/shared/i18n";
import { statusVisual } from "@/shared/utils/statusVisual";
import { MAX_CHANGED_BADGE } from "@/features/terminal/constants/terminalConfig";
import StatusBar from "@/shared/components/ui/StatusBar";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { useWorkspaceGit } from "@/features/terminal/hooks/useWorkspaceGit";

const POLL_BRANCH_MS = 10000;

const PLATFORM_LABEL = { darwin: "mac", win32: "win", linux: "linux" };

// Mobile strip above the keyboard input, shown only while the soft keyboard is closed.
// Width is scarce: branch + changed on the left, the cwd's leaf folder (the part that
// identifies where you are), and a lone connection dot. Tap the path → reveal in files.
export function MobileStatusStrip({ sessionId, fileSocket, onReveal }) {
  const cwd = useTerminalStore((s) => s.cwdBySession[sessionId]) || "";
  const { branch, changedCount } = useWorkspaceGit(cwd, fileSocket, { enabled: !!cwd && !!fileSocket });
  // The last two segments name the folder and its parent — a lone leaf is cryptic,
  // and a full path would never fit a phone-width strip
  const segs = cwd ? cwd.replace(/\\+|\/+$/g, "").split(/[\\/]/).filter(Boolean) : [];
  const tail = segs.length ? segs.slice(-2).join("/") : "";
  return (
    <div className="flex items-center justify-between gap-2 px-3 h-6 border-t border-border-subtle text-[10px] text-text-subtle bg-bg flex-shrink-0">
      {branch && (
        <span className="flex items-center gap-1 flex-shrink-0">
          <GitBranch size={10} className="opacity-70" />
          <span className="max-w-[90px] truncate text-text-muted">{branch}</span>
          {changedCount > 0 && (
            <span className="px-1 leading-tight bg-brand-500/15 text-brand-400 rounded-[2px] font-medium">
              {changedCount > MAX_CHANGED_BADGE ? `${MAX_CHANGED_BADGE}+` : changedCount}
            </span>
          )}
        </span>
      )}
      {tail && (
        <button
          type="button"
          onClick={onReveal ? () => onReveal(cwd) : undefined}
          title={cwd}
          className={`flex items-center gap-1 min-w-0 font-mono ${onReveal ? "hover:text-text" : ""}`}
        >
          <Folder size={10} className="opacity-70 flex-shrink-0" />
          <span className="truncate">{tail}</span>
        </button>
      )}
    </div>
  );
}

// Desktop-only status bar content: session + cwd + git on the left, platform/version/
// connection/state on the right. The shell comes from the shared StatusBar.
export default function TerminalStatusBar({
  cwd,
  fileSocket,
  socketRef,
  connected,
  sessionState = "idle",
  transport = "ws",
  sessionName = "",
  agentVersion = "",
  platform = "",
}) {
  const { t } = useI18n();
  const [branch, setBranch] = useState("");
  const quota = useQuota(socketRef);

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
    <StatusBar
      className="hidden sm:flex"
      left={<>
      <span className="flex items-center gap-1.5 flex-shrink-0 max-w-[180px]">
        <Terminal size={12} className="opacity-60 flex-shrink-0" />
        <span className="truncate font-medium text-text-muted" title={sessionName}>{sessionName || "—"}</span>
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
      </>}
      right={<>
        <QuotaSegments quota={quota} />
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
      </>}
    />
  );
}
