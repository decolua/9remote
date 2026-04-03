"use client";
import { useState, useEffect } from "react";
import { useOpenClawStore } from "@/shared/stores/openclawStore";
import { useOpenClaw } from "@/features/openclaw/hooks/useOpenClaw";

const MAIN_AGENT = {
  id: null,
  name: "Main",
  emoji: "🏠",
  identity: { name: "Main", emoji: "🏠", theme: "Chat chính" },
};

function AgentAvatar({ agent }) {
  const avatar = agent.identity?.avatar;
  const fallback = agent.identity?.emoji || agent.emoji || "🤖";
  if (avatar)
    return <img src={avatar} alt={agent.identity?.name || agent.name} className="w-12 h-12 rounded-full object-cover flex-shrink-0" />;
  return (
    <div className="w-12 h-12 rounded-full bg-brand-500/20 border border-brand-500 flex items-center justify-center text-2xl select-none flex-shrink-0">
      {fallback}
    </div>
  );
}

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" });
}

function toPreview(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => c?.text ?? "").join("");
  return String(content);
}

function CompanyTree({ agent, members, allAgents }) {
  const [expanded, setExpanded] = useState(true);
  if (!members?.length) return null;

  return (
    <div className="ml-4 mt-1 mb-2">
      <button
        onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
        className="flex items-center gap-2 text-xs text-brand-400 hover:text-brand-300 transition px-2 py-1 rounded hover:bg-dark-600"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" className={`transition-transform ${expanded ? "rotate-90" : ""}`}>
          <path d="M9 18l6-6-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        <span className="font-medium">Company ({members.length})</span>
      </button>

      {expanded && (
        <div className="ml-6 mt-1 border-l-2 border-brand-500/30 pl-3 space-y-1.5">
          {members.map((memberId) => {
            const member = allAgents.find((a) => a.id === memberId);
            if (!member) return null;
            return (
              <div key={memberId} className="flex items-center gap-2 text-xs py-1 px-2 rounded hover:bg-dark-600/50 transition cursor-pointer">
                <div className="w-7 h-7 rounded-full bg-brand-500/20 border border-brand-500/50 flex items-center justify-center text-base flex-shrink-0">
                  {member.identity?.emoji || member.emoji || "🤖"}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-white font-medium truncate">{member.identity?.name || member.name}</p>
                  <p className="text-[10px] text-dark-300 truncate">{memberId}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function AgentView({ onClose, socketRef, connected }) {
  const { agents, openChatWithAgent, getSessionKey, getMessages } = useOpenClawStore();
  const openclawHook = useOpenClaw(socketRef);
  const { createAgent, deleteAgent, getAgentFile } = openclawHook;

  const [showForm, setShowForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newEmoji, setNewEmoji] = useState("🤖");
  const [creating, setCreating] = useState(false);
  const [companyMap, setCompanyMap] = useState({});

  const allAgents = [MAIN_AGENT, ...agents];

  // Load company members from AGENTS.md for each agent
  useEffect(() => {
    if (!connected || agents.length === 0) return;

    agents.forEach((agent) => {
      getAgentFile(agent.id, "AGENTS.md").then((content) => {
        if (!content) return;
        const members = parseCompanyMembers(content);
        if (members.length > 0) {
          setCompanyMap((prev) => ({ ...prev, [agent.id]: members }));
        }
      }).catch(() => {});
    });
  }, [agents, connected]);

  const parseCompanyMembers = (agentsMd) => {
    const members = [];
    for (const line of agentsMd.split("\n")) {
      const match = line.match(/^-\s+([a-zA-Z0-9_-]+):/);
      if (match) members.push(match[1]);
    }
    return members;
  };

  const getLastMessage = (agentId) => {
    const msgs = getMessages(getSessionKey(agentId));
    if (!msgs?.length) return null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === "user" || m.role === "assistant") return m;
    }
    return null;
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    try {
      await createAgent(newName.trim(), newEmoji.trim() || "🤖");
      setNewName("");
      setNewEmoji("🤖");
      setShowForm(false);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (agent) => {
    if (!confirm(`Xóa agent "${agent.identity?.name || agent.name}"?`)) return;
    await deleteAgent(agent.id);
  };

  return (
    <div className="flex flex-col h-full bg-dark-800 dot-grid-bg text-white">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-dark-600 border-b border-dark-400">
        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full flex-shrink-0 ${connected ? "bg-green-400" : "bg-red-500"}`}
            title={connected ? "Connected" : "Disconnected"}
          />
          <span className="font-semibold text-base">OpenClaw 🦞</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowForm((v) => !v)}
            className="w-8 h-8 rounded-brand bg-brand-500/20 hover:bg-brand-500/30 border border-brand-500 flex items-center justify-center text-lg transition"
            title="Tạo agent mới"
          >+</button>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-brand bg-dark-500 hover:bg-dark-400 border border-dark-400 hover:border-brand-500 flex items-center justify-center transition"
            title="Đóng"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Create form */}
      {showForm && (
        <form onSubmit={handleCreate} className="flex gap-2 px-4 py-3 border-b border-dark-400 bg-dark-700">
          <input
            value={newEmoji} onChange={(e) => setNewEmoji(e.target.value)}
            className="w-12 text-center rounded bg-dark-500 border border-dark-400 px-1 py-1.5 text-base focus:outline-none focus:border-brand-500"
            maxLength={4} placeholder="🤖"
          />
          <input
            value={newName} onChange={(e) => setNewName(e.target.value)}
            className="flex-1 rounded bg-dark-500 border border-dark-400 px-3 py-1.5 text-sm focus:outline-none focus:border-brand-500"
            placeholder="Tên agent..." autoFocus required
          />
          <button
            type="submit" disabled={creating || !newName.trim()}
            className="px-3 py-1.5 rounded bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-sm transition"
          >
            {creating ? "..." : "Tạo"}
          </button>
        </form>
      )}

      {/* Agent list */}
      <div className="flex-1 overflow-y-auto">
        {allAgents.map((agent) => {
          const last = getLastMessage(agent.id);
          const preview = last ? toPreview(last.content).slice(0, 60) : "Chưa có tin nhắn";
          const isUser = last?.role === "user";
          const companyMembers = companyMap[agent.id] || [];

          return (
            <div key={agent.id ?? "__main__"}>
              <div
                onClick={() => openChatWithAgent(agent.id)}
                className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-dark-700 transition border-b border-dark-400 active:bg-dark-600"
              >
                <AgentAvatar agent={agent} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-medium text-sm truncate text-white">
                      {agent.identity?.name || agent.name}
                    </p>
                    {last && (
                      <span className="text-[11px] text-[#708499] flex-shrink-0">{formatTime(last.timestamp)}</span>
                    )}
                  </div>
                  <p className="text-xs text-[#708499] truncate mt-0.5">
                    {isUser ? <span className="text-brand-400">Bạn: </span> : null}
                    {preview}
                  </p>
                </div>
                {agent.id !== null && (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDelete(agent); }}
                    className="w-7 h-7 flex items-center justify-center rounded-brand hover:bg-red-500/20 text-[#708499] hover:text-red-400 transition flex-shrink-0"
                    title="Xóa agent"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                      <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </button>
                )}
              </div>

              {companyMembers.length > 0 && (
                <div className="px-4 pb-2 border-b border-dark-400">
                  <CompanyTree agent={agent} members={companyMembers} allAgents={allAgents} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
