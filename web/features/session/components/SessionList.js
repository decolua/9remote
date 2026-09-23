"use client";

import { useState, useEffect, useRef } from "react";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import PromptDialog from "@/shared/components/ui/PromptDialog";
import IconMenu from "@/shared/components/ui/IconMenu";
import NewTerminalModal from "@/shared/components/ui/NewTerminalModal";
import { useSlideMenuStore } from "@/shared/stores/slideMenuStore";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { useConnectionStore } from "@/shared/stores/connectionStore";
import { useFileBusStore } from "@/shared/stores/fileBusStore";
import { useNotificationStore } from "@/shared/stores/notificationStore";
import {
  Folder, Monitor, Smartphone, Plus, Settings, Pencil, Trash2, ChevronRight, Zap, ArrowRight, Image, Terminal, KeyRound
} from "@/shared/components/ui/Icon";
import { useDragReorder } from "@/features/terminal/hooks/useDragReorder";
import { vibrate } from "@/shared/utils/vibration";
import { statusVisual } from "@/shared/utils/statusVisual";
import { useI18n } from "@/shared/i18n";
import { useFleetStore } from "@/shared/stores/fleetStore";
import { agentIconUrl, AGENT_ICON_CLS } from "@/features/terminal/constants/agentCli";
import { AGENT_ICONS } from "@/features/terminal/constants/agentLabels";
import { isDefaultBranch } from "@/features/terminal/constants/terminalConfig";
import SessionMeta from "@/features/terminal/components/SessionMeta";
import HostTreeRow from "@/features/hosts/components/HostTreeRow";
import HostTree from "@/features/hosts/components/HostTree";
import AddHostModal from "@/features/hosts/components/AddHostModal";
import { otherHostsOf } from "@/features/hosts/lib/fleetTree";
import { makeFleetActions } from "@/features/hosts/lib/fleetActions";
import AgentOutdatedBanner, { isAgentOutdated, isWebOutdated } from "@/features/terminal/components/AgentOutdatedBanner";
import { sessionWorkspaceId } from "@/features/terminal/lib/paneLayout";
import { shortenHomePath, workspaceGitPath, groupSessionsByWorkspace } from "@/features/terminal/lib/workspaceGrouping";
import BranchBadge from "@/features/terminal/components/BranchBadge";
import { useWorkspaceGit } from "@/features/terminal/hooks/useWorkspaceGit";
import { PANEL_HEADER_H_CLASS } from "@/shared/constants/layout";
import SessionBackgroundModal from "@/features/terminal/components/SessionBackgroundModal";

const UNGROUPED_KEY = "ungrouped";

// A terminal's agent, drawn from its bundled logo — UI engines get their own icon,
// hook-reported tools fall back to the label's icon, and a plain shell gets a prompt.
function AgentGlyph({ agentId, tool }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <Terminal size={13.5} className="text-text-muted flex-shrink-0" />;
  if (agentId?.endsWith("-ui")) {
    return (
      <img
        src={agentIconUrl(agentId)}
        alt=""
        onError={() => setBroken(true)}
        className={`w-3.5 h-3.5 flex-shrink-0 object-contain ${AGENT_ICON_CLS}`}
      />
    );
  }
  if (AGENT_ICONS[tool]) {
    return <img src={AGENT_ICONS[tool]} alt={tool} className={`w-3.5 h-3.5 flex-shrink-0 object-contain ${AGENT_ICON_CLS}`} />;
  }
  return <Terminal size={13.5} className="text-text-muted flex-shrink-0" />;
}

// Touch drag: the grip handle carries `touch-none`, so a drag from it never scrolls;
// rows without one keep their normal scroll gesture untouched.

// Mobile-only: on desktop the sidebar already lists workspaces and terminals with more
// operations, so this screen would only be a larger, weaker copy of it.
export default function SessionList({
  sessions, cwdBySession = {}, connected: propConnected, onSelect, onCreate, onDelete, onRename, onLogout, onOpenRemote, onOpenMobile,
  tunnelUrl, apiKey, connectionMode = "tunnel", codespaceInfo, codespaceDisconnected,
  onStopCodespace, isActive = true, busRef: propBusRef, subscribeToPush, unsubscribeFromPush,
  onResumeAgentSession = null,
  notifications: propNotifications, sessionStatus: propStatus, agentVersion,
  updateAvailable = null, canSelfUpdate = false, onUpdate, onRestart, carrier: propCarrier,
  workspaces = [], onRenameWorkspace, onDeleteWorkspace, onAddWorkspace,
  fileBus, homeDir, recentWorkspaces = [], shells = [], onReorderSession,
  onRenameHost = null, onDeleteHost = null
}) {
  const { t } = useI18n();
  // Callers may pass no bus; the store is the single live connection anyway
  const activeFileBus = fileBus || useFileBusStore.getState();
  const fleetHosts = Object.values(useFleetStore((s) => s.hosts));
  const currentHost = fleetHosts.find((h) => h.status === "full");
  const storeConnected = useConnectionStore((s) => s.connected);
  const storeCarrier = useConnectionStore((s) => s.carrier);
  const storeBusRef = useConnectionStore((s) => s.busRef);
  const connected = propConnected ?? storeConnected;
  const carrier = propCarrier || storeCarrier || "ws";
  const busRef = propBusRef || storeBusRef;
  const storeNotifications = useNotificationStore((s) => s.notifications);
  const storeSessionStatus = useNotificationStore((s) => s.sessionStatus);
  const notifications = propNotifications || storeNotifications;
  const sessionStatus = propStatus || storeSessionStatus;
  // Actions only — same reason as TerminalHeader: this writes context/callbacks.
  const openMenu = useSlideMenuStore((s) => s.open);
  const setContext = useSlideMenuStore((s) => s.setContext);
  const setCallbacks = useSlideMenuStore((s) => s.setCallbacks);
  const hiddenHeaderButtons = useTerminalStore((s) => s.hiddenHeaderButtons);
  const mobileDeviceCount = useTerminalStore((s) => s.mobileDeviceCount);
  const showButton = (id) => !hiddenHeaderButtons.includes(id);

  const [bgTarget, setBgTarget] = useState(null);           // session whose background sheet is open
  const [renaming, setRenaming] = useState(null);           // { kind, id, value }
  const [confirm, setConfirm] = useState(null);             // { kind, id, name }
  const [terminalModal, setTerminalModal] = useState(null); // { workspaceId }
  const [addHostOpen, setAddHostOpen] = useState(false);
  const [hostCollapsed, setHostCollapsed] = useState(false);
  // Other saved keys: tree roots under this host's tree (same as the desktop
  // sidebar); tapping a session opens a parallel tab.
  const otherHosts = otherHostsOf(fleetHosts, currentHost?.key);

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
      codespaceInfo,
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
      agentVersion,
      carrier
    });
    setCallbacks({
      onRemote: null,
      onFiles: null,
      onSelectSite: null,
      onRefreshSites: null,
      onCodespace: null,
      onLogout,
      onThemeChange: null,
      onStopCodespace,
      onUpdate,
      onRestart
    });
  }, [
    isActive, connected, onOpenRemote, codespaceInfo, onLogout, onStopCodespace, onUpdate,
    onRestart, setContext, setCallbacks, busRef, connectionMode, subscribeToPush,
    unsubscribeFromPush, agentVersion, carrier, tunnelUrl, apiKey, notifications
  ]);

  // Same grouping pipeline as the desktop sidebar — grp carries `items`, which the
  // workspace-path fallback (and with it the session's second line) depends on.
  const grouped = groupSessionsByWorkspace(sessions, workspaces, t("workspaces.ungrouped"));
  const sessionsIn = (workspaceId) => sessions.filter((s) => sessionWorkspaceId(s) === workspaceId);
  // A history row naming a terminal that still exists focuses it instead of resuming a
  // second copy of the same conversation.
  const liveSessionIds = new Set(sessions.map((s) => s.id));

  const submitRename = () => {
    const value = renaming?.value?.trim();
    if (value) {
      if (renaming.kind === "session") onRename?.(renaming.id, value);
      else onRenameWorkspace?.(renaming.id, value);
    }
    setRenaming(null);
  };

  const confirmDelete = () => {
    if (confirm?.kind === "session") onDelete?.(confirm.id);
    else onDeleteWorkspace?.(confirm.id);
    setConfirm(null);
  };

  const showBanner = connected && (
    isAgentOutdated(agentVersion, process.env.NEXT_PUBLIC_SERVER_VERSION) ||
    isWebOutdated(agentVersion, process.env.NEXT_PUBLIC_SERVER_VERSION) ||
    updateAvailable
  );

  return (
    <div className="h-full flex flex-col overflow-hidden relative">
      {/* Translucent bar like the old design; safe-area padding for notched phones, where
          env() is 0 everywhere else. */}
      <header
        className={`relative z-10 bg-surface/80 backdrop-blur-md px-4 py-3 ${PANEL_HEADER_H_CLASS} flex items-center justify-between gap-2 flex-shrink-0 border-b border-border-subtle`}
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
          {!connected && codespaceDisconnected && (
            <span className="text-red-400 text-xs truncate">{t("sessions.codespaceStopped")}</span>
          )}
        </div>

        <div className="flex items-center gap-1 flex-shrink-0">
          {showButton("remote") && onOpenRemote && (
            <HeaderButton icon={Monitor} label={t("menu.remoteDesktop")} onClick={onOpenRemote} disabled={!connected} />
          )}
          {showButton("mobile") && onOpenMobile && (
            <HeaderButton
              icon={Smartphone}
              label={mobileDeviceCount > 0
                ? t("mobile.deviceRunning", { count: mobileDeviceCount })
                : t("mobile.androidDevice")}
              onClick={onOpenMobile}
              disabled={!connected}
              className={mobileDeviceCount > 0 ? "!text-green-400" : ""}
            />
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
        {showBanner && (
          <AgentOutdatedBanner
            agentVersion={agentVersion}
            webVersion={process.env.NEXT_PUBLIC_SERVER_VERSION}
            updateAvailable={updateAvailable}
            canSelfUpdate={canSelfUpdate}
            onUpdate={onUpdate}
            className="mb-4 mx-4"
          />
        )}

        {currentHost && (
          <div className="pl-1 pr-3">
          <HostTreeRow
            className="flex-shrink-0"
            hostKey={currentHost.key}
            label={currentHost.label || ""}
            connected={connected}
            collapsed={hostCollapsed}
            onToggleCollapse={() => setHostCollapsed((v) => !v)}
            showAdd={false}
            onRename={onRenameHost}
            onDelete={onDeleteHost}
            onDisconnect={onLogout}
            onAddWorkspace={onAddWorkspace}
          />
          </div>
        )}

        {/* The host row collapses the tree under it, same as the desktop sidebar. */}
        {!hostCollapsed && (
          !sessions.length && !workspaces.length ? (
          <div className="px-4 pt-2">
            <WelcomeCards
              onAddWorkspace={onAddWorkspace}
              onOpenRemote={onOpenRemote}
              recent={recentWorkspaces}
              homeDir={homeDir}
              connected={connected}
            />
          </div>
        ) : (
          /* Same frame as the desktop tree so both screens indent a workspace the
              same distance from the host row; every row's last button then sits the
              same 8px from the right edge (the wrapper owns the right padding). */
          <div className="pl-5 pr-4 pt-1.5">
            {grouped.map((section) => {
              const items = section.items;
              if (section.id === null && !items.length) return null;
              return (
                <WorkspaceSection
                  key={section.id ?? UNGROUPED_KEY}
                  section={section}
                  items={items}
                  connected={connected}
                  cwdBySession={cwdBySession}
                  fileBus={activeFileBus}
                  homeDir={homeDir}
                  sessionStatus={sessionStatus}
                  onSelect={onSelect}
                  onNewTerminal={() => setTerminalModal({ workspaceId: section.id })}
                  onRenameSession={(s) => setRenaming({ kind: "session", id: s.id, value: s.name })}
                  onBackgroundSession={(s) => setBgTarget(s)}
                  onDeleteSession={(s) => setConfirm({ kind: "session", id: s.id, name: s.name })}
                  onReorderSession={onReorderSession}
                  onWorkspaceMenu={section.id === null ? null : (action) => {
                    if (action === "rename") setRenaming({ kind: "workspace", id: section.id, value: section.name });
                    else setConfirm({ kind: "workspace", id: section.id, name: section.name });
                  }}
                />
              );
            })}

            {/* New workspace — the same dashed button the desktop tree uses, sized
                to its label instead of the full row. */}
            <button
              onClick={() => { vibrate(); onAddWorkspace(); }}
              disabled={!connected}
              className="mx-auto flex items-center gap-1.5 py-1.5 px-4 text-xs text-text-subtle active:text-text border border-dashed border-border-subtle active:border-text-muted/40 rounded-brand active:bg-surface-2 transition-colors disabled:opacity-40"
            >
              <Plus size={12} className="flex-shrink-0" />
              <span>{t("workspaces.newWorkspace")}</span>
            </button>
          </div>
        ))}

        {/* Other saved keys — sibling roots under this host's tree, mirroring the
            desktop sidebar. Online roots carry live status; offline ones draw
            from the fleet cache. */}
        {otherHosts.length > 0 && (
          <div className="mt-3 border-t border-border-subtle pt-2 pl-1 pr-3">
            {otherHosts.map((h) => (
              <HostTree
                key={h.key}
                host={{ ...h, onDisconnect: () => useFleetStore.getState().disconnectHost(h.key) }}
                actions={{
                  ...makeFleetActions(h, { onSelectSession: onSelect }),
                  renameHost: onRenameHost,
                  deleteHost: onDeleteHost
                }}
                connected={connected}
                treeCls="pl-5 pr-4"
                rowCls="active:bg-surface-2 active:text-text"
              />
            ))}
          </div>
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

      {renaming && (
        <PromptDialog
          title={renaming.kind === "session" ? t("sessions.editName") : t("workspaces.rename")}
          value={renaming.value}
          onChange={(value) => setRenaming({ ...renaming, value })}
          onSubmit={submitRename}
          onClose={() => setRenaming(null)}
        />
      )}

      <ConfirmDialog
        isOpen={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={confirmDelete}
        title={confirm?.kind === "session" ? t("sessions.deleteTitle") : t("workspaces.deleteTitle")}
        message={confirm?.kind === "session"
          ? t("sessions.deleteMessage", { name: confirm?.name || "" })
          : t("workspaces.deleteMessage", { name: confirm?.name || "" })}
      />

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
    </div>
  );
}

// One workspace: a header naming the folder and where it is, then its terminals.
// Hold a card ~500ms to pick it up and drop it on another card to reorder — order
// persists to localStorage; a swipe before the deadline scrolls the list as usual.
function WorkspaceSection({
  section, items, connected, cwdBySession = {}, fileBus, homeDir, sessionStatus,
  onSelect, onNewTerminal, onRenameSession, onBackgroundSession, onDeleteSession, onWorkspaceMenu, onReorderSession
}) {
  // Same drag the desktop sidebar runs, minus the grip: a finger holds ~250ms on the
  // row itself, then drags. While a drag is live, touch scrolling is suspended or the
  // browser would steal the gesture halfway through.
  const { dragId, registerEl, startDrag, consumeClick } = useDragReorder({ axis: "y", onCommit: onReorderSession });

  useEffect(() => {
    if (!dragId) return;
    const stopScroll = (e) => e.preventDefault();
    window.addEventListener("touchmove", stopScroll, { passive: false });
    return () => window.removeEventListener("touchmove", stopScroll);
  }, [dragId]);

  const startReorder = (e, id) => {
    if (!connected) return;
    startDrag(e, id, items.map((i) => i.id));
  };

  const { t } = useI18n();
  const gitPath = workspaceGitPath(section);
  // Same badge the desktop header draws — one way to name a branch everywhere.
  const { branch, dirty } = useWorkspaceGit(gitPath, fileBus);
  const [collapsed, setCollapsed] = useState(false);

  return (
    <section>
      {/* Same header shape as the desktop sidebar: chevron, caps name, off-default branch.
          The whole row toggles — a chevron alone is a small target on a phone. */}
      <div className={`flex items-center gap-1 py-1.5 ${connected ? "cursor-pointer" : ""}`}>
        <button
          onClick={() => { vibrate(); setCollapsed((v) => !v); }}
          className="flex-1 min-w-0 flex items-center gap-1.5 text-left"
        >
          <span className="p-1 text-text-subtle flex-shrink-0">
            <ChevronRight
              size={12}
              className={`transition-transform duration-150 ${collapsed ? "" : "rotate-90"}`}
            />
          </span>
          <Folder size={13.5} className="text-text-muted flex-shrink-0" />
          <span className="flex-1 min-w-0 flex flex-col">
            <span className="text-[12px] font-medium uppercase text-text-muted truncate" data-tip={section.name}>
              {section.name}
            </span>
            {branch && !isDefaultBranch(branch) && branch !== section.name && (
              <span className="text-[10px] text-text-subtle leading-tight flex items-center gap-1 min-w-0">
                <BranchBadge branch={branch} dirty={dirty} className="truncate flex-shrink-0 max-w-[7rem]" />
              </span>
            )}
          </span>
        </button>

        {/* New terminal (+) and "..." for rename / delete */}
        {onNewTerminal && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); vibrate(); onNewTerminal(); }}
            disabled={!connected}
            className="p-0.5 text-text-subtle hover:text-text rounded-[2px] hover:bg-surface-2 transition-colors disabled:opacity-40"
            title={t("terminal.newTerminal")}
          >
            <Plus size={12} />
          </button>
        )}
        <IconMenu
          label={t("sessions.sessionActions")}
          items={[
            onWorkspaceMenu && {
              icon: Pencil, label: t("workspaces.rename"),
              onClick: () => onWorkspaceMenu("rename")
            },
            onWorkspaceMenu && {
              icon: Trash2, label: t("workspaces.delete"), danger: true,
              onClick: () => onWorkspaceMenu("delete")
            }
          ]}
        />
      </div>

      {!collapsed && (
        <div>
          {items.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              status={sessionStatus[session.id]}
              connected={connected}
              cwd={cwdBySession[session.id] ?? session.cwd ?? session.workspacePath}
              basePath={workspaceGitPath(section)}
              fileBus={fileBus}
              homeDir={homeDir}
              onSelect={onSelect}
              menuItems={[
                {
                  icon: Pencil, label: t("sessions.editName"),
                  onClick: () => onRenameSession(session)
                },
                {
                  icon: Image, label: t("menu.terminalBackground"),
                  onClick: () => onBackgroundSession(session)
                },
                {
                  icon: Trash2, label: t("sessions.deleteTitle"), danger: true,
                  onClick: () => onDeleteSession(session)
                }
              ]}
              registerRef={registerEl(session.id)}
              isDragging={dragId === session.id}
              onStartDrag={connected && items.length > 1 ? startReorder : null}
              swallowClick={consumeClick}
            />
          ))}
          <button
            onClick={() => { vibrate(); onNewTerminal(); }}
            disabled={!connected}
            className="w-full flex items-center gap-1.5 pl-8 py-1.5 text-left text-xs text-text-subtle hover:text-brand-500 transition-colors disabled:opacity-40"
            title={t("workspaces.addTerminal")}
          >
            <Plus size={13} className="flex-shrink-0" />
            <span>{t("terminal.newTerminal")}</span>
          </button>
        </div>
      )}
    </section>
  );
}

// One terminal as a flat list row — the same shape the desktop sidebar uses, so the
// two screens read alike. Long press opens the action sheet; the buttons are the
// quick path a phone-sized screen has room for.
// A touch that holds this long without scrolling arms the row's drag; a tap or a
// scroll gesture ends before it fires.
const DRAG_HOLD_MS = 250;
const DRAG_TOLERANCE = 8;

function SessionRow({
  session, status, connected: propConnected,
  onSelect, menuItems = null,
  cwd, basePath = null, fileBus, homeDir,
  registerRef = null, isDragging = false, onStartDrag = null, swallowClick = null
}) {
  const { t } = useI18n();
  const storeConnected = useConnectionStore((s) => s.connected);
  const connected = propConnected ?? storeConnected;
  const state = status?.state || "idle";
  const v = statusVisual(state);
  const tool = status?.tool;
  const [menuAt, setMenuAt] = useState(null); // screen pos a long-press opened the menu at

  const holdRef = useRef(null);       // pending hold timer, null when idle
  const holdStartRef = useRef(null);  // where the finger went down

  const clearHold = () => {
    if (holdRef.current) { clearTimeout(holdRef.current); holdRef.current = null; }
    holdStartRef.current = null;
  };

  const onRowPointerDown = (e) => {
    if (!onStartDrag) return;
    // Mouse has no scroll conflict — the shared threshold alone separates click from drag.
    if (e.pointerType === "mouse") { onStartDrag(e, session.id); return; }
    holdStartRef.current = { x: e.clientX, y: e.clientY };
    holdRef.current = setTimeout(() => {
      const down = e; // clientX/Y and pointerType outlive the dispatched event
      clearHold();
      vibrate();
      onStartDrag(down, session.id);
    }, DRAG_HOLD_MS);
  };

  const onRowPointerMove = (e) => {
    if (!holdRef.current) return;
    const s = holdStartRef.current;
    if (s && (Math.abs(e.clientX - s.x) > DRAG_TOLERANCE || Math.abs(e.clientY - s.y) > DRAG_TOLERANCE)) clearHold();
  };

  return (
    <div
      ref={registerRef}
      data-sid={session.id}
      onClick={() => { if (swallowClick?.()) return; if (connected) { vibrate(); onSelect(session.id); } }}
      onContextMenu={(e) => { if (menuItems && !isDragging) { e.preventDefault(); vibrate(); setMenuAt({ left: e.clientX, top: e.clientY }); } }}
      onPointerDown={onRowPointerDown}
      onPointerMove={onRowPointerMove}
      onPointerUp={clearHold}
      onPointerCancel={clearHold}
      onPointerLeave={clearHold}
      className={`group relative flex items-center gap-1.5 pl-6 py-1.5 rounded-[3px] cursor-pointer select-none ${
        connected ? "active:bg-text/5" : "opacity-60"
      } ${isDragging ? "z-20 opacity-90 shadow-lg ring-1 ring-brand-500 bg-surface" : "transition-colors"}`}
    >
      <span className={`w-2 h-2 rounded-full flex-shrink-0 term-dot ${v.cls}${v.pulse ? ` pulse-${v.pulse}` : ""}`} style={{ background: v.dot }} />
      <span className="flex-1 min-w-0 flex flex-col">
        <span className="flex items-center gap-1 min-w-0">
          <AgentGlyph agentId={session.agent} tool={tool} />
          <span className="text-[11px] text-text truncate" data-tip={session.name || t("terminal.defaultName")}>
            {session.name || t("terminal.defaultName")}
          </span>
        </span>
        <SessionMeta
          fileBus={fileBus}
          cwd={cwd}
          basePath={basePath}
          homeDir={homeDir}
        />
      </span>
      {/* One "..." per row — the same centered menu the key and workspace rows open. */}
      {menuItems && (
        <IconMenu
          label={session.name || t("terminal.defaultName")}
          anchor={menuAt}
          onClose={() => setMenuAt(null)}
          items={menuItems}
          className={connected ? "flex-shrink-0" : "opacity-40 pointer-events-none"}
        />
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
function WelcomeCards({ onAddWorkspace, onOpenRemote, recent, homeDir, connected }) {
  const { t } = useI18n();
  const remoteReady = connected && !!onOpenRemote;
  return (
    // Bleed past the scroll container's px-4 pt-4 pb-6 so the backdrop reaches the edges
    <div className="empty-stage w-[calc(100%_+_2rem)] h-[calc(100%_+_2.5rem)] -mx-4 -mt-4 -mb-6">
      <div className="empty-grid" />

      <button
        onClick={() => { vibrate(); onAddWorkspace?.(); }}
        disabled={!connected}
        className="empty-half text-left active:opacity-80 enabled:active:scale-[0.99] transition-all duration-150 disabled:opacity-40 disabled:saturate-50"
      >
        <span className="empty-idx"><b>01</b> / {t("workspaces.emptyTagWorkspace")}</span>
        <span className="empty-word login-hero-grad">{t("workspaces.emptyWordTerminal")}</span>
        <span
          className="empty-meta"
          dangerouslySetInnerHTML={{ __html: t("workspaces.emptyMetaWorkspace") }}
        />
        <span className="empty-go">
          {t("workspaces.selectFolder")}
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
                {shortenHomePath(w.path, homeDir)}
              </span>
            ))}
          </span>
        )}
      </button>

      {!!onOpenRemote && (
        <>
          <div className="empty-hairline" aria-hidden />

          <button
            onClick={() => { vibrate(); onOpenRemote?.(); }}
            disabled={!remoteReady}
            className="empty-half text-left active:opacity-80 enabled:active:scale-[0.99] transition-all duration-150 disabled:opacity-40 disabled:saturate-50"
          >
            <span className="empty-idx"><b>02</b> / {t("workspaces.emptyTagRemote")}</span>
            <span className="empty-word login-hero-grad">{t("workspaces.emptyWordRemote")}</span>
            <span
              className="empty-meta"
              dangerouslySetInnerHTML={{ __html: t("workspaces.emptyMetaRemote") }}
            />
            {remoteReady && (
              <span className="empty-go">
                {t("menu.remoteDesktop")}
                <ArrowRight size={14} className="text-brand-500" strokeWidth={2.2} />
              </span>
            )}
          </button>
        </>
      )}
    </div>
  );
}


