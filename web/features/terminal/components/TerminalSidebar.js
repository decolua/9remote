"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal, Plus, Pencil, Trash2, GripVertical, ChevronRight, PanelLeft, Settings } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { statusVisual } from "@/shared/utils/statusVisual";
import { AGENT_LABELS, AGENT_ICONS } from "../constants/agentLabels";
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

// Guess agent tool from session name when no live status tool is set (e.g. idle shell
// that once ran an agent, or a session named after its agent).
const TOOL_KEYWORDS = ["claude", "codex", "gemini", "opencode", "grok", "cursor", "copilot", "amp", "pi", "kiro", "qoder", "factory", "codebuddy", "rovodev", "hermes", "antigravity"];
function guessTool(name = "") {
  const lower = String(name).toLowerCase();
  for (const k of TOOL_KEYWORDS) if (lower.includes(k)) return k;
  return null;
}

// Second line of a terminal item. The branch only appears when it differs from the
// workspace's own — otherwise every terminal under a repo would repeat the same string.
function SessionMeta({ session, fileSocket, label, stateLabel, workspaceBranch }) {
  const { branch, dirty } = useWorkspaceGit(session.workspacePath, fileSocket);
  const differs = branch && branch !== workspaceBranch;
  return (
    <span className="text-[11px] text-text-subtle truncate leading-tight flex items-center gap-1">
      <span className="truncate">{label} {stateLabel}</span>
      {differs && <BranchBadge branch={branch} dirty={dirty} className="flex-shrink-0 max-w-[45%]" />}
    </span>
  );
}

// One workspace row: collapse chevron, name, shortened path, branch, count, actions.
// Split out as a component because each workspace subscribes to its own git poll.
function WorkspaceHeader({
  workspace, isActive, connected, fileSocket, homeDir, collapsed,
  onToggleCollapse, onSelect, onNewTerminal, onDelete, onBranch
}) {
  const { t } = useI18n();
  const gitPath = workspaceGitPath(workspace);
  const { branch, dirty } = useWorkspaceGit(gitPath, fileSocket);
  useEffect(() => { onBranch?.(branch); }, [branch, onBranch]);
  // Hover-reveal on pointer devices; always visible on touch, which has no hover.
  const revealCls = "opacity-100 sm:opacity-0 sm:group-hover/grp:opacity-100 sm:focus-visible:opacity-100";

  return (
    <div
      onClick={onSelect}
      className={`pr-2 py-1 flex items-center gap-1 group/grp transition-colors border-l-2 ${
        isActive ? "border-brand-500 bg-text/[0.04]" : "border-transparent"
      } ${onSelect ? "cursor-pointer hover:bg-text/[0.06]" : ""}`}
    >
      <button
        onClick={(e) => { e.stopPropagation(); vibrate(); onToggleCollapse?.(); }}
        className="p-1 text-text-subtle hover:text-text flex-shrink-0"
        tabIndex={-1}
      >
        <ChevronRight size={12} className={`transition-transform duration-150 ${collapsed ? "" : "rotate-90"}`} />
      </button>
      <span className="flex-1 min-w-0 flex flex-col">
        <span className={`text-[12px] font-medium truncate ${isActive ? "text-text" : "text-text-muted"}`}>
          {workspace.name}
        </span>
        {(gitPath || branch) && (
          <span className="text-[10px] text-text-subtle truncate leading-tight flex items-center gap-1.5">
            {gitPath && <span className="truncate">{shortenHomePath(gitPath, homeDir)}</span>}
            <BranchBadge branch={branch} dirty={dirty} className="flex-shrink-0" />
          </span>
        )}
      </span>
      {/* The count gives way to the actions on hover — both would crowd a 240px column. */}
      <span className="text-[10px] text-text-subtle flex-shrink-0 sm:group-hover/grp:hidden">
        {workspace.items.length}
      </span>
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
// (rename / delete / move to workspace / drag-reorder within workspace).
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
  onMoveSession,
  onAddWorkspace,
  onOpenSettings,
  fileSocket,
  homeDir,
  connected = true,
  width = SIDEBAR_WIDTH.default,
  onResize,
  onCollapse,
}) {
  const { t } = useI18n();
  const dragRef = useRef(null);

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
  const [moveOpen, setMoveOpen] = useState(false);

  // Rename inline
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const renameInputRef = useRef(null);

  // Delete confirm
  const [delConfirm, setDelConfirm] = useState(null); // { sessionId, name }

  // Collapsed workspaces and their branch, both keyed by workspace id ("" = unassigned).
  const [collapsed, setCollapsed] = useState({});
  const [branchByWs, setBranchByWs] = useState({});
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

  useEffect(() => { if (editingId) requestAnimationFrame(() => { renameInputRef.current?.focus(); renameInputRef.current?.select(); }); }, [editingId]);

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
    setMoveOpen(false);
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
      setMoveOpen(false);
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

      {/* Section title — the "+" sits here, right above the list it adds to */}
      <div className="px-3 pt-2 pb-1 flex items-center gap-1.5 flex-shrink-0">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted flex-1">
          {t("workspaces.title")}
        </span>
        {onAddWorkspace && (
          <button
            onClick={() => { vibrate(); onAddWorkspace?.(); }}
            disabled={!connected}
            className="p-0.5 text-text-subtle hover:text-brand-500 rounded-[2px] hover:bg-surface-2 transition-colors disabled:opacity-40"
            title={t("workspaces.newWorkspace")}
          >
            <Plus size={14} />
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto modal-scrollable">
        {!grouped.length ? (
          <p className="px-3 py-6 text-center text-xs text-text-muted">{t("workspaces.emptyWorkspace")}</p>
        ) : (
          grouped.map((grp) => {
            const isActiveWorkspace = (grp.id ?? null) === (activeWorkspaceId ?? null);
            const wsKey = grp.id ?? "";
            return (
              <div key={grp.id ?? "ungrouped"} className="flex flex-col">
                <WorkspaceHeader
                  workspace={grp}
                  isActive={isActiveWorkspace}
                  connected={connected}
                  fileSocket={fileSocket}
                  homeDir={homeDir}
                  collapsed={!!collapsed[wsKey]}
                  onToggleCollapse={() => toggleCollapsed(wsKey)}
                  onBranch={(b) => setBranchByWs((m) => (m[wsKey] === b ? m : { ...m, [wsKey]: b }))}
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
                  const isIdle = st === "idle";
                  const stateLabel = st === "working"
                    ? t("common.statusWorking")
                    : st === "blocked"
                      ? t("notifications.needsInput")
                      : isIdle
                        ? t("common.statusIdle")
                        : t("notifications.replied");
                  const isDragOver = drag?.sessionId && drag.overIdx === idx && s.id !== drag.sessionId && drag;
                  return (
                    <div
                      key={s.id}
                      data-item-row
                      data-sid={s.id}
                      className={`group w-full flex items-center gap-1.5 pl-3 pr-2 py-1 text-left transition-colors border-l-2 relative cursor-pointer ${
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
                          className="p-0.5 -ml-0.5 text-text-subtle opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing touch-none flex-shrink-0 disabled:opacity-0 disabled:cursor-default"
                          title={t("sessions.editName")}
                          tabIndex={-1}
                        >
                          <GripVertical size={12} />
                        </button>
                      )}
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 term-dot ${v.cls}${v.pulse ? ` pulse-${v.pulse}` : ""}`} style={{ background: v.dot }} />
                      {AGENT_ICONS[tool] ? (
                        <img src={AGENT_ICONS[tool]} alt={tool} className="w-4 h-4 flex-shrink-0" />
                      ) : (
                        <Terminal size={15} className="flex-shrink-0 opacity-70" />
                      )}
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
                            <span className={`text-xs truncate ${isActive ? "font-medium" : ""}`}>{s.name || t("terminal.defaultName")}</span>
                            <SessionMeta
                              session={s}
                              fileSocket={fileSocket}
                              label={AGENT_LABELS[tool] || t("notifications.agent")}
                              stateLabel={stateLabel}
                              workspaceBranch={branchByWs[wsKey]}
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
      </div>

      {onOpenSettings && (
        <div className="p-1.5 border-t border-border-subtle flex-shrink-0">
          <button
            onClick={() => { vibrate(); onOpenSettings(); }}
            className="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-text-muted hover:text-text hover:bg-surface-2 rounded-[3px] transition-colors"
            title={t("menu.settings")}
          >
            <Settings size={14} />
            <span>{t("menu.settings")}</span>
          </button>
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
          onCreate={(name, shellId) => {
            const wsId = createModalWsId === "" ? null : createModalWsId;
            onCreateNamedSession?.(name, wsId, shellId);
          }}
          shells={shells}
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

          {onMoveSession && (
            <>
              <button
                onClick={() => setMoveOpen((v) => !v)}
                className="w-full text-left px-3 py-1.5 text-sm text-text hover:bg-surface-3 flex items-center gap-2"
              >
                <ChevronRight size={14} className={moveOpen ? "rotate-90 transition-transform" : "transition-transform"} />
                {t("workspaces.moveToWorkspace")}
              </button>
              {moveOpen && (
                <div className="max-h-48 overflow-y-auto modal-scrollable">
                  {[...workspaces, { id: null, name: t("workspaces.ungrouped") }].map((w) => (
                    <button
                      key={w.id ?? "ungrouped"}
                      onClick={() => { onMoveSession(ctxMenu.sessionId, w.id); setCtxMenu(null); setMoveOpen(false); }}
                      className="w-full text-left pl-9 pr-3 py-1.5 text-xs text-text-muted hover:text-text hover:bg-surface-3 truncate"
                    >
                      {w.name}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

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
