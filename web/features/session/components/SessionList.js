"use client";

import { useState, useEffect } from "react";
import NewTerminalModal from "@/shared/components/ui/NewTerminalModal";
import { useSlideMenuStore } from "@/shared/stores/slideMenuStore";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { useConnectionStore } from "@/shared/stores/connectionStore";
import { useFileBusStore } from "@/shared/stores/fileBusStore";
import { useNotificationStore } from "@/shared/stores/notificationStore";
import { useAllSessionStatus } from "@/shared/transport/hostConn";
import { RemoteTargets, tailOf } from "@/features/terminal/components/TerminalEmptyState";
import { Monitor, Zap, ArrowRight, KeyRound, QrCode, Settings } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { useFleetStore } from "@/shared/stores/fleetStore";
import HostTree from "@/features/hosts/components/HostTree";
import AddHostModal from "@/features/hosts/components/AddHostModal";
import { orderedHostsOf } from "@/features/hosts/lib/fleetTree";
import { makeFleetActions } from "@/features/hosts/lib/fleetActions";
import { sessionWorkspaceId } from "@/features/terminal/lib/paneLayout";
import { isHostEnvironment } from "@/shared/utils/localOrigin";
import { PANEL_HEADER_H_CLASS } from "@/shared/constants/layout";
import SessionBackgroundModal from "@/features/terminal/components/SessionBackgroundModal";

// Mobile-only: on desktop the sidebar already lists workspaces and terminals with more
// operations, so this screen would only be a larger, weaker copy of it.
export default function SessionList({
  sessions, cwdBySession = {}, connected: propConnected, onSelect, onCreate, onDelete, onRename, onLogout, onOpenRemote,
  tunnelUrl, apiKey, connectionMode = "tunnel",
  isActive = true, busRef: propBusRef, subscribeToPush, unsubscribeFromPush,
  onResumeAgentSession = null,
  notifications: propNotifications, sessionStatus: propStatus, hostVersion, agentVersion,
  carrier: propCarrier,
  workspaces = [], onRenameWorkspace, onDeleteWorkspace, onAddWorkspace,
  onOpenRemoteHost = null,
  onOpenMobileHost = null,
  fileBus, homeDir, recentWorkspaces = [], shells = [], onReorderSession,
  onRenameHost = null, onDeleteHost = null, onMainDisconnect = null, onMainReconnect = null
}) {
  const { t } = useI18n();
  // Callers may pass no bus; the store is the single live connection anyway
  const activeFileBus = fileBus || useFileBusStore.getState();
  const fleetHosts = Object.values(useFleetStore((s) => s.hosts));
  // The viewed host is a POINTER, not a status: it keeps its rich branch (label,
  // sessions, its own disconnect/reconnect doors) online, offline and connecting
  // alike — picking it by status made a deliberately disconnected host fall
  // into the generic fleet branch and lose all of that.
  const currentKey = useFleetStore((s) => s.currentKey);
  const currentHost = fleetHosts.find((h) => h.key === currentKey);
  const storeConnected = useConnectionStore((s) => s.connected);
  const storeCarrier = useConnectionStore((s) => s.carrier);
  const storeBusRef = useConnectionStore((s) => s.busRef);
  const connected = propConnected ?? storeConnected;
  const carrier = propCarrier || storeCarrier || "ws";
  const busRef = propBusRef || storeBusRef;
  const storeNotifications = useNotificationStore((s) => s.notifications);
  const storeSessionStatus = useAllSessionStatus();
  const notifications = propNotifications || storeNotifications;
  const sessionStatus = propStatus || storeSessionStatus;
  // Actions only — same reason as TerminalHeader: this writes context/callbacks.
  const openMenu = useSlideMenuStore((s) => s.open);
  const setContext = useSlideMenuStore((s) => s.setContext);
  const setCallbacks = useSlideMenuStore((s) => s.setCallbacks);
  const hiddenHeaderButtons = useTerminalStore((s) => s.hiddenHeaderButtons);
  const showButton = (id) => !hiddenHeaderButtons.includes(id);
  const pushView = useTerminalStore((s) => s.pushView);
  // Pairing QR lives on the host's own page — hide the entry on the public web.
  const isHostUi = isHostEnvironment();

  const [bgTarget, setBgTarget] = useState(null);           // session whose background sheet is open
  const [terminalModal, setTerminalModal] = useState(null); // { workspaceId }
  const [addHostOpen, setAddHostOpen] = useState(false);
  const [pickerFor, setPickerFor] = useState(false);        // remote host picker sheet

  // Hosts that can answer the shared feature — the header button picks among
  // them (one host = straight in, no sheet).
  const online = (h) => h.status === "full" || h.status === "online";
  const remoteHosts = fleetHosts.filter((h) => online(h) && h.remoteAvailable);
  const pickHost = () => {
    vibrate();
    if (remoteHosts.length === 1) { onOpenRemoteHost?.(remoteHosts[0].key); return; }
    setPickerFor(true);
  };
  // Every host root in add order — the current host's tree renders at its own
  // spot among the siblings (tapping a foreign session opens a parallel tab).
  const orderedHosts = orderedHostsOf(fleetHosts, currentHost?.key);

  // Mod+Alt+T opens the new-terminal modal on the ungrouped workspace
  // (browser reserves bare Mod+T)
  useEffect(() => {
    if (!isActive) return;
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.altKey && !e.shiftKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        setTerminalModal({ workspaceId: null });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isActive]);

  useEffect(() => {
    if (!isActive) return;
    setContext({
      connected,
      remoteAvailable: !!onOpenRemote,
      showTheme: false,
      theme: "default",
      busRef,
      // Remote and Sites sit in this screen's own header, and Files needs a workspace
      // that has not been picked yet — all three would be duplicates or dead entries.
      hideActions: ["remote", "files", "sites"],
      tunnelUrl,
      apiKey,
      connectionMode,
      subscribeToPush,
      unsubscribeFromPush,
      notifications,
      hostVersion: hostVersion || agentVersion,
      agentVersion: hostVersion || agentVersion,
      carrier
    });
    setCallbacks({
      onRemote: null,
      onFiles: null,
      onSelectSite: null,
      onRefreshSites: null,
      onLogout,
      onThemeChange: null,
    });
  }, [
    isActive, connected, onOpenRemote, onLogout,
    setContext, setCallbacks, busRef, connectionMode, subscribeToPush,
    unsubscribeFromPush, hostVersion, agentVersion, carrier, tunnelUrl, apiKey, notifications
  ]);

  // A history row naming a terminal that still exists focuses it instead of resuming a
  // second copy of the same conversation.
  const liveSessionIds = new Set(sessions.map((s) => s.id));
  const sessionsIn = (workspaceId) => sessions.filter((s) => sessionWorkspaceId(s) === workspaceId);

  // Exactly one host and no workspace: show the two-half poster stage (workspace/remote).
  // Multi-host skips this stage so the user sees the fleet instead. A running
  // update outranks the poster — its progress must stay visible.
  const anyUpdating = fleetHosts.some((h) => h.updating);
  const showWelcomeStage = !anyUpdating && !sessions.length && !workspaces.length && fleetHosts.length <= 1;

  return (
    <div className="h-full flex flex-col overflow-hidden relative">
      {/* Translucent bar like the old design; safe-area padding for notched phones, where
          env() is 0 everywhere else. */}
      <header
        className={`relative z-10 bg-surface/80 backdrop-blur-md pl-[28px] pr-4 py-3 ${PANEL_HEADER_H_CLASS} flex items-center justify-between gap-2 flex-shrink-0 border-b border-border-subtle`}
        style={{ paddingTop: "calc(0.75rem + env(safe-area-inset-top, 0px))" }}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="p-1.5 bg-brand-500/10 rounded-brand flex-shrink-0">
            <Zap className="text-brand-500 w-5 h-5" />
          </div>
          <h1 className="text-text text-lg font-semibold truncate">{t("sessions.headerTitle")}</h1>
          <span
            className={`w-2 h-2 rounded-full flex-shrink-0 ${connected ? "bg-green-500" : "bg-red-500 animate-pulse"}`}
            title={connected ? t("sessions.connected") : t("sessions.disconnected")}
          />
        </div>

        <div className="flex items-center gap-1 flex-shrink-0">
          {showButton("remote") && remoteHosts.length > 0 && (
            <HeaderButton icon={Monitor} label={t("menu.remoteDesktop")} onClick={pickHost} disabled={!connected} />
          )}
          {isHostUi && (
            <HeaderButton icon={QrCode} label={t("connection.pairTab")} onClick={() => { vibrate(); pushView({ type: "pair" }); }} />
          )}
          <HeaderButton icon={KeyRound} label={t("hosts.addHost")} onClick={() => { vibrate(); setAddHostOpen(true); }} />
          <HeaderButton icon={Settings} label={t("menu.title")} onClick={openMenu} />
        </div>
      </header>

      {/* Host row — the root of the workspace tree below, same component the desktop
          sidebar uses. It scrolls with the list: it is the tree's first node, not a bar. */}
      <div
        className="relative z-10 flex-1 overflow-auto modal-scrollable pt-2 pb-12"
        style={{ overflowAnchor: "none" }}
      >
        {showWelcomeStage ? (
          <div className="absolute inset-0 z-10">
            <WelcomeCards
              onAddWorkspace={onAddWorkspace}
              recent={recentWorkspaces}
              homeDir={homeDir}
              connected={connected}
            />
          </div>
        ) : (
          <>
            {/* Every host root in ADD order — the current host's tree and every
                other host's render through the SAME component, only the action
                set differs. Online roots carry live status; offline ones draw
                from the fleet cache. */}
            {orderedHosts.map((h, i) => (
              <div key={h.key} className={i === 0 ? "pl-1 pr-3" : "mt-3 border-t border-border-subtle pt-2 pl-1 pr-3"}>
              {h.key === (currentHost?.key || "main") && currentHost ? (
                <HostTree
                  mobile
                  host={{
                    ...currentHost,
                    workspaces,
                    sessions,
                    statusMap: sessionStatus,
                    onDisconnect: onMainDisconnect,
                    onConnect: onMainReconnect
                  }}
                  busRef={busRef}
                  actions={{
                    selectSession: onSelect,
                    createSession: onCreate,
                    renameSession: onRename,
                    deleteSession: onDelete,
                    backgroundSession: (s) => setBgTarget(s),
                    reorderSession: onReorderSession,
                    renameWorkspace: onRenameWorkspace,
                    deleteWorkspace: onDeleteWorkspace,
                    renameHost: onRenameHost,
                    deleteHost: onDeleteHost
                  }}
                  connected={connected}
                  fileBus={activeFileBus}
                  homeDir={homeDir}
                  cwdBySession={cwdBySession}
                  onAddWorkspace={onAddWorkspace}
                  menuAddWorkspace={onAddWorkspace}
                  onOpenRemoteHost={onOpenRemoteHost}
                  onOpenMobileHost={onOpenMobileHost}
                  treeCls="pl-5"
                  rowCls="active:bg-surface-2 active:text-text"
                />
              ) : (
                <HostTree
                  mobile
                  host={{ ...h, onDisconnect: () => useFleetStore.getState().disconnectHost(h.key) }}
                  actions={{
                    ...makeFleetActions(h, { onSelectSession: onSelect }),
                    renameHost: onRenameHost,
                    deleteHost: onDeleteHost
                  }}
                  connected={connected}
                  onOpenRemoteHost={onOpenRemoteHost}
                  onOpenMobileHost={onOpenMobileHost}
                  treeCls="pl-5"
                  rowCls="active:bg-surface-2 active:text-text"
                />
              )}
              </div>
            ))}
          </>
        )}
      </div>

      {bgTarget && (
        <SessionBackgroundModal
          sessionId={bgTarget.id}
          title={bgTarget.name}
          busRef={busRef}
          onClose={() => setBgTarget(null)}
        />
      )}

      {terminalModal && (
        <NewTerminalModal
          onClose={() => setTerminalModal(null)}
          onCreate={(name, shellId, agent, yolo, cwd, nameIsAuto) => {
            onCreate?.(name, terminalModal.workspaceId, shellId, cwd || null, agent, yolo, nameIsAuto);
            setTerminalModal(null);
          }}
          shells={shells}
          busRef={busRef}
          onResumeAgentSession={onResumeAgentSession}
          onSelectSession={onSelect}
          liveSessionIds={liveSessionIds}
          connected={connected}
          workspacePath={workspaces.find((w) => w.id === terminalModal.workspaceId)?.path || null}
          workspaceName={workspaces.find((w) => w.id === terminalModal.workspaceId)?.name || ""}
          fileBus={activeFileBus}
          homeDir={homeDir}
          suggestName={`${t("terminal.defaultName")} ${sessionsIn(terminalModal.workspaceId).length + 1}`}
        />
      )}

      {addHostOpen && <AddHostModal onClose={() => setAddHostOpen(false)} />}

      {pickerFor && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-[2px] animate-in fade-in duration-150"
          onClick={() => setPickerFor(null)}
        >
          <div
            className="card-elev w-full sm:max-w-sm max-h-[60%] overflow-auto modal-scrollable rounded-t-2xl sm:rounded-2xl p-2 animate-in slide-in-from-bottom-4 duration-150"
            onClick={(e) => e.stopPropagation()}
          >
            {remoteHosts.map((h) => (
              <button
                key={h.key}
                onClick={() => {
                  const key = h.key;
                  setPickerFor(false);
                  onOpenRemoteHost?.(key);
                }}
                className="w-full flex items-center gap-2.5 px-3 py-3 text-left rounded-brand hover:bg-surface-2 active:bg-surface-2 transition-colors"
              >
                <Monitor size={16} className="text-text-muted shrink-0" />
                <span className="flex-1 min-w-0 truncate text-sm text-text">{h.label || t("agentSwitcher.unnamed")}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function HeaderButton({ icon: Icon, label, onClick, disabled, className = "" }) {
  return (
    <button
      onClick={() => { vibrate(); onClick(); }}
      disabled={disabled}
      title={label}
      className={`p-2 rounded-brand transition-colors active:scale-[0.96] ${
        disabled ? "text-text-subtle cursor-not-allowed" : `text-text-muted hover:text-text hover:bg-surface-2 ${className}`
      }`}
    >
      <Icon className="w-5 h-5" />
    </button>
  );
}

// First run: the two things this app can do as naked poster halves on a cinematic
// stage (same white light as login), split by a hairline + brand dot.
function WelcomeCards({ onAddWorkspace, recent, homeDir, connected }) {
  const { t } = useI18n();
  const pushView = useTerminalStore((s) => s.pushView);
  // Right half connects another machine into the fleet — meaningful everywhere.
  const [addHostOpen, setAddHostOpen] = useState(false);
  return (
    <div className="empty-stage w-full h-full">
      <div className="empty-grid" />

      <button
        onClick={() => { vibrate(); onAddWorkspace?.(); }}
        disabled={!connected}
        className="empty-half text-left active:opacity-80 enabled:active:scale-[0.99] transition-all duration-150 disabled:opacity-40 disabled:saturate-50"
      >
        <span className="empty-idx"><b>01</b> / {t("workspaces.emptyTagVibe")}</span>
        <span className="empty-word login-hero-grad">{t("workspaces.emptyWordVibe")}</span>
        <span
          className="empty-meta"
          dangerouslySetInnerHTML={{ __html: t("workspaces.emptyMetaVibe") }}
        />
        <span className="empty-go">
          {t("workspaces.emptyGoVibe")}
          <ArrowRight size={14} className="text-brand-500" strokeWidth={2.2} />
        </span>
        {!!recent.length && (
          <span className="flex flex-wrap gap-1.5 mt-4 max-w-full">
            {recent.slice(0, 3).map((w) => (
              <span
                key={w.path}
                role="button"
                title={w.path}
                onClick={(e) => { e.stopPropagation(); vibrate(); onAddWorkspace?.(w.path); }}
                className="welcome-chip path-tail px-2 py-1 text-[11px] font-mono text-text-muted rounded-full truncate max-w-[46%]"
              >
                {tailOf(w.path)}
              </span>
            ))}
          </span>
        )}
      </button>

      <>
        <div className="empty-hairline" aria-hidden />

        <button
          onClick={() => { vibrate(); setAddHostOpen(true); }}
            className="empty-half text-left active:opacity-80 enabled:active:scale-[0.99] transition-all duration-150 disabled:opacity-40 disabled:saturate-50"
          >
            <span className="empty-idx"><b>02</b> / {t("workspaces.emptyTagPair")}</span>
            <span className="empty-word login-hero-grad">{t("workspaces.emptyWordPair")}</span>
            <span className="empty-meta"><RemoteTargets /></span>
            <span className="empty-go">
              {t("workspaces.emptyGoPair")}
              <ArrowRight size={14} className="text-brand-500" strokeWidth={2.2} />
            </span>
          </button>
      </>

      {addHostOpen && <AddHostModal onClose={() => setAddHostOpen(false)} />}
    </div>
  );
}


