"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal, Plus, Pencil, Trash2, GripVertical, ChevronRight, PanelLeft, Settings, Download } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { usePwaInstallStore } from "@/shared/stores/pwaInstallStore";
import { statusVisual } from "@/shared/utils/statusVisual";
import { AGENT_ICONS } from "../constants/agentLabels";
import { vibrate } from "@/shared/utils/vibration";
import NewTerminalModal from "@/shared/components/ui/NewTerminalModal";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import useClampedMenu from "@/shared/hooks/useClampedMenu";
import { SIDEBAR_WIDTH } from "../constants/terminalConfig";
import { PANEL_HEADER_HEIGHT } from "@/shared/constants/layout";
import { groupSessionsByWorkspace, shortenHomePath, workspaceGitPath } from "../lib/workspaceGrouping";
import { useWorkspaceGit } from "../hooks/useWorkspaceGit";
import { sessionWorkspaceId } from "../lib/paneLayout";
import BranchBadge from "./BranchBadge";

// Guess agent tool from session name when no live status tool is set — drives the icon.
const TOOL_KEYWORDS = ["claude", "codex", "gemini", "opencode", "grok", "cursor", "copilot", "amp", "pi", "kiro", "qoder", "factory", "codebuddy", "rovodev", "hermes", "antigravity"];
function guessTool(name = "") {
  const lower = String(name).toLowerCase();
  for (const k of TOOL_KEYWORDS) if (lower.includes(k)) return k;
  return null;
}

// Second line of a terminal item: the branch of its own workspacePath, plus the state
// when something is happening. The agent's name is not repeated — the icon in the row
// already says which one it is, and "claude" next to a Claude logo says it twice.
// Branch lives on the workspace header; a card repeats it only when the terminal's live
// checkout (OSC 7 cwd) diverges from the workspace branch — e.g. cd into another worktree.
export function SessionMeta({ session, fileSocket, cwd, basePath, homeDir }) {
  const { branch, dirty } = useWorkspaceGit(cwd, fileSocket);
  const { branch: baseBranch } = useWorkspaceGit(basePath, fileSocket);
  // Divergence needs a workspace branch to diverge from — a non-git workspace root
  // (folder of repos) has none, so cards stay quiet instead of each naming its own.
  const diverged = !!branch && !!baseBranch && branch !== baseBranch;
  // Second line, in priority order: diverged branch → live folder relative to the
  // workspace root → shell id when parked at the root (the only non-duplicate info left).
  const atRoot = cwd && basePath ? cwd === basePath : true;
  const meta = diverged ? null
    : cwd && basePath && cwd.startsWith(`${basePath}/`) ? cwd.slice(basePath.length + 1)
    : atRoot ? session.shellId
    : shortenHomePath(cwd, homeDir);
  return (
    <span className="text-[11px] text-text-subtle truncate leading-tight flex items-center gap-1.5 min-h-[13px]">
      {diverged && <BranchBadge branch={branch} dirty={dirty} className="truncate italic" />}
      {meta && <span className="truncate opacity-70">{meta}</span>}
    </span>
  );
}

// One workspace row: collapse chevron, name, shortened path + branch, actions.
function WorkspaceHeader({
  workspace, isActive, connected, homeDir, collapsed, fileSocket,
  onToggleCollapse, onSelect, onNewTerminal, onDelete
}) {
  const { t } = useI18n();
  const gitPath = workspaceGitPath(workspace);
  const { branch, dirty } = useWorkspaceGit(gitPath, fileSocket);
  // Hover-reveal on pointer devices; always visible on touch, which has no hover.
  // Always visible: hiding them until hover meant a workspace's own actions were
  // undiscoverable, and there is no hover at all on a touch screen.
  const revealCls = "opacity-60 hover:opacity-100 focus-visible:opacity-100";

  return (
    <div
      onClick={onSelect}
      className={`pr-2 py-1 flex items-center gap-1 group/grp transition-colors ${
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
        <span className={`text-[12px] font-medium uppercase truncate ${isActive ? "text-text" : "text-text-muted"}`}>
          {workspace.name}
        </span>
        {gitPath && (
          <span className="text-[10px] text-text-subtle leading-tight flex items-center gap-1 min-w-0">
            <span className="truncate">{shortenHomePath(gitPath, homeDir)}</span>
            {/* Hidden when the workspace name already is the branch — never repeat a label */}
            {branch && branch !== workspace.name && (
              <BranchBadge branch={branch} dirty={dirty} className="truncate flex-shrink-0 max-w-[7rem]" />
            )}
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
          title={t("terminal.newTerminal")}
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
export default function TerminalSidebar({
  allSessions = [],
  workspaces = [],
  activeSessionId,
  activeWorkspaceId,
  sessionStatus = {},
  notifications = {},
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
  socketRef = null,
  fileSocket,
  homeDir,
  cwdBySession = {},
  connected = true,
  width = SIDEBAR_WIDTH.default,
  onResize,
  onCollapse,
}) {
  const { t } = useI18n();
  const dragRef = useRef(null);

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
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev) => onResize?.(startW + ev.clientX - startX);
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  // Context menu (right-click / long-press)
  const [ctxMenu, setCtxMenu] = useState(null); // { sessionId, x, y }
  const ctxRef = useRef(null);
  const ctxPos = useClampedMenu(ctxRef, ctxMenu?.left ?? 0, ctxMenu?.top ?? 0);

  // Rename inline
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const renameInputRef = useRef(null);

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
  const [drag, setDrag] = useState(null); // { workspaceId, ids, fromIdx, overIdx, el }
  const suppressClickRef = useRef(false);

  useEffect(() => { if (editingId) requestAnimationFrame(() => { renameInputRef.current?.focus(); const el = renameInputRef.current; if (el) el.setSelectionRange(el.value.length, el.value.length); }); }, [editingId]);

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
    const s = sessionById(sessionId);
    setEditingId(sessionId);
    setEditName(s?.name || "");
    setCtxMenu(null);
  };
  const saveRename = () => {
    if (editingId && editName.trim()) onRenameSession?.(editingId, editName.trim());
    setEditingId(null);
    setEditName("");
  };

  // Drag reorder via grip handle — reads target from dataset (stable handler)
  const startReorder = (e) => {
    const btn = e.currentTarget;
    const workspaceId = btn.dataset.gid === "" ? null : btn.dataset.gid;
    const fromIdx = Number(btn.dataset.idx);
    const grp = grouped.find((g) => (g.id ?? null) === (workspaceId ?? null));
    if (!grp) return;
    const ids = grp.items.map((i) => i.id);
    if (!connected || ids.length < 2) return;
    e.preventDefault();
    e.stopPropagation();
    clearLongPress();
    const el = btn.closest("[data-item-row]");
    dragRef.current = { workspaceId, ids, fromIdx, overIdx: fromIdx, el, moved: false, startX: e.clientX, startY: e.clientY };
    setDrag({ fromIdx, overIdx: fromIdx, sessionId: ids[fromIdx] });
    try { el.setPointerCapture(e.pointerId); } catch {}
  };

  useEffect(() => {
    if (!drag) return;
    const findOver = (x, y) => {
      const rowEl = document.elementFromPoint(x, y)?.closest("[data-item-row]");
      if (!rowEl) return null;
      const id = rowEl.getAttribute("data-sid");
      return id || null;
    };
    const onMove = (e) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (!d.moved && Math.hypot(dx, dy) > 3) d.moved = true;
      if (d.moved) {
        d.el.style.zIndex = "50";
        d.el.style.transform = `translate(${dx}px, ${dy}px)`;
      }
      const overId = findOver(e.clientX, e.clientY);
      if (overId && overId !== d.ids[d.overIdx]) {
        const newIdx = d.ids.indexOf(overId);
        if (newIdx !== -1) { d.overIdx = newIdx; setDrag({ ...drag, overIdx: newIdx }); }
      }
    };
    const onUp = () => {
      const d = dragRef.current;
      if (d) {
        suppressClickRef.current = d.moved;
        d.el.style.transform = "";
        d.el.style.zIndex = "";
        if (d.fromIdx !== d.overIdx) {
          const ids = [...d.ids];
          const [moved] = ids.splice(d.fromIdx, 1);
          ids.splice(d.overIdx, 0, moved);
          onReorderSession?.(ids);
          vibrate();
        }
      }
      dragRef.current = null;
      setDrag(null);
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [drag, onReorderSession]);

  const handleItemClick = (e) => {
    if (suppressClickRef.current) { suppressClickRef.current = false; return; }
    const sessionId = e.currentTarget.dataset.sid;
    if (editingId === sessionId) return;
    vibrate();
    onSelectSession?.(sessionId);
  };

  const handleTouchStart = (e) => {
    const sessionId = e.currentTarget.dataset.sid;
    if (editingId === sessionId) return;
    startLongPress(e);
  };

  return (
    <div
      className="flex-shrink-0 h-full hidden sm:flex flex-col bg-surface-3 border-r border-border-subtle relative"
      style={{ width }}
    >
      <div
        style={{ height: PANEL_HEADER_HEIGHT }}
        className="px-3 flex items-center justify-between flex-shrink-0 border-b border-border-subtle"
      >
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <span className="w-[10px] h-[10px] rounded-full bg-[#ff5f57]" />
            <span className="w-[10px] h-[10px] rounded-full bg-[#febc2e]" />
            <span className="w-[10px] h-[10px] rounded-full bg-[#28c840]" />
          </div>
          <span className="text-[13px] font-semibold text-text truncate">9Remote</span>
        </div>
        {onCollapse && (
          <button
            onClick={() => { vibrate(); onCollapse(); }}
            className="p-1 text-text-muted hover:text-text rounded-[3px] hover:bg-surface-2 transition-colors flex-shrink-0"
            title={t("common.close")}
          >
            <PanelLeft size={14} />
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto modal-scrollable pt-1">
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
                  homeDir={homeDir}
                  fileSocket={fileSocket}
                  collapsed={!!collapsed[wsKey]}
                  onToggleCollapse={() => toggleCollapsed(wsKey)}
                  onSelect={grp.items.length && onSelectWorkspace ? () => { vibrate(); onSelectWorkspace(grp.id); } : null}
                  onNewTerminal={onCreateNamedSession ? () => setCreateModalWsId(grp.id ?? "") : null}
                  onDelete={onDeleteWorkspace && grp.id !== null
                    ? () => setWsDelConfirm({ isOpen: true, workspaceId: grp.id, workspaceName: grp.name })
                    : null}
                />
                {!collapsed[wsKey] && grp.items.map((s, idx) => {
                  const st = sessionStatus[s.id]?.state || "idle";
                  const v = statusVisual(st);
                  const isActive = s.id === activeSessionId;
                  const hasNotif = !!notifications[s.id];
                  const tool = sessionStatus[s.id]?.tool || guessTool(s.name);
                  const isDragOver = drag?.sessionId && drag.overIdx === idx && s.id !== drag.sessionId && drag;
                  return (
                    <div
                      key={s.id}
                      data-item-row
                      data-sid={s.id}
                      className={`group w-full flex items-center gap-1.5 pl-3.5 pr-2 py-0.5 text-left transition-colors border-l-2 relative cursor-pointer ${
                        isActive
                          ? "bg-text/8 border-brand-500 text-text"
                          : "border-transparent text-text-muted hover:bg-text/5 hover:text-text"
                      } ${isDragOver ? "ring-1 ring-brand-500" : ""}`}
                      onClick={handleItemClick}
                      onContextMenu={openContext}
                      onTouchStart={handleTouchStart}
                      onTouchMove={clearLongPress}
                      onTouchEnd={clearLongPress}
                      title={s.name}
                    >
                      {connected && (
                        <button
                          data-gid={grp.id ?? ""}
                          data-idx={idx}
                          onPointerDown={startReorder}
                          disabled={grp.items.length < 2}
                          className="absolute left-0 top-1/2 -translate-y-1/2 z-10 p-0.5 text-text-subtle opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing touch-none disabled:opacity-0 disabled:cursor-default bg-surface-3"
                          title={t("sessions.editName")}
                          tabIndex={-1}
                        >
                          <GripVertical size={12} />
                        </button>
                      )}
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 term-dot ${v.cls}${v.pulse ? ` pulse-${v.pulse}` : ""}`} style={{ background: v.dot }} />
                      <span className="flex-1 min-w-0 flex flex-col">
                        {editingId === s.id ? (
                          <input
                            ref={renameInputRef}
                            type="text"
                            value={editName}
                            onClick={(e) => e.stopPropagation()}
                            onInput={(e) => setEditName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") saveRename();
                              if (e.key === "Escape") { setEditingId(null); setEditName(""); }
                            }}
                            onBlur={saveRename}
                            className="bg-transparent border-b border-brand-500 outline-none text-sm text-text max-w-full"
                          />
                        ) : (
                          <>
                            <span className={`flex items-center gap-1 min-w-0 ${isActive ? "font-medium" : ""}`}>
                              {AGENT_ICONS[tool] ? (
                                <img src={AGENT_ICONS[tool]} alt={tool} className="w-3.5 h-3.5 flex-shrink-0" />
                              ) : (
                                <Terminal size={13} className="flex-shrink-0" />
                              )}
                              <span className="text-[13px] truncate">{s.name || t("terminal.defaultName")}</span>
                            </span>
                            <SessionMeta
                              session={s}
                              fileSocket={fileSocket}
                              cwd={cwdBySession[s.id] ?? s.workspacePath}
                              basePath={workspaceGitPath(grp)}
                              homeDir={homeDir}
                            />
                          </>
                        )}
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
          <button
            onClick={() => { vibrate(); onAddWorkspace(); }}
            disabled={!connected}
            className="mt-2 mb-1 flex items-center gap-1.5 pl-3.5 pr-2 py-1.5 text-left text-xs text-text-subtle hover:text-brand-500 transition-colors disabled:opacity-40"
          >
            <Plus size={12} className="flex-shrink-0" />
            {t("workspaces.newWorkspace")}
          </button>
        )}
      </div>

      {(showInstall || onOpenSettings) && (
        <div className="p-1.5 border-t border-border-subtle flex-shrink-0">
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
          onCreate={(name, shellId, agent, yolo) => {
            const wsId = createModalWsId === "" ? null : createModalWsId;
            onCreateNamedSession?.(name, wsId, shellId, null, agent, yolo);
          }}
          shells={shells}
          socketRef={socketRef}
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
          className="fixed z-[70] bg-surface-2 border border-border-subtle rounded-[3px] shadow-lg py-1 min-w-[160px]"
          style={{ left: ctxPos.left, top: ctxPos.top }}
        >
          <button
            onClick={() => startRename(ctxMenu.sessionId)}
            className="w-full text-left px-3 py-1.5 text-sm text-text hover:bg-surface-3 flex items-center gap-2"
          >
            <Pencil size={14} /> {t("sessions.editName")}
          </button>

          <div className="h-px bg-border-subtle my-1" />
          <button
            onClick={() => { setDelConfirm({ sessionId: ctxMenu.sessionId, name: ctxMenu.name }); setCtxMenu(null); }}
            className="w-full text-left px-3 py-1.5 text-sm text-red-500 hover:bg-red-500/10 flex items-center gap-2"
          >
            <Trash2 size={14} /> {t("sessions.deleteTitle")}
          </button>
        </div>
      )}

      {/* Delete confirm */}
      {delConfirm && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/70"
          onClick={() => setDelConfirm(null)}
        >
          <div className="bg-surface rounded-[3px] p-5 w-80 shadow-elev" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm text-text mb-4">{t("sessions.deleteMessage", { name: delConfirm.name })}</p>
            <div className="flex gap-2">
              <button
                onClick={() => { if (delConfirm.sessionId) onDeleteSession?.(delConfirm.sessionId); setDelConfirm(null); }}
                className="flex-1 py-2 text-sm font-semibold text-white bg-red-500 hover:bg-red-600 rounded-[3px] transition-colors"
              >
                {t("common.delete")}
              </button>
              <button
                onClick={() => setDelConfirm(null)}
                className="flex-1 py-2 text-sm text-text-muted bg-surface-2 hover:bg-surface-3 rounded-[3px] transition-colors"
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
