"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { startWidthDrag } from "@/shared/utils/dragResize";
import {
  Pencil, Trash2, ChevronRight, ChevronLeft, QrCode, PanelLeft, Settings, Download, RotateCw, Bot, Sparkles, Zap, Check, Image as ImageIcon, Maximize2, Minimize2, Eye, EyeOff, Columns2, Monitor, KeyRound
} from "@/shared/components/ui/Icon";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { useFleetStore } from "@/shared/stores/fleetStore";
import { connForSession, useAllSessionStatus } from "@/shared/transport/hostConn";
import { useI18n } from "@/shared/i18n";
import { usePwaInstallStore } from "@/shared/stores/pwaInstallStore";
import { vibrate } from "@/shared/utils/vibration";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import PromptDialog from "@/shared/components/ui/PromptDialog";
import useClampedMenu from "@/shared/hooks/useClampedMenu";
import { SIDEBAR_WIDTH } from "../constants/terminalConfig";
import { PANEL_HEADER_HEIGHT } from "@/shared/constants/layout";
import { AGENT_PORT } from "@/shared/constants/API";

import { sessionWorkspaceId, UNGROUPED_KEY } from "../lib/paneLayout";
import { useInputMode } from "@/shared/hooks/useInputMode";
import { withHint } from "../constants/shortcuts";
import AgentHistoryPanel from "./AgentHistoryPanel";
import { useNotificationStore } from "@/shared/stores/notificationStore";
import { isLoopbackOrigin, isAgentEnvironment } from "@/shared/utils/localOrigin";
import { isChatEngine, SWITCHABLE_STATES } from "./TerminalHeader";
import SessionBackgroundModal from "./SessionBackgroundModal";
import HostTreeRow from "@/features/hosts/components/HostTreeRow";
import HostTree from "@/features/hosts/components/HostTree";
import AddHostModal from "@/features/hosts/components/AddHostModal";
import IconMenu from "@/shared/components/ui/IconMenu";
import { orderedHostsOf, activeWsForHost } from "@/features/hosts/lib/fleetTree";
import { makeFleetActions } from "@/features/hosts/lib/fleetActions";

// Inside the Tauri shell or on a page the agent itself serves (its own port), the
// sidebar's brand row becomes a back-to-dashboard button instead. The web app keeps
// the brand — including the web dev server, which is loopback but not the agent.
const SHOW_PAIR_DEVICE = typeof window !== "undefined" && (
  !!window.__TAURI__ || (isLoopbackOrigin() && window.location.port === String(AGENT_PORT))
);

// Second line of a terminal row lives in SessionMeta.js — shared with the mobile
// session list so both screens render a terminal the same way.

export { SessionMeta } from "./SessionMeta";
import { REVEAL_CLS } from "./WorkspaceHeader";

// Desktop-only persistent sidebar: sessions grouped by workspace, full item ops
// (rename / delete / drag-reorder within workspace).
function TerminalSidebar({
  allSessions = [],
  mainSessions = null,
  workspaces = [],
  activeSessionId,
  activeWorkspaceId,
  sessionStatus: propStatus,
  notifications: propNotifications,
  onSelectSession,
  onSelectWorkspace,
  onCreateNamedSession,
  onDeleteWorkspace,
  shells = [],
  onRenameSession,
  onDeleteSession,
  onReorderSession,
  onAddWorkspace,
  onRenameWorkspace = null,
  onOpenSettings,
  onOpenRemoteHost = null,
  onRenameHost = null,
  onDeleteHost = null,
  onMainDisconnect = null, onMainReconnect = null,
  busRef = null,
  fileBus,
  homeDir,
  cwdBySession = {},
  connected = true,
  width = SIDEBAR_WIDTH.default,
  onResize,
  onCollapse,
  onResumeAgentSession,
}) {
  const { t } = useI18n();
  const agentBySession = useTerminalStore((s) => s.agentBySession || {});
  const fleetHosts = Object.values(useFleetStore((s) => s.hosts));
  // Same as the session list: the viewed host is a pointer, never a status.
  const currentKey = useFleetStore((s) => s.currentKey);
  const currentHost = fleetHosts.find((h) => h.key === currentKey);
  const [addHostOpen, setAddHostOpen] = useState(false);
  // Remote-SSH style: every other saved key is a tree root below the current
  // host's tree, fed by its fleet background bus; tapping a session opens a
  // parallel tab on that host's bus.
  const orderedHosts = orderedHostsOf(fleetHosts, currentHost?.key);
  const fullModes = useTerminalStore((s) => s.fullModes || {});
  const fullMode = useTerminalStore((s) => s.fullMode);
  const toggleFullMode = useTerminalStore((s) => s.toggleFullMode);
  const setFullMode = useTerminalStore((s) => s.setFullMode);
  const hiddenPaneSessionIds = useTerminalStore((s) => s.hiddenPaneSessionIds || []);
  const toggleHidePane = useTerminalStore((s) => s.toggleHidePane);
  const unhidePane = useTerminalStore((s) => s.unhidePane);
  const storeSessionStatus = useAllSessionStatus();
  const sessionStatus = propStatus || storeSessionStatus;
  const hasKeyboard = useInputMode() === "mouse";
  const collapseHint = hasKeyboard ? withHint(t("common.close"), "toggleSidebar") : t("common.close");
  // Which terminals actually exist right now — the history rows are a snapshot
  // and can name one that has since closed.
  const liveSessionIds = useMemo(() => new Set(allSessions.map((s) => s.id)), [allSessions]);
  const mainHostSessions = useMemo(() => mainSessions || allSessions.filter((s) => !s.hostKey), [mainSessions, allSessions]);
  const activeCwd = activeSessionId
    ? (cwdBySession[activeSessionId] ?? allSessions.find((s) => s.id === activeSessionId)?.cwd ?? allSessions.find((s) => s.id === activeSessionId)?.workspacePath ?? null)
    : null;
  // History follows the focused pane's host (bus + cache scope), via the one door.
  const historyConn = connForSession(activeSessionId);

  // PWA install — desktop only, so the row shows solely when the browser can
  // actually install (Chromium beforeinstallprompt). Manual guides live in Settings.
  const canInstall = usePwaInstallStore((s) => s.canInstall);
  const isInstalled = usePwaInstallStore((s) => s.isInstalled);
  const install = usePwaInstallStore((s) => s.install);
  const isApp = typeof window !== "undefined" && (
    window.matchMedia("(display-mode: standalone)").matches || !!window.ReactNativeWebView
  );
  const showInstall = canInstall && !isApp && !isInstalled && !isAgentEnvironment();

  // Resize handle
  const startResize = (e) => {
    e.stopPropagation();
    startWidthDrag(e, { startWidth: width, onWidth: (w) => onResize?.(w) });
  };

  // Context menu (right-click / long-press)
  const [ctxMenu, setCtxMenu] = useState(null); // { sessionId, x, y }
  const ctxRef = useRef(null);
  const ctxPos = useClampedMenu(ctxRef, ctxMenu?.left ?? 0, ctxMenu?.top ?? 0);

  // Per-session background picker, opened from the context menu
  const [bgSessionId, setBgSessionId] = useState(null);

  // The switch door: which surface this terminal is on, and whether the host may be
  // asked to move it right now (same rule as the tab menu).
  const ctxAgent = agentBySession[ctxMenu?.sessionId] || sessionStatus[ctxMenu?.sessionId]?.tool || allSessions.find((s) => s.id === ctxMenu?.sessionId)?.agent;
  const ctxAsUi = ctxAgent?.endsWith("-ui");
  const ctxConversationId = sessionStatus[ctxMenu?.sessionId]?.conversationId;
  const ctxSwitchable = isChatEngine(ctxAgent);
  const ctxSwitchReady = ctxSwitchable && SWITCHABLE_STATES.has(sessionStatus[ctxMenu?.sessionId]?.state || "idle");
  const ctxWsId = sessionWorkspaceId(allSessions.find((s) => s.id === ctxMenu?.sessionId)) ?? UNGROUPED_KEY;
  const ctxFullMode = fullModes[ctxWsId] ?? false;

  // Rename prompt (shared modal — same UX as tab header and session list)
  const [renameDialog, setRenameDialog] = useState({ sessionId: null, name: "", value: "" });
  // { key, label } of the host key being renamed (null = dialog closed).

  // Delete confirm
  const [delConfirm, setDelConfirm] = useState(null); // { sessionId, name }

  // Close context menu on outside click / Escape
  useEffect(() => {
    if (!ctxMenu) return;
    const onDoc = (e) => { if (ctxRef.current && !ctxRef.current.contains(e.target)) setCtxMenu(null); };
    const onKey = (e) => { if (e.key === "Escape") setCtxMenu(null); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("touchstart", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("touchstart", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

  const sessionById = (id) => allSessions.find((s) => s.id === id);

  const openContext = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const sessionId = e.currentTarget.dataset.sid;
    const s = sessionById(sessionId);
    setCtxMenu({
      sessionId,
      left: e.clientX,
      top: e.clientY,
      name: s?.name || "",
    });
  };

  // Touch long-press → context menu
  const longPressRef = useRef(null);
  const startLongPress = (e) => {
    const sessionId = e.currentTarget.dataset.sid;
    const touch = e.touches[0];
    longPressRef.current = setTimeout(() => {
      vibrate();
      const s = sessionById(sessionId);
      setCtxMenu({
        sessionId,
        left: touch.clientX,
        top: touch.clientY,
        name: s?.name || "",
      });
      }, 500);
  };
  const clearLongPress = () => { if (longPressRef.current) { clearTimeout(longPressRef.current); longPressRef.current = null; } };

  const startRename = (sessionId) => {
    const name = sessionById(sessionId)?.name || "";
    setRenameDialog({ sessionId, name, value: name });
    setCtxMenu(null);
  };
  const saveRename = () => {
    const value = renameDialog.value.trim();
    if (renameDialog.sessionId && value) onRenameSession?.(renameDialog.sessionId, value);
    setRenameDialog({ sessionId: null, name: "", value: "" });
  };

  const handleTouchStart = (e) => {
    startLongPress(e);
  };

  return (
    <div
      className="flex-shrink-0 h-full hidden sm:flex flex-col terminal-sidebar-bg border-r border-border-subtle relative"
      style={{ width }}
    >
      <div
        style={{ height: PANEL_HEADER_HEIGHT }}
        className="px-1 flex items-center justify-between flex-shrink-0 border-b border-border-subtle relative z-10"
      >
        <div className="flex items-center gap-2 min-w-0">
          {SHOW_PAIR_DEVICE ? (
            <button
              onClick={() => { window.location.href = "/"; }}
              className="flex items-center gap-1.5 px-1.5 py-1 text-[12px] font-medium text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors flex-shrink-0"
              title="Pair Device"
            >
              <ChevronLeft size={14} className="opacity-70" />
              <QrCode size={13} className="opacity-80" />
              <span className="truncate">Pair Device</span>
            </button>
          ) : (
            <>
              <img src="/icon-192.png" alt="9Remote" draggable={false} className="w-4 h-4 rounded-[4px] object-contain flex-shrink-0 pointer-events-none select-none" />
              <span className="text-[13px] font-semibold text-text truncate">9Remote</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          {/* Add another machine — kept here in the brand row, not down in the tree. */}
          <button
            onClick={() => { vibrate(); setAddHostOpen(true); }}
            className="p-1 text-text-muted hover:text-text rounded-[3px] hover:bg-surface-2 transition-colors"
            title={t("hosts.addHost")}
          >
            <KeyRound size={14} />
          </button>
          {onCollapse && (
            <button
              onClick={() => { vibrate(); onCollapse(); }}
              className="p-1 text-text-muted hover:text-text rounded-[3px] hover:bg-surface-2 transition-colors"
              title={collapseHint}
            >
              <PanelLeft size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Every host root in ADD order — equal siblings, the current host's tree at
          its own spot (same HostTree component; only its action set and rich-menu
          hooks differ). The -ml cancels the container's pl so each root sits at
          x=0 like every other host's, with its workspaces indented by treeCls. */}
      <div className="flex-1 min-h-0 overflow-y-auto modal-scrollable pt-1.5 pl-3.5 relative z-10">
        {orderedHosts.map((h, i) => (
          <div key={h.key} className={i === 0 ? "-ml-3.5" : "mt-1 -ml-3.5 border-t border-border-subtle pt-1"}>
          {h.key === (currentHost?.key || "main") ? (
            <HostTree
              host={{
                ...(currentHost || {}),
                key: currentHost?.key || "main",
                label: currentHost?.label || "",
                workspaces,
                sessions: mainHostSessions,
                statusMap: sessionStatus,
                onDisconnect: onMainDisconnect,
                onConnect: onMainReconnect
              }}
              busRef={busRef}
              actions={{
                selectSession: (sid) => { if (hiddenPaneSessionIds.includes(sid)) unhidePane(sid); onSelectSession?.(sid); },
                selectWorkspace: (wsId) => { vibrate(); onSelectWorkspace?.(wsId); },
                createSession: onCreateNamedSession,
                renameSession: onRenameSession,
                deleteSession: onDeleteSession,
                reorderSession: onReorderSession,
                renameWorkspace: onRenameWorkspace,
                deleteWorkspace: onDeleteWorkspace,
                renameHost: onRenameHost,
                deleteHost: onDeleteHost
              }}
              activeSessionId={activeSessionId}
              activeWorkspaceId={activeWorkspaceId}
              connected={connected}
              fileBus={fileBus}
              homeDir={homeDir}
              cwdBySession={cwdBySession}
              agentBySession={agentBySession}
              hiddenPaneSessionIds={hiddenPaneSessionIds}
              onUnhidePane={unhidePane}
              onAddWorkspace={onAddWorkspace}
              menuAddWorkspace={onAddWorkspace}
              onOpenRemoteHost={onOpenRemoteHost}
              onRowContextMenu={openContext}
              onRowTouch={{ start: handleTouchStart, move: clearLongPress, end: clearLongPress }}
              onRowMenu={(sessionId, name, rect) => setCtxMenu({ sessionId, left: rect.left, top: rect.bottom + 2, name })}
              treeCls="pl-3.5"
            />
          ) : (
            <HostTree
              host={{ ...h, onDisconnect: () => useFleetStore.getState().disconnectHost(h.key) }}
              actions={{
                ...makeFleetActions(h, { onSelectSession, onSelectWorkspace }),
                renameHost: onRenameHost,
                deleteHost: onDeleteHost
              }}
              activeSessionId={activeSessionId}
              activeWorkspaceId={activeWsForHost(activeWorkspaceId, h.key)}
              connected={connected}
              hiddenPaneSessionIds={hiddenPaneSessionIds}
              onOpenRemoteHost={onOpenRemoteHost}
              onUnhidePane={unhidePane}
              treeCls="pl-3.5"
            />
          )}
          </div>
        ))}
      </div>

      {/* Past agent-CLI conversations for wherever the active terminal is standing —
          pinned above the footer so it keeps its place as the session list scrolls.
          The bus follows the focused pane's host: a foreign terminal asks its own
          machine for the directory's history, never the main host's. */}
      {onResumeAgentSession && (
        <AgentHistoryPanel
          busRef={historyConn.busRef}
          scope={historyConn.scope}
          cwd={activeCwd}
          onResume={onResumeAgentSession}
          onSelectSession={onSelectSession}
          liveSessionIds={liveSessionIds}
          activeSessionId={activeSessionId}
          connected={connected}
        />
      )}

      {(showInstall || onOpenSettings) && (
        <div className="p-1.5 border-t border-border-subtle flex-shrink-0 relative z-10">
          {showInstall && (
            <button
              onClick={() => { vibrate(); install(); }}
              className="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-text-muted hover:text-text hover:bg-surface-2 rounded-[3px] transition-colors"
              title={t("menu.installApp")}
            >
              <Download size={14} />
              <span>{t("menu.installApp")}</span>
            </button>
          )}
          {onOpenSettings && (
          <button
            onClick={() => { vibrate(); onOpenSettings(); }}
            className="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-text-muted hover:text-text hover:bg-surface-2 rounded-[3px] transition-colors"
            title={t("menu.settings")}
          >
            <Settings size={14} />
            <span>{t("menu.settings")}</span>
          </button>
          )}
        </div>
      )}

      {/* Add-host modal, opened from the brand row */}
      {addHostOpen && <AddHostModal onClose={() => setAddHostOpen(false)} />}

      {/* Right-edge resize handle */}
      <div
        onPointerDown={startResize}
        className="absolute top-0 right-0 bottom-0 w-1 cursor-col-resize hover:bg-brand-500/40 transition-colors z-20"
      />

      {/* Context menu */}
      {ctxMenu && (
        <div
          ref={ctxRef}
          className="fixed z-[70] menu-popover p-1 min-w-[160px] animate-in fade-in zoom-in-95 duration-100"
          style={{ left: ctxPos.left, top: ctxPos.top }}
        >
          {/* Only a yellow terminal has something to mark read; typing/giving it a prompt
              does the same thing, this is the explicit door. First, amber: it clears the
              badge the user came here for. */}
          {sessionStatus[ctxMenu.sessionId]?.state === "done" && (
            <button
              onClick={() => {
                vibrate();
                useNotificationStore.getState().clearNotification(ctxMenu.sessionId);
                setCtxMenu(null);
              }}
              className="w-full text-left px-2.5 py-1.5 text-xs text-amber-500 hover:bg-amber-500/10 rounded-[6px] flex items-center gap-2"
            >
              <Check size={13} /> {t("sessions.markRead")}
            </button>
          )}
          <button
            onClick={() => startRename(ctxMenu.sessionId)}
            className="w-full text-left px-2.5 py-1.5 text-xs text-text hover:bg-surface-2/80 rounded-[6px] flex items-center gap-2"
          >
            <Pencil size={13} /> {t("sessions.editName")}
          </button>
          <div className="relative group/split">
            <button
              type="button"
              onClick={() => {
                vibrate();
                const id = ctxMenu.sessionId;
                if (!ctxFullMode && id && id !== activeSessionId) {
                  onSelectSession?.(id);
                }
                toggleFullMode(ctxWsId);
                setCtxMenu(null);
              }}
              className="w-full text-left px-2.5 py-1.5 text-xs text-text hover:bg-surface-2/80 rounded-[6px] flex items-center justify-between"
            >
              <span className="flex items-center gap-2">
                <Columns2 size={13} />
                <span>{t("sessions.split") || "Split"}</span>
              </span>
              <ChevronRight size={12} className="text-text-muted" />
            </button>

            {/* Flyout submenu on hover */}
            <div
              className={`hidden group-hover/split:block absolute top-0 menu-popover p-1 min-w-[130px] shadow-xl z-20 ${
                ctxPos.left > (typeof window !== "undefined" ? window.innerWidth - 280 : 500)
                  ? "right-full -mr-0.5"
                  : "left-full -ml-0.5"
              }`}
            >
              <button
                type="button"
                onClick={() => {
                  vibrate();
                  const id = ctxMenu.sessionId;
                  if (!ctxFullMode && id && id !== activeSessionId) {
                    onSelectSession?.(id);
                  }
                  toggleFullMode(ctxWsId);
                  setCtxMenu(null);
                }}
                className="w-full text-left px-2 py-1.5 text-xs text-text hover:bg-surface-2/80 rounded-[6px] flex items-center justify-between"
              >
                <span className="flex items-center gap-1.5">
                  {ctxFullMode ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
                  <span>{ctxFullMode ? (t("sessions.restoreSplit") || "Restore Split") : (t("sessions.maximize") || "Maximize")}</span>
                </span>
                <span className="text-[10px] text-text-muted">100%</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  vibrate();
                  if (ctxMenu.sessionId && ctxMenu.sessionId !== activeSessionId) {
                    onSelectSession?.(ctxMenu.sessionId);
                  }
                  if (ctxFullMode) setFullMode(ctxWsId, false);
                  window.dispatchEvent(new CustomEvent("terminal:splitPreset", { detail: { fraction: 2 } }));
                  setCtxMenu(null);
                }}
                className="w-full text-left px-2 py-1.5 text-xs text-text hover:bg-surface-2/80 rounded-[6px] flex items-center justify-between"
              >
                <span>1/2</span>
                <span className="text-[10px] text-text-muted">50%</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  vibrate();
                  if (ctxMenu.sessionId && ctxMenu.sessionId !== activeSessionId) {
                    onSelectSession?.(ctxMenu.sessionId);
                  }
                  if (ctxFullMode) setFullMode(ctxWsId, false);
                  window.dispatchEvent(new CustomEvent("terminal:splitPreset", { detail: { fraction: 3 } }));
                  setCtxMenu(null);
                }}
                className="w-full text-left px-2 py-1.5 text-xs text-text hover:bg-surface-2/80 rounded-[6px] flex items-center justify-between"
              >
                <span>1/3</span>
                <span className="text-[10px] text-text-muted">33%</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  vibrate();
                  if (ctxMenu.sessionId && ctxMenu.sessionId !== activeSessionId) {
                    onSelectSession?.(ctxMenu.sessionId);
                  }
                  if (ctxFullMode) setFullMode(ctxWsId, false);
                  window.dispatchEvent(new CustomEvent("terminal:splitPreset", { detail: { fraction: 4 } }));
                  setCtxMenu(null);
                }}
                className="w-full text-left px-2 py-1.5 text-xs text-text hover:bg-surface-2/80 rounded-[6px] flex items-center justify-between"
              >
                <span>1/4</span>
                <span className="text-[10px] text-text-muted">25%</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  vibrate();
                  if (ctxMenu.sessionId && ctxMenu.sessionId !== activeSessionId) {
                    onSelectSession?.(ctxMenu.sessionId);
                  }
                  if (ctxFullMode) setFullMode(ctxWsId, false);
                  window.dispatchEvent(new CustomEvent("terminal:splitPreset", { detail: { fraction: "auto" } }));
                  setCtxMenu(null);
                }}
                className="w-full text-left px-2 py-1.5 text-xs text-text hover:bg-surface-2/80 rounded-[6px] flex items-center justify-between"
              >
                <span>Auto Fit</span>
                <span className="text-[10px] text-text-muted">Auto</span>
              </button>
              <div className="h-px bg-border-subtle my-1" />
              <button
                type="button"
                onClick={() => {
                  vibrate();
                  toggleHidePane(ctxMenu.sessionId);
                  setCtxMenu(null);
                }}
                className="w-full text-left px-2 py-1.5 text-xs text-text hover:bg-surface-2/80 rounded-[6px] flex items-center justify-between"
              >
                <span className="flex items-center gap-1.5">
                  {hiddenPaneSessionIds.includes(ctxMenu.sessionId) ? <Eye size={12} /> : <EyeOff size={12} />}
                  <span>{hiddenPaneSessionIds.includes(ctxMenu.sessionId) ? (t("sessions.showPanel") || "Show") : (t("sessions.hidePanel") || "Hide")}</span>
                </span>
              </button>
            </div>
          </div>
          {/* Per-session background, same door as the tab menu */}
          <button
            onClick={() => {
              vibrate();
              const id = ctxMenu.sessionId;
              setBgSessionId(id);
              setCtxMenu(null);
            }}
            className="w-full text-left px-2.5 py-1.5 text-xs text-text hover:bg-surface-2/80 rounded-[6px] flex items-center gap-2"
          >
            <ImageIcon size={13} className="flex-shrink-0" /> {t("menu.terminalBackground")}
          </button>
          {/* Same door as the tab menu: a UI pane may always restart its AI; a
              terminal only offers resume once a conversation id exists. */}
          {(agentBySession[ctxMenu.sessionId]?.endsWith("-ui") || sessionStatus[ctxMenu.sessionId]?.conversationId) && (
            <button
              onClick={() => {
                vibrate();
                const id = ctxMenu.sessionId;
                // Bus follows the row's host — same door as the tab menu.
                const ctxBus = connForSession(id).bus;
                if (agentBySession[id]?.endsWith("-ui")) {
                  ctxBus?.emit("ai:restart", { sessionId: id });
                } else {
                  ctxBus?.emit("session-resume", { sessionId: id });
                }
                setCtxMenu(null);
              }}
              className="w-full text-left px-2.5 py-1.5 text-xs text-text hover:bg-surface-2/80 rounded-[6px] flex items-center gap-2"
            >
              <RotateCw size={13} /> {agentBySession[ctxMenu.sessionId]?.endsWith("-ui") ? (t("sessions.restartAi") || "Restart AI") : t("sessions.resumeSession")}
            </button>
          )}
          {/* Swap this terminal between the chat UI and the agent CLI — the host owns the
              switch, so the door is only lit on a settled terminal, never mid-turn. */}
          {ctxSwitchable && (
            <button
              disabled={!ctxSwitchReady}
              onClick={() => {
                vibrate();
                const id = ctxMenu.sessionId;
                connForSession(id).bus?.emit(
                  "setSessionMode",
                  { sessionId: id, mode: ctxAsUi ? "terminal" : "ui" },
                  (res) => { if (!res?.success) alert(res?.error || t("sessions.modeSwitchFailed")); }
                );
                setCtxMenu(null);
              }}
              className={`w-full text-left px-2.5 py-1.5 text-xs rounded-[6px] flex items-center gap-2 ${
                ctxSwitchReady ? "text-text hover:bg-surface-2/80" : "text-text-subtle cursor-not-allowed"
              }`}
            >
              <Sparkles size={13} /> {ctxAsUi ? t("sessions.openAsTerminal") : t("sessions.openAsUi")}
            </button>
          )}

          <div className="h-px bg-border-subtle my-1" />
          <button
            onClick={() => { setDelConfirm({ sessionId: ctxMenu.sessionId, name: ctxMenu.name }); setCtxMenu(null); }}
            className="w-full text-left px-2.5 py-1.5 text-xs text-red-500 hover:bg-red-500/10 rounded-[6px] flex items-center gap-2"
          >
            <Trash2 size={13} /> {t("sessions.deleteTitle")}
          </button>
        </div>
      )}

      {/* Per-session background picker */}
      {bgSessionId && (
        <SessionBackgroundModal
          sessionId={bgSessionId}
          title={sessionById(bgSessionId)?.name}
          busRef={busRef}
          onClose={() => setBgSessionId(null)}
        />
      )}

      {/* Rename prompt (shared modal) */}
      {renameDialog.sessionId && (
        <PromptDialog
          title={t("sessions.editName")}
          placeholder={renameDialog.name}
          value={renameDialog.value}
          onChange={(value) => setRenameDialog({ ...renameDialog, value })}
          onSubmit={saveRename}
          onClose={() => setRenameDialog({ sessionId: null, name: "", value: "" })}
        />
      )}

      {/* Delete session confirm */}
      <ConfirmDialog
        isOpen={Boolean(delConfirm)}
        onClose={() => setDelConfirm(null)}
        onConfirm={() => {
          if (delConfirm?.sessionId) onDeleteSession?.(delConfirm.sessionId);
        }}
        title={t("sessions.deleteTitle")}
        message={t("sessions.deleteMessage", { name: delConfirm?.name || "" })}
        confirmText={t("common.delete")}
      />
    </div>
  );
}

// Props are stabilized upstream (memoized panel descriptors, `nav`, store actions), so
// this only re-renders when something it actually shows changed.
export default memo(TerminalSidebar);
