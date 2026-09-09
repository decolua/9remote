"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { startWidthDrag } from "@/shared/utils/dragResize";
import { Terminal, Plus, Pencil, Trash2, GripVertical, ChevronRight, ChevronLeft, QrCode, PanelLeft, Settings, Download, RotateCw } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { usePwaInstallStore } from "@/shared/stores/pwaInstallStore";
import { statusVisual } from "@/shared/utils/statusVisual";
import { AGENT_ICONS } from "../constants/agentLabels";
import { vibrate } from "@/shared/utils/vibration";
import NewTerminalModal from "@/shared/components/ui/NewTerminalModal";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import PromptDialog from "@/shared/components/ui/PromptDialog";
import useClampedMenu from "@/shared/hooks/useClampedMenu";
import { SIDEBAR_WIDTH, isDefaultBranch } from "../constants/terminalConfig";
import { PANEL_HEADER_HEIGHT } from "@/shared/constants/layout";
import { groupSessionsByWorkspace, shortenHomePath, workspaceGitPath } from "../lib/workspaceGrouping";
import { useWorkspaceGit } from "../hooks/useWorkspaceGit";
import { sessionWorkspaceId } from "../lib/paneLayout";
import { useInputMode } from "@/shared/hooks/useInputMode";
import { withHint } from "../constants/shortcuts";
import { useDragReorder } from "../hooks/useDragReorder";
import BranchBadge from "./BranchBadge";
import AgentHistoryPanel from "./AgentHistoryPanel";
import { useNotificationStore } from "@/shared/stores/notificationStore";
import { isLoopbackOrigin } from "@/shared/utils/localOrigin";

// Inside the Tauri shell or on loopback agent, the sidebar's brand row
// becomes a back-to-dashboard button instead (standalone web keeps the brand).
const SHOW_PAIR_DEVICE = typeof window !== "undefined" && (!!window.__TAURI__ || isLoopbackOrigin());

// Second line of a terminal item: the branch of its live checkout, plus the state
// when something is happening. The agent's name is not repeated — the icon in the row
// already says which one it is, and "claude" next to a Claude logo says it twice.
// A default branch (main/master) is the norm, not information, so it stays hidden.
export function SessionMeta({ fileBus, cwd, basePath, homeDir }) {
  const { branch, dirty } = useWorkspaceGit(cwd, fileBus);
  const showBranch = !!branch && !isDefaultBranch(branch);
  // Second line, in priority order: off-default branch → live folder relative to the
  // workspace root → path when the cwd left the workspace. Parked at the root on the
  // default branch there is nothing to say, so the row stays one line.
  const meta = showBranch ? null
    : cwd && basePath && cwd.startsWith(`${basePath}/`) ? cwd.slice(basePath.length + 1)
    : cwd && basePath && cwd !== basePath ? shortenHomePath(cwd, homeDir)
    : null;
  if (!showBranch && !meta) return null;
  return (
    <span className="text-[10px] text-text-subtle truncate leading-tight flex items-center gap-1.5">
      {showBranch && <BranchBadge branch={branch} dirty={dirty} className="truncate italic" />}
      {meta && <span className="truncate opacity-70" data-tip={meta}>{meta}</span>}
    </span>
  );
}

// One workspace row: collapse chevron, name, off-default branch, actions.
function WorkspaceHeader({
  workspace, isActive, connected, collapsed, fileBus,
  onToggleCollapse, onSelect, onNewTerminal, onDelete
}) {
  const { t } = useI18n();
  const hasKeyboard = useInputMode() === "mouse";
  const gitPath = workspaceGitPath(workspace);
  const { branch, dirty } = useWorkspaceGit(gitPath, fileBus);
  // Hover-reveal on pointer devices; always visible on touch, which has no hover.
  // Always visible: hiding them until hover meant a workspace's own actions were
  // undiscoverable, and there is no hover at all on a touch screen.
  const revealCls = "opacity-60 hover:opacity-100 focus-visible:opacity-100";

  return (
    <div
      onClick={onSelect}
      className={`pr-2 py-0.5 flex items-center gap-1 group/grp transition-colors ${
        onSelect ? "cursor-pointer hover:bg-text/[0.06]" : ""
      }`}
    >
      <button
        onClick={(e) => { e.stopPropagation(); vibrate(); onToggleCollapse?.(); }}
        className="p-1 text-text-subtle hover:text-text flex-shrink-0"
        tabIndex={-1}
      >
        <ChevronRight size={12} className={`transition-transform duration-150 ${collapsed ? "" : "rotate-90"}`} />
      </button>
      <span className="flex-1 min-w-0 flex flex-col">
        <span className={`text-[12px] font-medium uppercase truncate ${isActive ? "text-text" : "text-text-muted"}`} data-tip={workspace.name}>
          {workspace.name}
        </span>
        {/* Path is dropped and a default branch stays hidden — only an off-default
            worktree is worth a second line. Never repeats the workspace name. */}
        {branch && !isDefaultBranch(branch) && branch !== workspace.name && (
          <span className="text-[10px] text-text-subtle leading-tight flex items-center gap-1 min-w-0">
            <BranchBadge branch={branch} dirty={dirty} className="truncate flex-shrink-0 max-w-[7rem]" />
          </span>
        )}
      </span>
      {/* Dropped once the actions became permanent: the terminals are listed right below,
          so a count of them is the one thing here the user can already see. */}
      {onNewTerminal && (
        <button
          onClick={(e) => { e.stopPropagation(); vibrate(); onNewTerminal(); }}
          disabled={!connected}
          className={`p-0.5 text-text-subtle hover:text-brand-500 rounded-[2px] hover:bg-surface-2 transition-colors disabled:opacity-40 ${revealCls}`}
          title={hasKeyboard && isActive ? withHint(t("terminal.newTerminal"), "newTerminal") : t("terminal.newTerminal")}
        >
          <Plus size={12} />
        </button>
      )}
      {onDelete && (
        <button
          onClick={(e) => { e.stopPropagation(); vibrate(); onDelete(); }}
          disabled={!connected}
          className={`p-0.5 -mr-0.5 text-text-subtle hover:text-red-500 rounded-[2px] hover:bg-surface-2 transition-colors disabled:opacity-40 ${revealCls}`}
          title={t("workspaces.delete")}
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );
}

// Desktop-only persistent sidebar: sessions grouped by workspace, full item ops
// (rename / delete / drag-reorder within workspace).
function TerminalSidebar({
  allSessions = [],
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
  onOpenSettings,
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
  const storeNotifications = useNotificationStore((s) => s.notifications);
  const storeSessionStatus = useNotificationStore((s) => s.sessionStatus);
  const notifications = propNotifications || storeNotifications;
  const sessionStatus = propStatus || storeSessionStatus;
  const hasKeyboard = useInputMode() === "mouse";
  const collapseHint = hasKeyboard ? withHint(t("common.close"), "toggleSidebar") : t("common.close");
  // Which terminals actually exist right now — the history rows are a snapshot
  // and can name one that has since closed.
  const liveSessionIds = useMemo(() => new Set(allSessions.map((s) => s.id)), [allSessions]);
  const activeCwd = activeSessionId
    ? (cwdBySession[activeSessionId] ?? allSessions.find((s) => s.id === activeSessionId)?.workspacePath ?? null)
    : null;

  // PWA install — desktop only, so the row shows solely when the browser can
  // actually install (Chromium beforeinstallprompt). Manual guides live in Settings.
  const canInstall = usePwaInstallStore((s) => s.canInstall);
  const isInstalled = usePwaInstallStore((s) => s.isInstalled);
  const install = usePwaInstallStore((s) => s.install);
  const isApp = typeof window !== "undefined" && (
    window.matchMedia("(display-mode: standalone)").matches || !!window.ReactNativeWebView
  );
  const showInstall = canInstall && !isApp && !isInstalled;

  // Resize handle
  const startResize = (e) => {
    e.stopPropagation();
    startWidthDrag(e, { startWidth: width, onWidth: (w) => onResize?.(w) });
  };

  // Context menu (right-click / long-press)
  const [ctxMenu, setCtxMenu] = useState(null); // { sessionId, x, y }
  const ctxRef = useRef(null);
  const ctxPos = useClampedMenu(ctxRef, ctxMenu?.left ?? 0, ctxMenu?.top ?? 0);

  // Rename prompt (shared modal — same UX as tab header and session list)
  const [renameDialog, setRenameDialog] = useState({ sessionId: null, name: "", value: "" });

  // Delete confirm
  const [delConfirm, setDelConfirm] = useState(null); // { sessionId, name }

  // Collapsed workspaces and their branch, both keyed by workspace id ("" = unassigned).
  const [collapsed, setCollapsed] = useState({});
  const toggleCollapsed = (key) => setCollapsed((c) => ({ ...c, [key]: !c[key] }));

  // New terminal modal scoped to a workspace (null = closed)
  const [createModalWsId, setCreateModalWsId] = useState(null);

  // Delete workspace confirm
  const [wsDelConfirm, setWsDelConfirm] = useState({ isOpen: false, workspaceId: null, workspaceName: "" });
  const confirmWsDelete = () => {
    if (wsDelConfirm.workspaceId !== null) onDeleteWorkspace?.(wsDelConfirm.workspaceId);
    setWsDelConfirm({ isOpen: false, workspaceId: null, workspaceName: "" });
  };

  // Drag reorder (within workspace)
  const { dragId, registerEl, startDrag, consumeClick } = useDragReorder({
    axis: "y",
    onCommit: onReorderSession
  });

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

  // Bucket sessions by workspace (order follows allSessions within each bucket)
  const grouped = groupSessionsByWorkspace(allSessions, workspaces, t("workspaces.ungrouped"));

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

  // Drag reorder via grip handle — reads target from dataset (stable handler)
  const startReorder = (e) => {
    const btn = e.currentTarget;
    const workspaceId = btn.dataset.gid === "" ? null : btn.dataset.gid;
    const grp = grouped.find((g) => (g.id ?? null) === (workspaceId ?? null));
    if (!grp || !connected) return;
    clearLongPress();
    startDrag(e, btn.dataset.sid, grp.items.map((i) => i.id));
  };

  const handleItemClick = (e) => {
    if (consumeClick()) return;
    vibrate();
    onSelectSession?.(e.currentTarget.dataset.sid);
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
        className="px-3 flex items-center justify-between flex-shrink-0 border-b border-border-subtle relative z-10"
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
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <span className="w-[10px] h-[10px] rounded-full bg-[#ff5f57]" />
                <span className="w-[10px] h-[10px] rounded-full bg-[#febc2e]" />
                <span className="w-[10px] h-[10px] rounded-full bg-[#28c840]" />
              </div>
              <span className="text-[13px] font-semibold text-text truncate">9Remote</span>
            </>
          )}
        </div>
        {onCollapse && (
          <button
            onClick={() => { vibrate(); onCollapse(); }}
            className="p-1 text-text-muted hover:text-text rounded-[3px] hover:bg-surface-2 transition-colors flex-shrink-0"
            title={collapseHint}
          >
            <PanelLeft size={14} />
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto modal-scrollable pt-1 relative z-10">
        {!grouped.length ? (
          <p className="px-3 py-6 text-center text-xs text-text-muted">{t("workspaces.emptyWorkspace")}</p>
        ) : (
          grouped.map((grp) => {
            const isActiveWorkspace = (grp.id ?? null) === (activeWorkspaceId ?? null);
            const wsKey = grp.id ?? "";
            return (
              <div key={grp.id ?? "ungrouped"} className="flex flex-col mt-3 first:mt-0">
                <WorkspaceHeader
                  workspace={grp}
                  isActive={isActiveWorkspace}
                  connected={connected}
                  fileBus={fileBus}
                  collapsed={!!collapsed[wsKey]}
                  onToggleCollapse={() => toggleCollapsed(wsKey)}
                  onSelect={grp.items.length && onSelectWorkspace ? () => { vibrate(); onSelectWorkspace(grp.id); } : null}
                  onNewTerminal={onCreateNamedSession ? () => setCreateModalWsId(grp.id ?? "") : null}
                  onDelete={onDeleteWorkspace && grp.id !== null
                    ? () => setWsDelConfirm({ isOpen: true, workspaceId: grp.id, workspaceName: grp.name })
                    : null}
                />
                {!collapsed[wsKey] && grp.items.map((s) => {
                  const st = sessionStatus[s.id]?.state || "idle";
                  const v = statusVisual(st);
                  const isActive = s.id === activeSessionId;
                  const hasNotif = !!notifications[s.id];
                  const tool = sessionStatus[s.id]?.tool;
                  const isDragging = dragId === s.id;
                  return (
                    <div
                      key={s.id}
                      ref={registerEl(s.id)}
                      data-sid={s.id}
                      className={`group w-full flex items-center gap-1.5 pl-5 pr-2 py-1.5 text-left border-l-2 relative cursor-pointer ${
                        isActive
                          ? "bg-text/8 border-brand-500 text-text"
                          : "border-transparent text-text-muted hover:bg-text/5 hover:text-text"
                      } ${isDragging ? "z-20 opacity-90 shadow-lg ring-1 ring-brand-500" : "transition-colors"}`}
                      onClick={handleItemClick}
                      onContextMenu={openContext}
                      onTouchStart={handleTouchStart}
                      onTouchMove={clearLongPress}
                      onTouchEnd={clearLongPress}
                    >
                      {connected && (
                        <button
                          data-gid={grp.id ?? ""}
                          data-sid={s.id}
                          onPointerDown={startReorder}
                          disabled={grp.items.length < 2}
                          className="absolute left-0 top-1/2 -translate-y-1/2 z-10 p-0.5 text-text-subtle opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing touch-none disabled:opacity-0 disabled:cursor-default"
                          tabIndex={-1}
                        >
                          <GripVertical size={12} />
                        </button>
                      )}
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 term-dot ${v.cls}${v.pulse ? ` pulse-${v.pulse}` : ""}`} style={{ background: v.dot }} />
                      <span className="flex-1 min-w-0 flex flex-col">
                        <span className={`flex items-center gap-1 min-w-0 ${isActive ? "font-medium" : ""}`}>
                          {AGENT_ICONS[tool] ? (
                            <img src={AGENT_ICONS[tool]} alt={tool} className="w-3 h-3 flex-shrink-0 object-contain" />
                          ) : (
                            <Terminal size={12} className="flex-shrink-0" />
                          )}
                          <span className="text-[11px] truncate" data-tip={s.name || t("terminal.defaultName")}>{s.name || t("terminal.defaultName")}</span>
                        </span>
                        <SessionMeta
                          fileBus={fileBus}
                          cwd={cwdBySession[s.id] ?? s.workspacePath}
                          basePath={workspaceGitPath(grp)}
                          homeDir={homeDir}
                        />
                      </span>
                      {/* Unread output on a terminal the user isn't looking at */}
                      {hasNotif && !isActive && (
                        <span className="w-1.5 h-1.5 rounded-full bg-brand-500 flex-shrink-0" title={t("notifications.replied")} />
                      )}
                    </div>
                  );
                })}
                {!collapsed[wsKey] && grp.items.length === 0 && (
                  <button
                    onClick={(e) => { e.stopPropagation(); vibrate(); setCreateModalWsId(grp.id ?? ""); }}
                    disabled={!connected}
                    className="pl-3 pr-2 py-1.5 text-left text-xs text-text-subtle hover:text-brand-500 italic transition-colors disabled:opacity-40"
                  >
                    {t("workspaces.emptyWorkspace")}
                  </button>
                )}
              </div>
            );
          })
        )}

        {onAddWorkspace && (
          <div className="px-2 pt-3 pb-1">
            <button
              onClick={() => { vibrate(); onAddWorkspace(); }}
              disabled={!connected}
              className="w-full flex items-center justify-center gap-1.5 py-1.5 px-3 text-xs text-text-subtle hover:text-text border border-dashed border-border-subtle hover:border-text-muted/40 rounded-brand hover:bg-surface-2 transition-colors disabled:opacity-40"
            >
              <Plus size={12} className="flex-shrink-0" />
              <span>{t("workspaces.newWorkspace")}</span>
            </button>
          </div>
        )}
      </div>

      {/* Past agent-CLI conversations for wherever the active terminal is standing —
          pinned above the footer so it keeps its place as the session list scrolls. */}
      {onResumeAgentSession && (
        <AgentHistoryPanel
          busRef={busRef}
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

      {/* Delete workspace confirm */}
      <ConfirmDialog
        isOpen={wsDelConfirm.isOpen}
        onClose={() => setWsDelConfirm({ isOpen: false, workspaceId: null, workspaceName: "" })}
        onConfirm={confirmWsDelete}
        title={t("workspaces.deleteTitle")}
        message={t("workspaces.deleteMessage", { name: wsDelConfirm.workspaceName })}
      />

      {/* New terminal modal (scoped to a workspace) */}
      {createModalWsId !== null && (
        <NewTerminalModal
          onClose={() => setCreateModalWsId(null)}
          onCreate={(name, shellId, agent, yolo, cwd, nameIsAuto) => {
            const wsId = createModalWsId === "" ? null : createModalWsId;
            onCreateNamedSession?.(name, wsId, shellId, cwd || null, agent, yolo, nameIsAuto);
          }}
          shells={shells}
          busRef={busRef}
          onResumeAgentSession={onResumeAgentSession}
          onSelectSession={onSelectSession}
          liveSessionIds={liveSessionIds}
          activeSessionId={activeSessionId}
          connected={connected}
          workspacePath={workspaces.find((w) => w.id === createModalWsId)?.path || null}
          workspaceName={workspaces.find((w) => w.id === createModalWsId)?.name || ""}
          fileBus={fileBus}
          homeDir={homeDir}
          suggestName={`${t("terminal.defaultName")} ${(allSessions.filter(s => sessionWorkspaceId(s) === (createModalWsId === "" ? null : createModalWsId)).length + 1)}`}
        />
      )}

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
          <button
            onClick={() => startRename(ctxMenu.sessionId)}
            className="w-full text-left px-2.5 py-1.5 text-xs text-text hover:bg-surface-2/80 rounded-[6px] flex items-center gap-2"
          >
            <Pencil size={13} /> {t("sessions.editName")}
          </button>
          {sessionStatus[ctxMenu.sessionId]?.conversationId && (
            <button
              onClick={() => {
                vibrate();
                busRef?.current?.emit("session-resume", { sessionId: ctxMenu.sessionId });
                setCtxMenu(null);
              }}
              className="w-full text-left px-2.5 py-1.5 text-xs text-text hover:bg-surface-2/80 rounded-[6px] flex items-center gap-2"
            >
              <RotateCw size={13} /> {t("sessions.resumeSession")}
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
