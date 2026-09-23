"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, ChevronRight, Folder, HardDrive, Loader2, Settings, Terminal, X } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";
import { useFleetStore } from "@/shared/stores/fleetStore";
import { useSlideMenuStore } from "@/shared/stores/slideMenuStore";
import { useNotificationStore } from "@/shared/stores/notificationStore";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { dotClassName, statusVisual } from "@/shared/utils/statusVisual";
import { agentIconUrl, AGENT_ICON_CLS } from "@/features/terminal/constants/agentCli";
import { shortenHomePath } from "@/features/terminal/lib/workspaceGrouping";
import { WORKSPACE_BASE } from "@/features/terminal/constants/routeConfig";
import { hostTree, hostSummary } from "../lib/fleetTree";
import { switchHost } from "../lib/switchHost";
import { PANEL_HEADER_H_CLASS } from "@/shared/constants/layout";

// Agent logo with a neutral glyph fallback (same idea as NewTerminalModal's AgentAvatar).
function AgentAvatar({ agentId }) {
  const [broken, setBroken] = useState(false);
  if (!agentId || broken) return <Terminal size={14} className="text-text-muted shrink-0" />;
  return (
    <img
      src={agentIconUrl(agentId)}
      alt=""
      width={14}
      height={14}
      onError={() => setBroken(true)}
      className={`w-3.5 h-3.5 object-contain shrink-0 ${AGENT_ICON_CLS}`}
    />
  );
}

function relTime(ts, t) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(diff / 86400000);
  if (m < 1) return t("login.justNow");
  if (m < 60) return t("login.minutesAgo", { n: m });
  if (h < 24) return t("login.hoursAgo", { n: h });
  if (d < 7) return t("login.daysAgo", { n: d });
  return new Date(ts).toLocaleDateString();
}

const HOST_RANK = { full: 0, online: 1, connecting: 2, offline: 3 };
const HOST_DOT = { full: "bg-green-500", online: "bg-green-500", connecting: "bg-amber-400 animate-pulse", offline: "bg-text-subtle" };

// Fleet home: every saved host as a card, expandable into workspaces and session
// rows. The current host reads live workspace state; the others read snapshots
// pushed by their background buses. One tap on a session enters it.
export default function HostsView({ fullHost = {}, currentKey = "", homeDir = null, menuContext = null, menuCallbacks = null, onClose = null }) {
  const { t } = useI18n();
  // This screen replaces SessionList in its slot, so it inherits the same duty:
  // feeding the slide menu its context (otherwise settings/logout vanish here).
  const openMenu = useSlideMenuStore((s) => s.open);
  const setContext = useSlideMenuStore((s) => s.setContext);
  const setCallbacks = useSlideMenuStore((s) => s.setCallbacks);
  useEffect(() => {
    if (!menuContext) return;
    setContext(menuContext);
    setCallbacks(menuCallbacks || {});
  }, [menuContext, menuCallbacks, setContext, setCallbacks]);
  const hostsMap = useFleetStore((s) => s.hosts);
  const liveStatus = useNotificationStore((s) => s.sessionStatus);
  const addOpenedSession = useTerminalStore((s) => s.addOpenedSession);
  const pushView = useTerminalStore((s) => s.pushView);
  const [busyKey, setBusyKey] = useState(null);
  const [error, setError] = useState("");

  const hosts = useMemo(() => Object.values(hostsMap)
    .map((h) => (h.key === currentKey
      ? { ...h, ...fullHost, statusMap: liveStatus, status: "full" }
      : h))
    .sort((a, b) => (HOST_RANK[a.status] ?? 9) - (HOST_RANK[b.status] ?? 9)
      || (b.lastSeenAt || 0) - (a.lastSeenAt || 0)),
  [hostsMap, currentKey, fullHost, liveStatus]);

  const run = async (host, fn) => {
    if (busyKey) return;
    vibrate();
    setError("");
    setBusyKey(host.key);
    try {
      await fn();
    } catch {
      setError(t("agentSwitcher.unreachable"));
    } finally {
      // A host switch navigates away anyway; every other path must unlock.
      setBusyKey(null);
    }
  };

  // saveLastRoute is keyed by full key (same as getLastRoute on switch).
  const currentFullKey = hosts.find((h) => h.key === currentKey)?.full || currentKey;

  const openSession = (host, sessionId) => run(host, async () => {
    if (host.key === currentKey) {
      addOpenedSession(sessionId);
      pushView({ type: "terminal", sessionId });
      useFleetStore.getState().closeOverlay();
      return;
    }
    await switchHost(host.full, { currentKey: currentFullKey, route: `${WORKSPACE_BASE}/terminal/${encodeURIComponent(sessionId)}` });
  });

  const openHost = (host) => run(host, async () => {
    useFleetStore.getState().setFocus(host.key);
    if (host.key === currentKey) {
      useFleetStore.getState().closeOverlay();
      return; // mobile home flips into this host's SessionList
    }
    await switchHost(host.full, { currentKey: currentFullKey, route: WORKSPACE_BASE });
  });

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <header
        className={`relative z-10 bg-surface/80 backdrop-blur-md px-4 py-3 ${PANEL_HEADER_H_CLASS} flex items-center gap-3 flex-shrink-0 border-b border-border-subtle`}
        style={{ paddingTop: "calc(0.75rem + env(safe-area-inset-top, 0px))" }}
      >
        <div className="p-1.5 bg-brand-500/10 rounded-brand flex-shrink-0">
          <HardDrive className="text-brand-500 w-5 h-5" />
        </div>
        <h1 className="text-text text-lg font-semibold truncate flex-1">{t("hosts.title")}</h1>
        <span className="text-xs text-text-muted flex-shrink-0 mr-1">{hosts.length}</span>
        {onClose ? (
          <button
            onClick={() => { vibrate(); onClose(); }}
            aria-label={t("common.cancel")}
            title={t("common.cancel")}
            className="p-2 rounded-brand transition-colors text-text-muted hover:text-text hover:bg-surface-2 flex-shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        ) : (
          <button
            onClick={() => { vibrate(); openMenu(); }}
            aria-label={t("menu.title")}
            title={t("menu.title")}
            className="p-2 rounded-brand transition-colors text-text-muted hover:text-text hover:bg-surface-2 flex-shrink-0"
          >
            <Settings className="w-5 h-5" />
          </button>
        )}
      </header>

      <div className="relative z-10 flex-1 overflow-auto modal-scrollable px-4 pt-4 pb-12 space-y-3" style={{ overflowAnchor: "none" }}>
        {error && <div className="text-xs text-red-400 px-1">{error}</div>}
        {hosts.map((host) => (
          <HostCard
            key={host.key}
            host={host}
            busy={busyKey === host.key}
            t={t}
            homeDir={homeDir}
            onOpenHost={openHost}
            onOpenSession={openSession}
          />
        ))}
      </div>
    </div>
  );
}

// One host: status dot + label + summary line, expandable into workspace → session
// rows. The whole header toggles; the arrow button enters the host.
function HostCard({ host, busy, t, homeDir, onOpenHost, onOpenSession }) {
  const [collapsed, setCollapsed] = useState(host.status !== "full");
  const summary = hostSummary(host.sessions, host.statusMap);
  const tree = hostTree(host.sessions, host.workspaces);

  const meta = [host.platform, host.version].filter(Boolean).join(" · ")
    || (host.status === "connecting" ? t("hosts.connecting") : "")
    || (host.status === "offline" && host.lastSeenAt ? `${t("hosts.lastSeen")} ${relTime(host.lastSeenAt, t)}` : "");

  return (
    <div className="rounded-xl border border-border bg-surface overflow-hidden">
      <div className="flex items-center gap-1 pr-1">
        <button
          type="button"
          onClick={() => { vibrate(); setCollapsed((v) => !v); }}
          className="flex-1 min-w-0 flex items-center gap-2.5 px-3 py-2.5 text-left"
        >
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${HOST_DOT[host.status] || HOST_DOT.offline}`} />
          <span className="flex-1 min-w-0">
            <span className="flex items-center gap-1.5 min-w-0">
              <span className="text-sm font-medium text-text truncate">{host.label || t("agentSwitcher.unnamed")}</span>
              {host.status === "full" && (
                <span className="text-[10px] font-semibold uppercase tracking-wide text-brand-400 shrink-0">{t("agentSwitcher.active")}</span>
              )}
            </span>
            <span className="block text-[11px] text-text-subtle truncate">
              {meta}
              {meta ? " · " : ""}
              {summary.sessions} {t("hosts.sessions")}
              {summary.working > 0 && <span> · {summary.working} {t("hosts.working")}</span>}
              {summary.attention > 0 && <span className="text-amber-400 font-medium"> · {summary.attention} {t("hosts.attention")}</span>}
            </span>
          </span>
          {summary.attention > 0 && <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" aria-hidden="true" />}
          <ChevronRight size={14} className={`text-text-subtle shrink-0 transition-transform duration-150 ${collapsed ? "" : "rotate-90"}`} />
        </button>
        <button
          type="button"
          onClick={() => onOpenHost(host)}
          disabled={busy}
          title={t("hosts.openHost")}
          aria-label={t("hosts.openHost")}
          className="p-2 rounded-brand text-text-muted hover:text-text hover:bg-surface-2 disabled:opacity-40 shrink-0"
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : <ArrowUpRight size={16} />}
        </button>
      </div>

      {!collapsed && (
        <div className="px-2 pb-2 pt-2 space-y-1 border-t border-border-subtle">
          {tree.length === 0 && (
            <div className="px-2 py-2 text-xs text-text-subtle">{t("hosts.noSessions")}</div>
          )}
          {tree.map(({ workspace, sessions }) => (
            <div key={workspace?.id || "ungrouped"}>
              <div className="flex items-center gap-1.5 px-2 py-1 text-[12px] text-text-muted min-w-0">
                <Folder size={13} className="shrink-0" />
                <span className="truncate">{workspace ? workspace.name : t("workspaces.ungrouped")}</span>
                {workspace?.path && (
                  <span className="text-text-subtle truncate hidden sm:inline" title={workspace.path}>
                    · {shortenHomePath(workspace.path, homeDir)}
                  </span>
                )}
              </div>
              {sessions.map((s) => {
                const state = host.statusMap?.[s.id]?.state || "idle";
                const visual = statusVisual(state);
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => onOpenSession(host, s.id)}
                    className="w-full flex items-center gap-2 pl-4 pr-2.5 py-1.5 rounded-brand text-left hover:bg-surface-2 active:bg-surface-3 min-w-0"
                  >
                    <AgentAvatar agentId={s.agent} />
                    <span className="flex-1 text-[13px] text-text truncate">{s.name || t("terminal.defaultName")}</span>
                    {state !== "idle" && (
                      <span className="flex items-center gap-1.5 shrink-0">
                        <span className={dotClassName(state)} style={{ background: visual.dot }} />
                        <span className="text-[10px] hidden sm:inline" style={{ color: visual.dot }}>{t(visual.label)}</span>
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
