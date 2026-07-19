import { useState } from "preact/hooks";
import Icon from "./Icon";
import ConfirmPopup from "./ConfirmPopup";
import { useI18n } from "../i18n";
import { statusVisual } from "../lib/statusVisual";

const UNGROUPED_KEY = "ungrouped";

// Session list with group accordion + inline create — matches web/SessionList (lucide icons, brand tokens)
export default function SessionList({ sessions, groups, connected, finishedIds, sessionStatus = {}, onSelect, onCreate, onCreateNamed, onDelete, onRename, onCreateGroup, onRenameGroup, onDeleteGroup }) {
  const { t } = useI18n();
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [editingGroupId, setEditingGroupId] = useState(null);
  const [editGroupName, setEditGroupName] = useState("");
  const [groupDeleteConfirm, setGroupDeleteConfirm] = useState(null);
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [terminalModal, setTerminalModal] = useState({ open: false, groupId: null });
  const [newTerminalName, setNewTerminalName] = useState("");

  // Focus input and place caret at end
  const focusEnd = (el) => { if (el) { el.focus(); const n = el.value.length; el.setSelectionRange(n, n); } };

  const saveEdit = (id) => { if (editName.trim()) onRename(id, editName.trim()); setEditingId(null); setEditName(""); };
  const saveGroupEdit = (id) => { if (editGroupName.trim()) onRenameGroup?.(id, editGroupName.trim()); setEditingGroupId(null); setEditGroupName(""); };

  const submitCreateGroup = () => {
    const name = newGroupName.trim();
    if (!name) return;
    onCreateGroup?.(name, (r) => { if (r?.success && r.group?.id) onCreate(r.group.id); });
    setNewGroupName("");
    setGroupModalOpen(false);
  };

  const submitCreateTerminal = () => {
    const name = newTerminalName.trim() || null;
    if (onCreateNamed) onCreateNamed(terminalModal.groupId, name);
    else onCreate?.(terminalModal.groupId);
    setNewTerminalName("");
    setTerminalModal({ open: false, groupId: null });
  };

  const suggestTerminalName = (groupId) => {
    const count = sessions.filter((s) => (s.groupId || null) === groupId).length;
    return `Term ${count + 1}`;
  };

  const sections = [
    ...groups.map((g) => ({ key: g.id, id: g.id, name: g.name, isUngrouped: false })),
    { key: UNGROUPED_KEY, id: null, name: t("sessions.ungrouped"), isUngrouped: true },
  ];
  const inGroup = (gid) => sessions.filter((s) => (s.groupId || null) === gid);

  return (
    <div className="flex flex-col">
      <div className="space-y-8">
        {sections.map((section) => {
          const list = inGroup(section.id);
          if (section.isUngrouped && list.length === 0) return null;
          return (
            <div key={section.key}>
              {/* Group header — folder icon, no collapse */}
              <div className="flex items-center gap-2 mb-2 px-1">
                <div className="flex items-center gap-1.5 text-sm" style={{ color: "var(--text-muted)" }}>
                  <Icon name="folder" size={16} />
                  {editingGroupId === section.id ? (
                    <input
                      type="text" value={editGroupName} ref={focusEnd}
                      onClick={(e) => e.stopPropagation()}
                      onInput={(e) => setEditGroupName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") saveGroupEdit(section.id); if (e.key === "Escape") setEditingGroupId(null); }}
                      onBlur={() => saveGroupEdit(section.id)}
                      className="px-2 py-0.5 rounded-lg text-sm focus:outline-none" style={{ background: "var(--surface-2)", color: "var(--text-main)", border: "1px solid var(--border)" }}
                    />
                  ) : <span style={{ color: "var(--text-main)", fontWeight: 500 }}>{section.name}</span>}
                </div>
                {!section.isUngrouped && (
                  <>
                    <button
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => { setEditingGroupId(section.id); setEditGroupName(section.name); }}
                      title={t("sessions.renameGroup")} className="card-act p-1 rounded-lg"
                    >
                      <Icon name="pencil" size={14} />
                    </button>
                    <button onClick={() => setGroupDeleteConfirm({ id: section.id, name: section.name })} title={t("sessions.deleteGroup")} className="card-del p-1 rounded-lg">
                      <Icon name="trash" size={14} />
                    </button>
                  </>
                )}
              </div>

              {/* Cards */}
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                  {list.map((s) => {
                    const v = statusVisual(sessionStatus[s.id]?.state || "idle");
                    return (
                    <div
                      key={s.id}
                      className={`group relative rounded-xl overflow-hidden transition-all duration-200 ease-out term-card ${v.cls} status-border-${sessionStatus[s.id]?.state || "idle"} ${connected ? "hover:-translate-y-1" : "opacity-60"}`}
                      style={{
                        background: connected ? "linear-gradient(155deg,#22242e 0%,#1a1b21 55%,#141519 100%)" : "linear-gradient(155deg,#1c1d20,#141416)",
                        border: "1px solid color-mix(in srgb, var(--text-muted) 25%, transparent)",
                        boxShadow: "0 8px 28px -6px rgba(0,0,0,0.7)",
                      }}
                    >
                      {/* Titlebar */}
                      <div className="flex items-center gap-2 px-2.5 py-1.5" style={{ background: "rgba(44,44,46,0.9)", borderBottom: "1px solid rgba(0,0,0,0.3)" }}>
                        <div className="flex items-center gap-1.5 flex-shrink-0" style={{ opacity: connected ? 1 : 0.4, filter: connected ? "none" : "saturate(0)" }}>
                          <span className="w-[10px] h-[10px] rounded-full" style={{ background: "#ff5f57" }} />
                          <span className="w-[10px] h-[10px] rounded-full" style={{ background: "#febc2e" }} />
                          <span className="w-[10px] h-[10px] rounded-full" style={{ background: "#28c840" }} />
                        </div>
                        <span className="flex-1 min-w-0 text-center text-[11px] font-medium truncate" style={{ color: "rgba(255,255,255,0.55)" }}>{s.name || s.id}</span>
                        <div className="flex items-center gap-0.5 flex-shrink-0">
                          <button
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={(e) => { e.stopPropagation(); setEditingId(s.id); setEditName(s.name || ""); }}
                            title={t("common.rename")} className="tw-act p-1 rounded"
                          >
                            <Icon name="pencil" size={13} />
                          </button>
                          <button onClick={(e) => { e.stopPropagation(); setDeleteConfirm({ id: s.id, name: s.name }); }} title={t("common.delete")} className="tw-del p-1 rounded">
                            <Icon name="trash" size={13} />
                          </button>
                        </div>
                      </div>

                      {/* Body — fake terminal */}
                      <div className="relative px-3 py-3 font-mono min-h-[128px] cursor-pointer" onClick={() => { if (editingId !== s.id) onSelect(s); }}>
                        {/* Status badge — top-right of body, mirrors tab dot */}
                        {(sessionStatus[s.id]?.state || "idle") !== "idle" && (
                          <span
                            className="absolute top-1.5 right-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium"
                            style={{ background: `${v.dot}22`, color: v.dot }}
                          >
                            <span className={`w-1.5 h-1.5 rounded-full term-dot${v.pulse ? ` pulse-${v.pulse}` : ""}`} style={{ background: v.dot }} />
                            {t(v.label)}
                          </span>
                        )}
                        {editingId === s.id ? (
                          <input
                            type="text" value={editName} ref={focusEnd}
                            onInput={(e) => setEditName(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") saveEdit(s.id); if (e.key === "Escape") { setEditingId(null); setEditName(""); } }}
                            onBlur={() => saveEdit(s.id)}
                            onClick={(e) => e.stopPropagation()}
                            className="w-full px-2 py-1 rounded text-[12px] focus:outline-none" style={{ background: "rgba(0,0,0,0.4)", color: "#fff", border: "1px solid rgba(255,255,255,0.15)" }}
                          />
                        ) : (
                          <div className="text-[11.5px] leading-[1.7] space-y-0.5">
                            <div className="flex items-center min-w-0">
                              <span style={{ color: "#34d399" }} className="flex-shrink-0">➜</span>
                              <span style={{ color: "#22d3ee" }} className="flex-shrink-0 mx-1">~</span>
                              <span className="truncate" style={{ color: "rgba(255,255,255,0.45)" }}>{s.name || s.id}</span>
                            </div>
                            {connected ? (
                              <>
                                <div className="truncate" style={{ color: "rgba(255,255,255,0.35)" }}><span style={{ color: "#34d399" }}>✓</span> connected</div>
                                {s.createdAt && <div className="truncate" style={{ color: "rgba(255,255,255,0.35)" }}><span style={{ color: "#fbbf24" }}>●</span> Created {new Date(s.createdAt).toLocaleTimeString()}</div>}
                              </>
                            ) : (
                              <div className="truncate" style={{ color: "rgba(255,255,255,0.3)" }}><span style={{ color: "rgba(248,113,113,0.7)" }}>✕</span> disconnected</div>
                            )}
                            <div className="flex items-center min-w-0">
                              <span style={{ color: "#34d399" }} className="flex-shrink-0">➜</span>
                              <span style={{ color: "#22d3ee" }} className="flex-shrink-0 mx-1">~</span>
                              <span className="inline-block flex-shrink-0 w-[7px] h-[14px] animate-pulse" style={{ background: "rgba(52,211,153,0.8)" }} />
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                    );
                  })}
                  {/* Inline dashed add card */}
                  <button
                    onClick={() => { setNewTerminalName(suggestTerminalName(section.id)); setTerminalModal({ open: true, groupId: section.id }); }}
                    className="dashed-card min-h-[164px] rounded-xl p-3 flex items-center justify-center gap-1.5 text-sm"
                  >
                    <Icon className="text-brand-500" name="plus" size={16} /> <span style={{ color: "var(--brand-500)" }}>{t("sessions.newTerminal")}</span>
                  </button>
                </div>
            </div>
          );
        })}

        {/* New group — compact dashed button (web parity) */}
        <button
          onClick={() => setGroupModalOpen(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-150 ease-out"
          style={{ border: "1px dashed var(--brand-500)", color: "var(--brand-500)", background: "var(--brand-tint)" }}
        >
          <Icon name="folderPlus" size={16} /> {t("sessions.addGroup")}
        </button>
      </div>

      {/* Modals */}
      {groupModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.6)" }} onClick={() => setGroupModalOpen(false)}>
          <div className="glass-card p-5 w-80" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm font-semibold mb-3" style={{ color: "var(--text-main)" }}>{t("sessions.newGroup")}</p>
            <input
              type="text" value={newGroupName} autoFocus placeholder={t("sessions.groupName")}
              onInput={(e) => setNewGroupName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submitCreateGroup(); if (e.key === "Escape") setGroupModalOpen(false); }}
              className="w-full px-3 py-2 rounded-lg text-sm mb-4 focus:outline-none" style={{ background: "var(--surface-2)", color: "var(--text-main)", border: "1px solid var(--border)" }}
            />
            <div className="flex gap-2">
              <button onClick={submitCreateGroup} disabled={!newGroupName.trim()} className="btn-primary flex-1 py-2 text-sm font-semibold" style={{ borderRadius: "var(--radius-brand)", opacity: newGroupName.trim() ? 1 : 0.6 }}>{t("common.create")}</button>
              <button onClick={() => { setNewGroupName(""); setGroupModalOpen(false); }} className="glass-btn flex-1 py-2 text-sm" style={{ color: "var(--text-muted)" }}>{t("common.cancel")}</button>
            </div>
          </div>
        </div>
      )}

      {terminalModal.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.6)" }} onClick={() => setTerminalModal({ open: false, groupId: null })}>
          <div className="glass-card p-5 w-80" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm font-semibold mb-3" style={{ color: "var(--text-main)" }}>{t("sessions.newTerminal")}</p>
            <div className="relative mb-4">
              <input
                type="text" value={newTerminalName} ref={focusEnd} placeholder={suggestTerminalName(terminalModal.groupId)}
                onInput={(e) => setNewTerminalName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submitCreateTerminal(); if (e.key === "Escape") setTerminalModal({ open: false, groupId: null }); }}
                className="w-full px-3 py-2 pr-8 rounded-lg text-sm focus:outline-none" style={{ background: "var(--surface-2)", color: "var(--text-main)", border: "1px solid var(--border)" }}
              />
              {newTerminalName && (
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setNewTerminalName("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded-full"
                  style={{ color: "var(--text-muted)" }}
                >
                  <Icon name="plus" size={14} className="rotate-45" />
                </button>
              )}
            </div>
            <div className="flex gap-2">
              <button onClick={submitCreateTerminal} className="btn-primary flex-1 py-2 text-sm font-semibold" style={{ borderRadius: "var(--radius-brand)" }}>{t("common.create")}</button>
              <button onClick={() => { setNewTerminalName(""); setTerminalModal({ open: false, groupId: null }); }} className="glass-btn flex-1 py-2 text-sm" style={{ color: "var(--text-muted)" }}>{t("common.cancel")}</button>
            </div>
          </div>
        </div>
      )}

      {deleteConfirm && (
        <ConfirmPopup
          message={t("sessions.deleteSessionConfirm", { name: deleteConfirm.name || deleteConfirm.id })}
          confirmLabel={t("common.delete")} confirmDanger
          onConfirm={() => { onDelete(deleteConfirm.id); setDeleteConfirm(null); }}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}

      {groupDeleteConfirm && (
        <ConfirmPopup
          message={t("sessions.deleteGroupConfirm", { name: groupDeleteConfirm.name })}
          confirmLabel={t("common.delete")} confirmDanger
          onConfirm={() => { onDeleteGroup?.(groupDeleteConfirm.id); setGroupDeleteConfirm(null); }}
          onCancel={() => setGroupDeleteConfirm(null)}
        />
      )}
    </div>
  );
}
