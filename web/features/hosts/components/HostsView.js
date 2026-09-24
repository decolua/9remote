"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronRight, HardDrive, Loader2, Settings, X } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";
import { useFleetStore } from "@/shared/stores/fleetStore";
import { useSlideMenuStore } from "@/shared/stores/slideMenuStore";
import { WORKSPACE_BASE } from "@/features/terminal/constants/routeConfig";
import { hostSummary, relTime } from "../lib/fleetTree";
import { switchHost } from "../lib/switchHost";
import PlatformGlyph from "./PlatformGlyph";
import { PANEL_HEADER_H_CLASS } from "@/shared/constants/layout";

const HOST_DOT = {
  full: "bg-green-500",
  online: "bg-green-500",
  connecting: "bg-amber-400 animate-pulse",
  offline: "bg-text-subtle"
};

// Fleet home: flat list of hosts. Tapping a host card opens that host's SessionList.
export default function HostsView({
  fullHost = {},
  currentKey = "",
  homeDir = null,
  menuContext = null,
  menuCallbacks = null,
  onClose = null
}) {
  const { t } = useI18n();
  const openMenu = useSlideMenuStore((s) => s.open);
  const setContext = useSlideMenuStore((s) => s.setContext);
  const setCallbacks = useSlideMenuStore((s) => s.setCallbacks);

  useEffect(() => {
    if (!menuContext) return;
    setContext(menuContext);
    setCallbacks(menuCallbacks || {});
  }, [menuContext, menuCallbacks, setContext, setCallbacks]);

  const hostsMap = useFleetStore((s) => s.hosts);
  const [busyKey, setBusyKey] = useState(null);
  const [error, setError] = useState("");

  // Add order — Object.values follows sync()'s insertion order (saved keys in
  // the order they were added). The current host keeps its place; only its
  // Active badge distinguishes it.
  const hosts = useMemo(() => Object.values(hostsMap)
    .map((h) => (h.key === currentKey
      ? { ...h, ...fullHost, status: "full" }
      : h)),
  [hostsMap, currentKey, fullHost]);

  const currentFullKey = hosts.find((h) => h.key === currentKey)?.full || currentKey;

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
      setBusyKey(null);
    }
  };

  const openHost = (host) => run(host, async () => {
    useFleetStore.getState().setFocus(host.key);
    if (host.key === currentKey) {
      useFleetStore.getState().closeOverlay();
      return;
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

      <div className="relative z-10 flex-1 overflow-auto modal-scrollable px-4 pt-4 pb-12 space-y-2.5" style={{ overflowAnchor: "none" }}>
        {error && <div className="text-xs text-red-400 px-1">{error}</div>}
        {hosts.map((host) => (
          <HostRow
            key={host.key}
            host={host}
            busy={busyKey === host.key}
            t={t}
            onOpenHost={openHost}
          />
        ))}
      </div>
    </div>
  );
}

// One host as a list row — same flat shape as the desktop sidebar's session list.
function HostRow({ host, busy, t, onOpenHost }) {
  const summary = hostSummary(host.sessions, host.statusMap);
  const meta = [host.platform, host.version].filter(Boolean).join(" · ")
    || (host.status === "connecting" ? t("hosts.connecting") : "")
    || (host.status === "offline" && host.lastSeenAt ? `${t("hosts.lastSeen")} ${relTime(host.lastSeenAt, t)}` : "");

  return (
    <button
      type="button"
      onClick={() => onOpenHost(host)}
      disabled={busy}
      className="group flex items-center gap-2 pl-1 pr-2 py-2 text-left relative cursor-pointer border-b border-border-subtle last:border-b-0 disabled:opacity-50"
    >
      <span className="relative flex-shrink-0">
        <PlatformGlyph platform={host.platform} size={14} />
        <span className={`absolute -bottom-0.5 -right-0.5 w-1.5 h-1.5 rounded-full ring-1 ring-surface ${HOST_DOT[host.status] || HOST_DOT.offline}`} />
      </span>
      <span className="flex-1 min-w-0 flex flex-col">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="text-[12px] font-medium uppercase text-text truncate" data-tip={host.label}>
            {host.label || t("agentSwitcher.unnamed")}
          </span>
          {host.status === "full" && (
            <span className="text-[9px] font-bold uppercase tracking-wider text-brand-400 bg-brand-500/10 px-1 py-px rounded-[3px] shrink-0">
              {t("agentSwitcher.active")}
            </span>
          )}
        </span>
        <span className="flex items-center gap-1.5 text-[10px] text-text-subtle leading-tight min-w-0">
          {meta && <span className="truncate opacity-70">{meta}</span>}
          {meta && <span className="opacity-40">·</span>}
          <span className="flex-shrink-0">{summary.sessions} {t("hosts.sessions")}</span>
          {summary.working > 0 && (
            <span className="flex-shrink-0 text-blue-400">· ⟳ {summary.working}</span>
          )}
          {summary.attention > 0 && (
            <span className="flex-shrink-0 text-amber-400 font-medium">· ⚠ {summary.attention} {t("hosts.attention")}</span>
          )}
        </span>
      </span>
      {busy ? <Loader2 size={14} className="animate-spin text-brand-500 shrink-0" /> : <ChevronRight size={14} className="text-text-subtle shrink-0" />}
    </button>
  );
}
