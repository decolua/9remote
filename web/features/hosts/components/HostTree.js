"use client";

import { useEffect, useState } from "react";
import { useTreeCollapse, TREE_ROOT } from "@/features/hosts/lib/treeCollapse";
import { EyeOff, GripVertical, Loader2, MoreHorizontal, Plus } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { useFleetStore } from "@/shared/stores/fleetStore";
import { connOf } from "@/shared/transport/hostConn";
import { statusVisual } from "@/shared/utils/statusVisual";
import { useDragReorder } from "@/features/terminal/hooks/useDragReorder";
import { workspaceGitPath } from "@/features/terminal/lib/workspaceGrouping";
import WorkspaceHeader from "@/features/terminal/components/WorkspaceHeader";
import SessionAgentIcon from "@/features/terminal/components/SessionAgentIcon";
import SessionMeta from "@/features/terminal/components/SessionMeta";
import PromptDialog from "@/shared/components/ui/PromptDialog";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import IconMenu from "@/shared/components/ui/IconMenu";
import NewTerminalModal from "@/shared/components/ui/NewTerminalModal";
import FolderPickerModal from "@/features/terminal/components/FolderPickerModal";
import { addRecentWorkspace } from "@/features/fileExplorer/components/WorkspaceList";
import HostTreeRow from "./HostTreeRow";
import { hostTree } from "../lib/fleetTree";

/**
 * ONE tree per host — the main host's and every other host's render through this.
 * The tree is host-agnostic: it draws `host` (label/status/workspaces/sessions/
 * statusMap, RAW ids) and acts through `actions` (the seam where main-host nav
 * and fleet-bus emits meet — see makeFleetActions). Whatever an action set leaves
 * null, its affordance simply does not render.
 */
export default function HostTree({
  host,
  actions = {},
  busRef = null,               // modal shells/agent-clis source (main or fleet)
  activeSessionId = null,
  activeWorkspaceId = null,    // RAW workspace id (null = ungrouped), if active
  connected = true,
  fileBus = null,              // git branch badges — main host only
  homeDir = null,
  hiddenPaneSessionIds = [],
  onUnhidePane = null,
  onAddWorkspace = null,       // custom flow (main host's folder picker); null = name prompt
  menuAddWorkspace = null,     // root menu's "New workspace" entry (main host)
  // Main-host extras. When present they take over: the rich context menu replaces
  // the built-in ⋯, per-session agent map outranks the session's own field, and
  // live cwd map feeds SessionMeta.
  onRowContextMenu = null,     // (e, sessionId, name)
  onRowTouch = null,           // { start, move, end } — long-press menu
  onRowMenu = null,            // (sessionId, name, rect) — rich ⋯ menu
  agentBySession = null,
  cwdBySession = null,
  treeCls = "pl-3.5",
  mobile = false,             // bigger fonts + touch-sized buttons (mobile session list)
  rowCls = "hover:bg-text/5 hover:text-text"
}) {
  const { t } = useI18n();
  const { isCollapsed, toggle: toggleNode } = useTreeCollapse(host.key);
  const open = !isCollapsed(TREE_ROOT);
  const [termModalWs, setTermModalWs] = useState(null);   // workspace id the modal creates in
  const [wsRename, setWsRename] = useState(null);         // {id, value}
  const [wsDelete, setWsDelete] = useState(null);         // {id, name}
  const [sessRename, setSessRename] = useState(null);     // {id, value}
  const [sessDelete, setSessDelete] = useState(null);     // {id, name}
  const [wsPicker, setWsPicker] = useState(false);        // fleet add-workspace folder picker
  const [shells, setShells] = useState([]);

  const status = host.status || "full";
  const connecting = status === "connecting";
  // Honest readiness: "connecting" is NOT online — affordances stay disabled until
  // the bus actually answers, and queued commands cover the transition.
  const online = status === "full" || status === "online";
  // Each host answers for itself: the main host's bus state must never gate a
  // fleet host's actions (and vice versa).
  const actionable = status === "full" ? connected : online;
  // Only a host with a live signal expands: a dead host's cached sessions render
  // as if usable while every tap just blinks. "online" from the batched liveness
  // read still opens the bus lazily on expand; a bus that then fails flips the
  // host offline and the tree collapses on its own.
  const expandable = online;
  // Fleet hosts resolve their own bus/file API through hostConn (stable identity,
  // always-fresh current); the main host passes its own ref.
  const fleetConn = status !== "full" ? connOf(host.key) : null;
  const busTag = busRef || fleetConn?.busRef || null;

  // Shells for the new-terminal modal, fetched from THIS host's bus on demand.
  useEffect(() => {
    if (termModalWs === null || !busTag?.current?.emit) return;
    busTag.current.emit("getShells", (res) => setShells(res?.shells || []));
  }, [termModalWs, busTag]);

  const { dragId, registerEl, startDrag, consumeClick } = useDragReorder({
    axis: "y",
    onCommit: (orderedIds) => actions.reorderSession?.(orderedIds)
  });

  const groups = hostTree(host.sessions, host.workspaces);

  const createIn = (name, shellId, agent, yolo, cwd, nameIsAuto) => {
    actions.createSession?.(name, termModalWs === "ungrouped" ? null : termModalWs, shellId, cwd, agent, yolo, nameIsAuto);
    setTermModalWs(null);
  };

  return (
    <div>
      <HostTreeRow
        mobile={mobile}
        hostKey={host.key}
        label={host.label}
        connected={online}
        connecting={connecting}
        mutedOffline={status !== "full"}
        collapsed={!open}
        meta={connecting ? <Loader2 size={12} className="animate-spin text-text-subtle" /> : null}
        onToggleCollapse={expandable ? () => {
          vibrate();
          if (!open) useFleetStore.getState().ensureHost(host.key); // expanding opens the bus
          toggleNode(TREE_ROOT);
        } : null}
        onRetry={status === "offline" ? () => useFleetStore.getState().retryHost(host.key) : null}
        onDisconnect={host.onDisconnect}
        // The add-workspace door only exists on a host that can answer (its picker
        // browses that machine's disks); offline/connecting rows hide it.
        onAddWorkspace={actionable ? (menuAddWorkspace ?? (status !== "full" ? () => setWsPicker(true) : null)) : null}
        onRename={actions.renameHost}
        onDelete={actions.deleteHost}
        showAdd={false}
      />

      {open && expandable && (
        <div className={treeCls}>
          {!groups.length && (
            <p className="px-3 py-6 text-center text-xs text-text-muted">{t("workspaces.emptyWorkspace")}</p>
          )}
          {groups.map(({ workspace, sessions }) => {
            const rawId = workspace?.id ?? null;
            const wsKey = rawId ?? "ungrouped";
            // Callers hand undefined when the active workspace belongs to another
            // host — null means THIS host's ungrouped is active.
            const isActiveWs = activeWorkspaceId === rawId;
            return (
              <div key={wsKey} className="flex flex-col mt-2 first:mt-0">
                <WorkspaceHeader
                  mobile={mobile}
                  workspace={{ id: rawId, name: workspace?.name || t("workspaces.ungrouped"), path: workspace?.path || null, items: sessions }}
                  isActive={isActiveWs}
                  connected={actionable}
                  fileBus={fileBus}
                  collapsed={isCollapsed(wsKey)}
                  onToggleCollapse={() => toggleNode(wsKey)}
                  onSelect={actions.selectWorkspace ? () => { vibrate(); actions.selectWorkspace(rawId); } : null}
                  onNewTerminal={actions.createSession ? () => setTermModalWs(wsKey) : null}
                  onRename={actions.renameWorkspace && rawId != null ? () => setWsRename({ id: rawId, value: workspace.name }) : null}
                  onDelete={actions.deleteWorkspace && rawId != null ? () => setWsDelete({ id: rawId, name: workspace.name }) : null}
                />
                {!isCollapsed(wsKey) && sessions.map((s) => {
                  const st = host.statusMap?.[s.id]?.state || "idle";
                  const v = statusVisual(st);
                  const isActive = activeSessionId === s.id;
                  const isDragging = dragId === s.id;
                  const hidden = hiddenPaneSessionIds.includes(s.id);
                  const title = s.name || t("terminal.defaultName");
                  return (
                    <div
                      key={s.id}
                      ref={registerEl(s.id)}
                      data-sid={s.id}
                      className={`group flex items-center gap-1.5 pl-3.5 pr-2 py-1.5 ml-0.5 rounded-[3px] text-left relative cursor-pointer touch-manipulation touch-pan-y ${
                        isActive ? "bg-brand-500/15 text-text" : `text-text-muted ${rowCls}`
                      } ${isDragging ? "z-20 opacity-90 shadow-lg ring-1 ring-brand-500" : "transition-colors"}`}
                      onClick={(e) => { if (consumeClick()) return; vibrate(); actions.selectSession?.(s.id); }}
                      onContextMenu={onRowContextMenu ? (e) => onRowContextMenu(e, s.id, title) : undefined}
                      onTouchStart={onRowTouch?.start}
                      onTouchMove={onRowTouch?.move}
                      onTouchEnd={onRowTouch?.end}
                    >
                      {actionable && (
                        <button
                          data-gid={wsKey === "ungrouped" ? "" : rawId}
                          data-sid={s.id}
                          onPointerDown={(e) => startDrag(e, s.id, sessions.map((i) => i.id))}
                          disabled={sessions.length < 2}
                          className="absolute left-0 top-1/2 -translate-y-1/2 z-10 p-0.5 text-text-subtle opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing touch-none disabled:opacity-0 disabled:cursor-default"
                          tabIndex={-1}
                        >
                          <GripVertical size={12} />
                        </button>
                      )}
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 term-dot ${v.cls}${v.pulse ? ` pulse-${v.pulse}` : ""}`} style={{ background: v.dot }} />
                      <span className="flex-1 min-w-0 flex flex-col">
                        <span className={`flex items-center gap-1 min-w-0 ${isActive ? "font-medium" : ""}`}>
                          <SessionAgentIcon agent={agentBySession?.[s.id] ?? s.agent} tool={host.statusMap?.[s.id]?.tool} />
                          <span className={`${mobile ? "text-base" : "text-[11px]"} truncate`} data-tip={title}>{title}</span>
                          {hidden && onUnhidePane && (
                            <button
                              type="button"
                              tabIndex={-1}
                              onPointerDown={(e) => e.stopPropagation()}
                              onMouseDown={(e) => e.stopPropagation()}
                              onClick={(e) => { e.stopPropagation(); vibrate(); onUnhidePane(s.id); }}
                              className="p-0.5 rounded text-amber-400 hover:text-amber-300 hover:bg-amber-400/20 transition-colors flex items-center justify-center shrink-0 ml-1"
                              title={t("sessions.showPanel") || "Show panel"}
                            >
                              <EyeOff size={12} />
                            </button>
                          )}
                        </span>
                        <SessionMeta
                          mobile={mobile}
                          fileBus={fileBus}
                          cwd={cwdBySession?.[s.id] ?? s.cwd ?? s.workspacePath}
                          basePath={workspaceGitPath({ path: workspace?.path || null, items: sessions })}
                          homeDir={homeDir}
                        />
                      </span>
                      {/* Row actions — the ExplorerRow door: text runs full width,
                          hover floats the cluster over its end with a backdrop. */}
                      <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center px-1 rounded-[3px] bg-surface-2 opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-60 transition-opacity">
                        {onRowMenu ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              vibrate();
                              const r = e.currentTarget.getBoundingClientRect();
                              onRowMenu(s.id, title, r);
                            }}
                            className="p-0.5 text-text-subtle hover:text-text rounded-[2px] transition-colors"
                            title={t("sessions.sessionActions")}
                          >
                            <MoreHorizontal size={13.5} />
                          </button>
                        ) : (
                          <IconMenu
                            size={13.5}
                            label={t("sessions.sessionActions")}
                            revealCls=""
                            items={[
                              actions.renameSession && {
                                label: t("sessions.editName"),
                                onClick: () => setSessRename({ id: s.id, value: s.name || "" })
                              },
                              actions.deleteSession && {
                                label: t("sessions.deleteTitle"), danger: true,
                                onClick: () => setSessDelete({ id: s.id, name: s.name || "" })
                              }
                            ]}
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
                {!isCollapsed(wsKey) && sessions.length === 0 && (
                  <button
                    onClick={() => { vibrate(); setTermModalWs(wsKey); }}
                    disabled={!actionable}
                    className="pl-3.5 pr-2 py-1.5 text-left text-xs text-text-subtle hover:text-brand-500 italic transition-colors disabled:opacity-40"
                  >
                    {t("workspaces.emptyWorkspace")}
                  </button>
                )}
              </div>
            );
          })}

          <div className="px-2 pt-3 pb-1">
            <button
              onClick={() => { vibrate(); if (onAddWorkspace) onAddWorkspace(); else setWsPicker(true); }}
              disabled={!actionable}
              className="mx-auto flex items-center gap-1.5 py-1.5 px-4 text-xs text-text-subtle hover:text-text border border-dashed border-border-subtle hover:border-text-muted/40 rounded-brand hover:bg-surface-2 transition-colors disabled:opacity-40"
            >
              <Plus size={12} className="flex-shrink-0" />
              <span>{t("workspaces.newWorkspace")}</span>
            </button>
          </div>
        </div>
      )}

      {termModalWs !== null && (
        <NewTerminalModal
          onClose={() => setTermModalWs(null)}
          onCreate={createIn}
          shells={shells}
          busRef={busTag}
          hostKey={host.key}
          liveSessionIds={null}
          connected={actionable}
          workspacePath={host.workspaces?.find((w) => w.id === (termModalWs === "ungrouped" ? null : termModalWs))?.path || null}
          workspaceName={termModalWs === "ungrouped" ? t("workspaces.ungrouped") : host.workspaces?.find((w) => w.id === termModalWs)?.name || ""}
          suggestName={`${t("terminal.defaultName")} ${(host.sessions?.length || 0) + 1}`}
        />
      )}

      {wsPicker && fleetConn && (
        <FolderPickerModal
          fileBus={fleetConn.fileBus}
          scope={fleetConn.scope}
          onSelect={(folderPath) => {
            setWsPicker(false);
            if (!folderPath) return;
            // Main-flow parity (layout.js createWorkspaceAt): name from the folder,
            // recents on this host's scope, then the workspace's first terminal
            // opens — and auto-switches.
            const name = folderPath.split("/").filter(Boolean).pop() || folderPath;
            addRecentWorkspace(folderPath, fleetConn.scope);
            actions.createWorkspace?.(name, folderPath, (result) => {
              const ws = result?.workspace || result?.group;
              if (!result?.success || !ws?.id) return;
              actions.createSession?.(null, ws.id, null, folderPath);
            });
          }}
          onClose={() => setWsPicker(false)}
        />
      )}

      {wsRename !== null && (
        <PromptDialog
          title={t("workspaces.rename")}
          value={wsRename.value}
          onChange={(value) => setWsRename({ ...wsRename, value })}
          onSubmit={() => {
            const name = wsRename.value.trim();
            if (name) actions.renameWorkspace?.(wsRename.id, name);
            setWsRename(null);
          }}
          onClose={() => setWsRename(null)}
        />
      )}

      {wsDelete !== null && (
        <ConfirmDialog
          isOpen
          onClose={() => setWsDelete(null)}
          onConfirm={() => { actions.deleteWorkspace?.(wsDelete.id); setWsDelete(null); }}
          title={t("workspaces.deleteTitle")}
          message={t("workspaces.deleteMessage", { name: wsDelete.name })}
          confirmText={t("common.delete")}
        />
      )}

      {sessRename !== null && (
        <PromptDialog
          title={t("sessions.editName")}
          value={sessRename.value}
          onChange={(value) => setSessRename({ ...sessRename, value })}
          onSubmit={() => {
            const name = sessRename.value.trim();
            if (name) actions.renameSession?.(sessRename.id, name);
            setSessRename(null);
          }}
          onClose={() => setSessRename(null)}
        />
      )}

      {sessDelete !== null && (
        <ConfirmDialog
          isOpen
          onClose={() => setSessDelete(null)}
          onConfirm={() => { actions.deleteSession?.(sessDelete.id); setSessDelete(null); }}
          title={t("sessions.deleteTitle")}
          message={t("sessions.deleteMessage", { name: sessDelete.name || "" })}
          confirmText={t("common.delete")}
        />
      )}
    </div>
  );
}
