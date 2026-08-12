"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal, Plus, Pencil, Trash2, GripVertical, ChevronRight, PanelLeft } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { statusVisual } from "@/shared/utils/statusVisual";
import { AGENT_LABELS, AGENT_ICONS } from "../constants/agentLabels";
import { vibrate } from "@/shared/utils/vibration";
import NewTerminalModal from "@/shared/components/ui/NewTerminalModal";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import useClampedMenu from "@/shared/hooks/useClampedMenu";

// Guess agent tool from session name when no live status tool is set (e.g. idle shell
// that once ran an agent, or a session named after its agent).
const TOOL_KEYWORDS = ["claude", "codex", "gemini", "opencode", "grok", "cursor", "copilot", "amp", "pi", "kiro", "qoder", "factory", "codebuddy", "rovodev", "hermes", "antigravity"];
function guessTool(name = "") {
  const lower = String(name).toLowerCase();
  for (const k of TOOL_KEYWORDS) if (lower.includes(k)) return k;
  return null;
}

// Desktop-only persistent sidebar: sessions grouped by group, full item ops
// (rename / delete / move to group / drag-reorder within group).
export default function TerminalSidebar({
  allSessions = [],
  groups = [],
  activeSessionId,
  activeGroupId,
  sessionStatus = {},
  notifications = {},
  onSelectSession,
  onCreateSession,
  onCreateNamedSession,
  onCreateGroup,
  onDeleteGroup,
  shells = [],
  onRenameSession,
  onDeleteSession,
  onReorderSession,
  onMoveSession,
  connected = true,
  width = 240,
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

  // New terminal modal scoped to a group (null = closed)
  const [createModalGroupId, setCreateModalGroupId] = useState(null);

  // Delete group confirm
  const [groupDelConfirm, setGroupDelConfirm] = useState({ isOpen: false, groupId: null, groupName: "" });
  const confirmGroupDelete = () => {
    if (groupDelConfirm.groupId !== null) onDeleteGroup?.(groupDelConfirm.groupId);
    setGroupDelConfirm({ isOpen: false, groupId: null, groupName: "" });
  };

  // New group modal
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const groupInputRef = useRef(null);
  useEffect(() => { if (groupModalOpen) requestAnimationFrame(() => { groupInputRef.current?.focus(); }); }, [groupModalOpen]);

  const submitCreateGroup = () => {
    const name = newGroupName.trim();
    if (!name) return;
    onCreateGroup?.(name, (result) => {
      if (result?.success && result.group?.id) setCreateModalGroupId(result.group.id);
    });
    setNewGroupName("");
    setGroupModalOpen(false);
  };

  // Drag reorder (within group)
  const [drag, setDrag] = useState(null); // { groupId, ids, fromIdx, overIdx, el }
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

  // Group sessions (ordered by allSessions order within each group)
  const grouped = (() => {
    const buckets = new Map();
    for (const s of allSessions) {
      const gid = s.groupId ?? null;
      if (!buckets.has(gid)) buckets.set(gid, []);
      buckets.get(gid).push(s);
    }
    const ordered = [];
    for (const g of groups) {
      const list = buckets.get(g.id) || [];
      ordered.push({ id: g.id, name: g.name, items: list });
    }
    const ungrouped = buckets.get(null);
    if (ungrouped?.length) ordered.push({ id: null, name: t("groups.ungrouped"), items: ungrouped });
    return ordered;
  })();

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
    const groupId = btn.dataset.gid === "" ? null : btn.dataset.gid;
    const fromIdx = Number(btn.dataset.idx);
    const grp = grouped.find((g) => (g.id ?? null) === (groupId ?? null));
    if (!grp) return;
    const ids = grp.items.map((i) => i.id);
    if (!connected || ids.length < 2) return;
    e.preventDefault();
    e.stopPropagation();
    clearLongPress();
    const el = btn.closest("[data-item-row]");
    dragRef.current = { groupId, ids, fromIdx, overIdx: fromIdx, el, moved: false, startX: e.clientX, startY: e.clientY };
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
      <div className="px-3 h-10 flex items-center justify-between flex-shrink-0 border-b border-border-subtle">
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

      <div className="flex-1 min-h-0 overflow-y-auto modal-scrollable">
        {!grouped.length ? (
          <p className="px-3 py-6 text-center text-xs text-text-muted">{t("groups.emptyGroup")}</p>
        ) : (
          grouped.map((grp) => {
            const isActiveGroup = (grp.id ?? null) === (activeGroupId ?? null);
            return (
              <div key={grp.id ?? "ungrouped"} className="flex flex-col">
                <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted flex items-center gap-1.5 group/grp">
                  <span className={`w-1 h-1 rounded-full ${isActiveGroup ? "bg-brand-500" : "bg-text-muted/60"}`} />
                  <span className={`truncate flex-1 min-w-0 ${isActiveGroup ? "text-text font-bold" : "text-text-muted"}`}>{grp.name}</span>
                  <span className="text-text-subtle normal-case font-normal tracking-normal">{grp.items.length}</span>
                  {onCreateNamedSession && (
                    <button
                      data-gid={grp.id ?? ""}
                      onClick={(e) => { e.stopPropagation(); vibrate(); setCreateModalGroupId(grp.id ?? ""); }}
                      disabled={!connected}
                      className="p-0.5 -mr-0.5 text-text-subtle hover:text-brand-500 rounded-[2px] hover:bg-surface-2 transition-colors disabled:opacity-40 opacity-0 group-hover/grp:opacity-100"
                      title={t("terminal.newTerminal")}
                    >
                      <Plus size={12} />
                    </button>
                  )}
                  {onDeleteGroup && grp.id !== null && (
                    <button
                      onClick={(e) => { e.stopPropagation(); vibrate(); setGroupDelConfirm({ isOpen: true, groupId: grp.id, groupName: grp.name }); }}
                      disabled={!connected}
                      className="p-0.5 -mr-0.5 text-text-subtle hover:text-red-500 rounded-[2px] hover:bg-surface-2 transition-colors disabled:opacity-40 opacity-0 group-hover/grp:opacity-100"
                      title={t("groups.delete")}
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
                {grp.items.map((s, idx) => {
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
                      className={`group w-full flex items-center gap-1.5 ml-2 pl-1 pr-2 py-1 text-left transition-colors border-l-2 relative cursor-pointer ${
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
                            <span className="text-[11px] text-text-subtle truncate leading-tight">
                              {AGENT_LABELS[tool] || t("notifications.agent")}
                              {" "}
                              {stateLabel}
                            </span>
                          </>
                        )}
                      </span>
                    </div>
                  );
                })}
                {grp.items.length === 0 && (
                  <button
                    onClick={(e) => { e.stopPropagation(); vibrate(); setCreateModalGroupId(grp.id ?? ""); }}
                    disabled={!connected}
                    className="ml-3 pl-2 py-1.5 text-xs text-text-subtle hover:text-brand-500 italic transition-colors disabled:opacity-40"
                  >
                    {t("groups.emptyGroup")}
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>

      {onCreateGroup && (
        <div className="p-2 border-t border-border-subtle flex-shrink-0">
          <button
            onClick={() => { vibrate(); setNewGroupName(""); setGroupModalOpen(true); }}
            disabled={!connected}
            className="w-full flex items-center justify-center gap-1.5 py-1.5 text-sm text-text-muted hover:text-text bg-surface-2/50 hover:bg-surface-2 rounded-[3px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={t("groups.newGroup")}
          >
            <Plus size={15} />
            <span>{t("groups.newGroup")}</span>
          </button>
        </div>
      )}

      {/* New group modal */}
      {groupModalOpen && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/70" onClick={() => setGroupModalOpen(false)}>
          <div className="bg-surface rounded-[3px] p-5 w-80 shadow-elev" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-text mb-4">{t("groups.newGroup")}</h3>
            <input
              ref={groupInputRef}
              type="text"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submitCreateGroup(); if (e.key === "Escape") setGroupModalOpen(false); }}
              placeholder={t("groups.newGroupPrompt")}
              className="w-full bg-surface-2 border border-border-subtle rounded-[3px] px-3 py-2 text-sm text-text outline-none focus:border-brand-500"
            />
            <div className="flex gap-2 mt-4">
              <button
                onClick={submitCreateGroup}
                disabled={!newGroupName.trim()}
                className="flex-1 py-2 text-sm font-semibold text-white bg-brand-500 hover:bg-brand-600 rounded-[3px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {t("common.confirm")}
              </button>
              <button
                onClick={() => { setNewGroupName(""); setGroupModalOpen(false); }}
                className="flex-1 py-2 text-sm text-text-muted bg-surface-2 hover:bg-surface-3 rounded-[3px] transition-colors"
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete group confirm */}
      <ConfirmDialog
        isOpen={groupDelConfirm.isOpen}
        onClose={() => setGroupDelConfirm({ isOpen: false, groupId: null, groupName: "" })}
        onConfirm={confirmGroupDelete}
        title={t("groups.deleteTitle")}
        message={t("groups.deleteMessage", { name: groupDelConfirm.groupName })}
      />

      {/* New terminal modal (scoped to a group) */}
      {createModalGroupId !== null && (
        <NewTerminalModal
          onClose={() => setCreateModalGroupId(null)}
          onCreate={(name, shellId) => {
            const gid = createModalGroupId === "" ? null : createModalGroupId;
            onCreateNamedSession?.(name, gid, shellId);
          }}
          shells={shells}
          suggestName={`${t("terminal.defaultName")} ${(allSessions.filter(s => (s.groupId ?? null) === (createModalGroupId === "" ? null : createModalGroupId)).length + 1)}`}
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
