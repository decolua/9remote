import { useState } from "preact/hooks";
import Icon from "./Icon";
import ConfirmPopup from "./ConfirmPopup";
import { useI18n } from "../i18n";

const UNGROUPED_KEY = "ungrouped";

// Session list with group accordion + inline create — matches web/SessionList (lucide icons, brand tokens)
export default function SessionList({ sessions, groups, connected, finishedIds, onSelect, onCreate, onCreateNamed, onDelete, onRename, onCreateGroup, onRenameGroup, onDeleteGroup }) {
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
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {list.map((s) => (
                    <div key={s.id} className={`session-card relative rounded-2xl p-3 flex items-center justify-between ${finishedIds?.has(s.id) ? "terminal-done-border" : ""}`}>
                      <div className="flex-1 flex items-center gap-3 min-w-0 cursor-pointer"
                        onClick={() => { if (editingId !== s.id) onSelect(s); }}>
                        <div className="p-2 rounded-xl flex-shrink-0" style={{ background: "var(--brand-tint)" }}>
                          <Icon name="terminal" size={20} color="var(--brand-500)" />
                        </div>
                        <div className="flex-1 min-w-0">
                          {editingId === s.id ? (
                            <input
                            type="text" value={editName} ref={focusEnd}
                            onInput={(e) => setEditName(e.target.value)}
                              onKeyDown={(e) => { if (e.key === "Enter") saveEdit(s.id); if (e.key === "Escape") { setEditingId(null); setEditName(""); } }}
                              onBlur={() => saveEdit(s.id)}
                              className="w-full px-2 py-1 rounded-lg text-sm focus:outline-none" style={{ background: "var(--surface-2)", color: "var(--text-main)", border: "1px solid var(--border)" }}
                            />
                          ) : (
                            <>
                              <h3 className="text-sm font-medium truncate" style={{ color: "var(--text-main)" }}>{s.name || s.id}</h3>
                              <p className="text-xs" style={{ color: "var(--text-muted)" }}>{s.createdAt ? `Created ${new Date(s.createdAt).toLocaleTimeString()}` : ""}</p>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="flex gap-0.5 ml-1">
                        <button
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => { setEditingId(s.id); setEditName(s.name || ""); }}
                          title={t("common.rename")} className="card-act p-1.5 rounded-lg"
                        >
                          <Icon name="pencil" size={16} />
                        </button>
                        <button onClick={() => setDeleteConfirm({ id: s.id, name: s.name })} title={t("common.delete")} className="card-del p-1.5 rounded-lg">
                          <Icon name="trash" size={16} />
                        </button>
                      </div>
                    </div>
                  ))}
                  {/* Inline dashed add card */}
                  <button
                    onClick={() => { setNewTerminalName(suggestTerminalName(section.id)); setTerminalModal({ open: true, groupId: section.id }); }}
                    className="dashed-card min-h-[58px] rounded-2xl p-3 flex items-center justify-center gap-1.5 text-sm"
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
