import { useState } from "preact/hooks";
import Icon from "./Icon";
import ConfirmPopup from "./ConfirmPopup";

const UNGROUPED_KEY = "ungrouped";

// Session list with group accordion + inline create — matches web/SessionList (lucide icons, brand tokens)
export default function SessionList({ sessions, groups, connected, onSelect, onCreate, onDelete, onRename, onCreateGroup, onRenameGroup, onDeleteGroup }) {
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [editingGroupId, setEditingGroupId] = useState(null);
  const [editGroupName, setEditGroupName] = useState("");
  const [groupDeleteConfirm, setGroupDeleteConfirm] = useState(null);
  const [collapsed, setCollapsed] = useState({});
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");

  const toggle = (key) => setCollapsed((p) => ({ ...p, [key]: !p[key] }));
  const saveEdit = (id) => { if (editName.trim()) onRename(id, editName.trim()); setEditingId(null); setEditName(""); };
  const saveGroupEdit = (id) => { if (editGroupName.trim()) onRenameGroup?.(id, editGroupName.trim()); setEditingGroupId(null); setEditGroupName(""); };

  const submitCreateGroup = () => {
    const name = newGroupName.trim();
    if (!name) return;
    onCreateGroup?.(name, (r) => { if (r?.success && r.group?.id) onCreate(r.group.id); });
    setNewGroupName("");
    setGroupModalOpen(false);
  };

  const sections = [
    ...groups.map((g) => ({ key: g.id, id: g.id, name: g.name, isUngrouped: false })),
    { key: UNGROUPED_KEY, id: null, name: "Ungrouped", isUngrouped: true },
  ];
  const inGroup = (gid) => sessions.filter((s) => (s.groupId || null) === gid);

  return (
    <div className="flex flex-col">
      <div className="space-y-4">
        {sections.map((section) => {
          const list = inGroup(section.id);
          if (section.isUngrouped && list.length === 0) return null;
          const isCollapsed = !!collapsed[section.key];
          return (
            <div key={section.key}>
              {/* Group header */}
              <div className="flex items-center gap-2 mb-2 px-1">
                <button onClick={() => toggle(section.key)} className="flex items-center gap-1.5 text-sm hover:opacity-80 transition" style={{ color: "var(--text-muted)" }}>
                  {isCollapsed ? <Icon name="chevronRight" size={16} /> : <Icon name="chevronDown" size={16} />}
                  {editingGroupId === section.id ? (
                    <input
                      type="text" value={editGroupName} autoFocus
                      onClick={(e) => e.stopPropagation()}
                      onInput={(e) => setEditGroupName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") saveGroupEdit(section.id); if (e.key === "Escape") setEditingGroupId(null); }}
                      onBlur={() => saveGroupEdit(section.id)}
                      className="px-2 py-0.5 rounded-lg text-sm focus:outline-none" style={{ background: "var(--surface-2)", color: "var(--text-main)", border: "1px solid var(--border)" }}
                    />
                  ) : <span>{section.name}</span>}
                </button>
                {!section.isUngrouped && (
                  <>
                    <button onClick={() => { setEditingGroupId(section.id); setEditGroupName(section.name); }} title="Rename group" className="card-act p-1 rounded-lg">
                      <Icon name="pencil" size={14} />
                    </button>
                    <button onClick={() => setGroupDeleteConfirm({ id: section.id, name: section.name })} title="Delete group" className="card-del p-1 rounded-lg">
                      <Icon name="trash" size={14} />
                    </button>
                  </>
                )}
              </div>

              {/* Cards */}
              {!isCollapsed && (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {list.map((s) => (
                    <div key={s.id} className="session-card relative rounded-2xl p-3 flex items-center justify-between">
                      <div className="flex-1 flex items-center gap-3 min-w-0 cursor-pointer"
                        onClick={() => { if (editingId !== s.id) onSelect(s); }}>
                        <div className="p-2 rounded-xl flex-shrink-0" style={{ background: "var(--brand-tint)" }}>
                          <Icon name="terminal" size={20} color="var(--brand-500)" />
                        </div>
                        <div className="flex-1 min-w-0">
                          {editingId === s.id ? (
                            <input
                              type="text" value={editName} autoFocus
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
                        <button onClick={() => { setEditingId(s.id); setEditName(s.name || ""); }} title="Rename" className="card-act p-1.5 rounded-lg">
                          <Icon name="pencil" size={16} />
                        </button>
                        <button onClick={() => setDeleteConfirm({ id: s.id, name: s.name })} title="Delete" className="card-del p-1.5 rounded-lg">
                          <Icon name="trash" size={16} />
                        </button>
                      </div>
                    </div>
                  ))}
                  {/* Inline dashed add card */}
                  <button
                    onClick={() => onCreate(section.id)}
                    className="dashed-card min-h-[58px] rounded-2xl p-3 flex items-center justify-center gap-1.5 text-sm"
                  >
                    <Icon name="plus" size={16} /> New Terminal
                  </button>
                </div>
              )}
            </div>
          );
        })}

        {/* New group pill */}
        <button
          onClick={() => setGroupModalOpen(true)}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-semibold transition hover:opacity-90"
          style={{ border: "1px solid var(--brand-tint)", color: "var(--brand-500)", background: "var(--brand-tint)" }}
        >
          <Icon name="folderPlus" size={16} /> New Group
        </button>
      </div>

      {/* Modals */}
      {groupModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.6)" }} onClick={() => setGroupModalOpen(false)}>
          <div className="glass-card p-5 w-80" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm font-semibold mb-3" style={{ color: "var(--text-main)" }}>New Group</p>
            <input
              type="text" value={newGroupName} autoFocus placeholder="Group name"
              onInput={(e) => setNewGroupName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submitCreateGroup(); if (e.key === "Escape") setGroupModalOpen(false); }}
              className="w-full px-3 py-2 rounded-lg text-sm mb-4 focus:outline-none" style={{ background: "var(--surface-2)", color: "var(--text-main)", border: "1px solid var(--border)" }}
            />
            <div className="flex gap-2">
              <button onClick={submitCreateGroup} disabled={!newGroupName.trim()} className="btn-primary flex-1 py-2 text-sm font-semibold" style={{ borderRadius: "var(--radius-brand)", opacity: newGroupName.trim() ? 1 : 0.6 }}>Create</button>
              <button onClick={() => { setNewGroupName(""); setGroupModalOpen(false); }} className="glass-btn flex-1 py-2 text-sm" style={{ color: "var(--text-muted)" }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {deleteConfirm && (
        <ConfirmPopup
          message={`Delete session ${deleteConfirm.name || deleteConfirm.id}? This will kill the terminal.`}
          confirmLabel="Delete" confirmDanger
          onConfirm={() => { onDelete(deleteConfirm.id); setDeleteConfirm(null); }}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}

      {groupDeleteConfirm && (
        <ConfirmPopup
          message={`Delete group ${groupDeleteConfirm.name}? All terminals inside will be closed.`}
          confirmLabel="Delete" confirmDanger
          onConfirm={() => { onDeleteGroup?.(groupDeleteConfirm.id); setGroupDeleteConfirm(null); }}
          onCancel={() => setGroupDeleteConfirm(null)}
        />
      )}
    </div>
  );
}
