"use client";

import { useEffect, useState } from "react";
import { Folder, GitBranch, Terminal } from "@/shared/components/ui/Icon";
import { useQuota } from "@/features/quota/hooks/useQuota";
import QuotaSegments from "@/features/quota/components/QuotaSegments";
import { quotaBarColor } from "@/features/quota/constants/quotaConfig";
import { agentIconUrl } from "@/features/terminal/constants/agentCli";
import { useI18n } from "@/shared/i18n";
import { statusVisual } from "@/shared/utils/statusVisual";
import {
  MAX_CHANGED_BADGE,
  STRIP_FADE_MS,
  STRIP_QUOTA_PIN_PCT,
  STRIP_ROTATE_MS
} from "@/features/terminal/constants/terminalConfig";
import StatusBar from "@/shared/components/ui/StatusBar";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { useWorkspaceGit } from "@/features/terminal/hooks/useWorkspaceGit";
import { pollWhileVisible } from "@/shared/utils/visibilityPoll";

const PLATFORM_LABEL = { darwin: "mac", win32: "win", linux: "linux" };

// Cross-fades between the slot's pages: both live in the same grid cell, so the strip
// keeps one stable width and the outgoing page dissolves into the incoming one.
function FadeSlot({ pages, activeKey }) {
  return (
    <span className="grid justify-items-end">
      {pages.map(({ key, node }) => (
        <span
          key={key}
          aria-hidden={key !== activeKey}
          className="[grid-area:1/1] flex items-center min-w-0 motion-reduce:transition-none"
          style={{
            opacity: key === activeKey ? 1 : 0,
            transform: key === activeKey ? "translateY(0)" : "translateY(2px)",
            pointerEvents: key === activeKey ? "auto" : "none",
            transition: `opacity ${STRIP_FADE_MS}ms ease, transform ${STRIP_FADE_MS}ms ease`
          }}
        >
          {node}
        </span>
      ))}
    </span>
  );
}

// The running CLI's 5h quota — the only window worth a phone-width slot, since the
// question it answers is "do I still have quota right now".
function useSessionQuota(sessionId, socketRef) {
  const agentId = useTerminalStore((s) => s.agentBySession[sessionId]) || "";
  const quota = useQuota(socketRef, { enabled: !!agentId });
  const provider = agentId ? quota?.providers?.[agentId] : null;
  if (!provider || provider.status !== "ok" || !provider.session) return null;
  return { agentId, usedPct: provider.session.usedPercent };
}

// Advances the slot on a slow cadence. A pinned page (urgent quota) stops the rotation,
// and `paused` parks it after a tap. Index is taken modulo so a shrinking page list
// can't strand it out of range.
function useRotatingPage(pageCount, { pinnedIndex = -1, paused = false } = {}) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (pageCount < 2 || paused || pinnedIndex >= 0) return;
    // Rotating a strip nobody can see only burns wake-ups; it resumes on return.
    return pollWhileVisible(() => setIndex((i) => i + 1), STRIP_ROTATE_MS, { fireOnReturn: false });
  }, [pageCount, paused, pinnedIndex]);

  if (!pageCount) return [0, setIndex];
  return [pinnedIndex >= 0 ? pinnedIndex : index % pageCount, setIndex];
}

// Mobile strip above the keyboard input, shown only while the soft keyboard is closed.
// Width is scarce: branch + changed stay pinned on the left, and the right slot
// alternates between the cwd's leaf folder and the running CLI's 5h quota.
export function MobileStatusStrip({ sessionId, fileSocket, socketRef, onReveal }) {
  const cwd = useTerminalStore((s) => s.cwdBySession[sessionId]) || "";
  const { branch, changedCount } = useWorkspaceGit(cwd, fileSocket, { enabled: !!cwd && !!fileSocket });
  const quota = useSessionQuota(sessionId, socketRef);
  const [paused, setPaused] = useState(false);

  // The last two segments name the folder and its parent — a lone leaf is cryptic,
  // and a full path would never fit a phone-width strip
  const segs = cwd ? cwd.replace(/\\+|\/+$/g, "").split(/[\\/]/).filter(Boolean) : [];
  const tail = segs.length ? segs.slice(-2).join("/") : "";

  useEffect(() => {
    if (!paused) return;
    const timer = setTimeout(() => setPaused(false), STRIP_ROTATE_MS);
    return () => clearTimeout(timer);
  }, [paused]);

  const pages = [];
  if (tail) {
    pages.push({
      key: "path",
      node: (
        <button
          type="button"
          onClick={onReveal ? () => onReveal(cwd) : undefined}
          title={cwd}
          className={`flex items-center gap-1 min-w-0 font-mono ${onReveal ? "hover:text-text" : ""}`}
        >
          <Folder size={10} className="opacity-70 flex-shrink-0" />
          <span className="truncate">{tail}</span>
        </button>
      )
    });
  }
  if (quota) {
    pages.push({
      key: "quota",
      node: (
        // Tapping parks the slot on the path page for one rotation cycle
        <button type="button" onClick={() => setPaused(true)} className="flex items-center gap-1.5 flex-shrink-0">
          <img src={agentIconUrl(quota.agentId)} alt="" width={11} height={11} className="w-[11px] h-[11px] object-contain" />
          <span className="w-8 h-[4px] rounded-full bg-text-muted/20 overflow-hidden">
            <span
              className={`block h-full rounded-full transition-all duration-300 ${quotaBarColor(quota.usedPct)}`}
              style={{ width: `${Math.min(100, Math.max(0, quota.usedPct))}%` }}
            />
          </span>
          <span className="tabular-nums text-text-muted">{Math.round(quota.usedPct)}%</span>
        </button>
      )
    });
  }

  const pinned = quota && quota.usedPct >= STRIP_QUOTA_PIN_PCT
    ? pages.findIndex((p) => p.key === "quota")
    : -1;
  const [pageIndex] = useRotatingPage(pages.length, { pinnedIndex: pinned, paused });

  return (
    <div className="flex items-center justify-between gap-2 px-3 h-6 border-t border-border-subtle text-[10px] text-text-subtle bg-bg flex-shrink-0">
      {branch && (
        <span className="flex items-center gap-1 flex-shrink-0">
          <GitBranch size={10} className="opacity-70" />
          <span className="max-w-[90px] truncate text-text-muted" title={branch}>{branch}</span>
          {changedCount > 0 && (
            <span className="px-1 leading-tight bg-brand-500/15 text-brand-400 rounded-[2px] font-medium">
              {changedCount > MAX_CHANGED_BADGE ? `${MAX_CHANGED_BADGE}+` : changedCount}
            </span>
          )}
        </span>
      )}
      {pages.length > 0 && <FadeSlot pages={pages} activeKey={pages[pageIndex]?.key} />}
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
  const quota = useQuota(socketRef);

  // Branch + changed come from the shared ref-counted poll — one round-trip per unique
  // path, shared with the mobile strip, instead of two parallel pollers here.
  const { branch, changedCount: changed } = useWorkspaceGit(cwd, fileSocket, { enabled: !!cwd && !!fileSocket });

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
          <span className="truncate max-w-[160px]" title={branch}>{branch}</span>
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
