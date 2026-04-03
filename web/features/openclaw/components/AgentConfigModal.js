"use client";

import { useState, useEffect, useCallback } from "react";
import { LIVE2D_MODELS } from "@/shared/lib/live2d-manager";
import { useOpenClaw } from "@/features/openclaw/hooks/useOpenClaw";
import { useOpenClawStore } from "@/shared/stores/openclawStore";

const VOICES = {
  "vi-VN-HoaiMyNeural": "Hoài My (Nữ)",
  "vi-VN-NamMinhNeural": "Nam Minh (Nam)",
};

const THINKING_OPTIONS = ["off", "low", "medium", "high", "xhigh"];

const AVAILABLE_TOOLS = [
  "read", "write", "exec", "browser",
  "sessions_send", "sessions_spawn",
  "filesystem", "git", "search",
];

const inputCls =
  "w-full bg-dark-500 text-white border border-dark-400 rounded-brand px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 outline-none";

function Field({ label, children }) {
  return (
    <div>
      <label className="block text-xs text-dark-200 mb-1">{label}</label>
      {children}
    </div>
  );
}

export default function AgentConfigModal({ isOpen, onClose, agentId, socketRef }) {
  const { agents } = useOpenClawStore();
  const openclawHook = useOpenClaw(socketRef);
  const {
    getAgentConfig, saveAgentConfig, saveAgentToAgent,
    getAgentFile, saveAgentFile,
    getModels,
  } = openclawHook;

  const [activeTab, setActiveTab] = useState("identity");
  const [loading, setLoading] = useState(false);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [modelsList, setModelsList] = useState([]);
  const [config, setConfig] = useState({
    identityName: "", identityEmoji: "", identityAvatar: "",
    workspace: "",
    live2dModelId: "pio", backgroundUrl: "",
    voiceId: "vi-VN-HoaiMyNeural", audioEnabled: true,
    model: "", thinking: "off",
    identityMd: "", soulMd: "",
    companyMembers: [],
    agentToAgentEnabled: false,
    toolsAllow: [], toolsDeny: [],
  });
  const [oldCompanyMembers, setOldCompanyMembers] = useState([]);

  // Other agents for company dropdown (exclude self)
  const availableAgents = agents.filter((a) => a.id !== agentId);

  useEffect(() => {
    if (!isOpen || !agentId) return;
    setLoading(true);
    setLoadingFiles(true);

    // Load config + models in parallel (catch individually to avoid blocking)
    Promise.all([
      getAgentConfig(agentId).then((c) => {
        setConfig((prev) => ({
          ...prev,
          identityName: c.identity?.name || "",
          identityEmoji: c.identity?.emoji || "",
          identityAvatar: c.identity?.avatar || "",
          workspace: c.workspace || "",
          live2dModelId: c._9remote?.live2dModelId || "pio",
          backgroundUrl: c._9remote?.backgroundUrl || "",
          voiceId: c._9remote?.voiceId || "vi-VN-HoaiMyNeural",
          audioEnabled: c._9remote?.audioEnabled !== false,
          model: c.model || "",
          thinking: c.thinking || "off",
          agentToAgentEnabled: c.agentToAgent?.enabled || false,
          toolsAllow: c.tools?.allow || [],
          toolsDeny: c.tools?.deny || [],
        }));
      }).catch((err) => console.warn("[AgentConfigModal] getAgentConfig failed:", err.message)),
      getModels().then(setModelsList).catch((err) => console.warn("[AgentConfigModal] getModels failed:", err.message)),
    ]).finally(() => setLoading(false));

    // Load workspace files (catch individually)
    Promise.all([
      getAgentFile(agentId, "IDENTITY.md").catch(() => ""),
      getAgentFile(agentId, "SOUL.md").catch(() => ""),
      getAgentFile(agentId, "AGENTS.md").catch(() => ""),
    ]).then(([identityMd, soulMd, agentsMd]) => {
      const members = parseCompanyMembers(agentsMd || "");
      setConfig((prev) => ({
        ...prev,
        identityMd: identityMd || "",
        soulMd: soulMd || "",
        companyMembers: members,
      }));
      // Store old members to detect changes
      setOldCompanyMembers(members);
    }).finally(() => setLoadingFiles(false));
  }, [isOpen, agentId]);

  const parseCompanyMembers = (agentsMd) => {
    const members = [];
    for (const line of agentsMd.split("\n")) {
      // Match pattern: - **memberId**: Name
      const match = line.match(/^-\s+\*\*([a-zA-Z0-9_-]+)\*\*:/);
      if (match) {
        members.push(match[1]);
      } else {
        // Fallback: old format - memberId: Name
        const oldMatch = line.match(/^-\s+([a-zA-Z0-9_-]+):/);
        if (oldMatch) members.push(oldMatch[1]);
      }
    }
    console.log("[AgentConfigModal] Parsed company members:", members);
    return members;
  };

  const buildAgentsMd = (members, existingContent = "") => {
    console.log("[AgentConfigModal] buildAgentsMd called with members:", members);
    console.log("[AgentConfigModal] existingContent length:", existingContent?.length);
    
    // Parse existing AGENTS.md to preserve custom sections
    const sections = parseAgentsMdSections(existingContent);
    console.log("[AgentConfigModal] Parsed sections:", Object.keys(sections));
    
    // Build Company section
    let companySection = "";
    if (members.length > 0) {
      const lines = members.map((memberId) => {
        const agent = availableAgents.find((a) => a.id === memberId);
        const name = agent?.identity?.name || agent?.name || memberId;
        const sessionKey = `agent:${agentId}:${memberId}`;
        return `- **${memberId}**: ${name}\n  - Session: \`${sessionKey}\``;
      });
      companySection = `## Company\n\n${lines.join("\n")}\n`;
      console.log("[AgentConfigModal] Generated company section:", companySection);
    }
    
    // Build Instructions section (only if members exist and no existing instructions)
    let instructionsSection = "";
    if (members.length > 0) {
      // Only add instructions if not already present
      if (!sections.instructions) {
        instructionsSection = `\n## Instructions\n\nTo communicate with company members, use the \`sessions_send\` or \`sessions_spawn\` tool:\n\n**Example:**\n\`\`\`javascript\n// Send message to a member\nsessions_send("agent:${agentId}:researcher", "Find information about X")\n\n// Spawn a new subagent session\nsessions_spawn("researcher", "Analyze data Y")\n\`\`\`\n\n**Available members:**\n${members.map(m => `- \`${m}\``).join("\n")}\n`;
        console.log("[AgentConfigModal] Generated instructions section");
      } else {
        console.log("[AgentConfigModal] Instructions section already exists, preserving it");
      }
    }
    
    // Merge sections: Company + Instructions + preserve other custom sections
    let result = "";
    if (companySection) result += companySection;
    if (instructionsSection) result += instructionsSection;
    
    // Append other custom sections (not Company or Instructions)
    for (const [key, content] of Object.entries(sections)) {
      if (key !== "company" && key !== "instructions" && content.trim()) {
        result += `\n${content}\n`;
      }
    }
    
    console.log("[AgentConfigModal] Final AGENTS.md length:", result.length);
    return result.trim();
  };
  
  const parseAgentsMdSections = (content) => {
    if (!content) return {};
    
    const sections = {};
    const lines = content.split("\n");
    let currentSection = null;
    let currentContent = [];
    
    for (const line of lines) {
      const headerMatch = line.match(/^##\s+(.+)$/);
      if (headerMatch) {
        // Save previous section
        if (currentSection) {
          sections[currentSection] = currentContent.join("\n");
        }
        // Start new section
        currentSection = headerMatch[1].toLowerCase().trim();
        currentContent = [line];
      } else if (currentSection) {
        currentContent.push(line);
      }
    }
    
    // Save last section
    if (currentSection) {
      sections[currentSection] = currentContent.join("\n");
    }
    
    return sections;
  };

  const handleSave = useCallback(async () => {
    try {
      console.log("[AgentConfigModal] Starting save...");
      console.log("[AgentConfigModal] Config:", {
        agentId,
        companyMembers: config.companyMembers,
        agentToAgentEnabled: config.agentToAgentEnabled,
        toolsAllow: config.toolsAllow,
        toolsDeny: config.toolsDeny,
      });

      // 1. Save agent config (hot-reload, no gateway restart)
      console.log("[AgentConfigModal] Saving agent config...");
      await saveAgentConfig(agentId, {
        model: config.model,
        thinking: config.thinking,
        workspace: config.workspace,
        identity: {
          name: config.identityName,
          emoji: config.identityEmoji,
          avatar: config.identityAvatar,
        },
        tools: { allow: config.toolsAllow, deny: config.toolsDeny },
      });
      console.log("[AgentConfigModal] Agent config saved");

      // 2. Save agent-to-agent global config (if changed)
      console.log("[AgentConfigModal] Saving agentToAgent config...");
      await saveAgentToAgent(agentId, {
        enabled: config.agentToAgentEnabled,
        allow: config.companyMembers,
      });
      console.log("[AgentConfigModal] AgentToAgent config saved");

      // 3. Save workspace files
      // Get existing AGENTS.md to preserve custom sections
      console.log("[AgentConfigModal] Saving workspace files...");
      console.log("[AgentConfigModal] Company members:", config.companyMembers);
      
      const existingAgentsMd = await getAgentFile(agentId, "AGENTS.md").catch(() => "");
      console.log("[AgentConfigModal] Existing AGENTS.md length:", existingAgentsMd?.length);
      
      const agentsMdContent = buildAgentsMd(config.companyMembers, existingAgentsMd);
      console.log("[AgentConfigModal] Generated AGENTS.md length:", agentsMdContent?.length);
      console.log("[AgentConfigModal] Generated AGENTS.md content:", agentsMdContent);
      
      const filesToSave = [];
      
      // Always save AGENTS.md if we have members or existing content
      if (agentsMdContent && agentsMdContent.trim()) {
        filesToSave.push({ name: "AGENTS.md", content: agentsMdContent });
      }
      
      // Save other files if they have content
      if (config.identityMd && config.identityMd.trim()) {
        filesToSave.push({ name: "IDENTITY.md", content: config.identityMd });
      }
      if (config.soulMd && config.soulMd.trim()) {
        filesToSave.push({ name: "SOUL.md", content: config.soulMd });
      }

      console.log("[AgentConfigModal] Files to save:", filesToSave.map(f => ({ name: f.name, length: f.content.length })));
      
      if (filesToSave.length > 0) {
        await Promise.all(filesToSave.map((f) => saveAgentFile(agentId, f.name, f.content)));
        console.log("[AgentConfigModal] Workspace files saved");
      } else {
        console.warn("[AgentConfigModal] No files to save!");
      }

      console.log("[AgentConfigModal] ✅ Save completed successfully");
      onClose();
    } catch (err) {
      console.error("[AgentConfigModal] ❌ Save failed:", err);
      alert(`Save failed: ${err.message}`);
    }
  }, [agentId, config, saveAgentConfig, saveAgentToAgent, saveAgentFile, getAgentFile, onClose]);

  const set = (key) => (e) =>
    setConfig((prev) => ({ ...prev, [key]: e.target.value }));

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-dark-600 border border-dark-400 rounded-brand-lg shadow-2xl max-w-2xl w-full max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-dark-400 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-white">Agent Configuration</h3>
          <button onClick={onClose} className="text-gray-300 hover:text-white">✕</button>
        </div>

        {/* Tabs */}
        <div className="px-6 pt-4 flex gap-2">
          {["identity", "advanced"].map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-1.5 rounded-brand text-sm font-medium transition-colors capitalize ${
                activeTab === tab
                  ? "bg-brand-600 text-white"
                  : "bg-dark-500 text-dark-200 hover:bg-dark-400"
              }`}
            >
              {tab === "identity" ? "Identity" : "Advanced"}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="px-6 py-4 overflow-y-auto flex-1">
          {loading ? (
            <div className="py-8 text-center text-dark-200">Loading...</div>
          ) : activeTab === "identity" ? (
            <div className="space-y-3">
              <Field label="Name">
                <input type="text" value={config.identityName} onChange={set("identityName")} placeholder="Agent name" className={inputCls} />
              </Field>
              <Field label="Emoji">
                <input type="text" value={config.identityEmoji} onChange={set("identityEmoji")} placeholder="🤖" className={inputCls} />
              </Field>
              <Field label="Avatar URL">
                <input type="text" value={config.identityAvatar} onChange={set("identityAvatar")} placeholder="https://..." className={inputCls} />
              </Field>
              <Field label="Workspace Path">
                <input type="text" value={config.workspace} onChange={set("workspace")} placeholder="/path/to/workspace" className={inputCls} />
              </Field>
              <Field label="Live2D Model">
                <select value={config.live2dModelId} onChange={set("live2dModelId")} className={inputCls}>
                  {LIVE2D_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>{m.name} ({m.category})</option>
                  ))}
                </select>
              </Field>
              <Field label="Background URL">
                <input type="text" value={config.backgroundUrl} onChange={set("backgroundUrl")} placeholder="https://..." className={inputCls} />
              </Field>
              <Field label="Voice">
                <select value={config.voiceId} onChange={set("voiceId")} className={inputCls}>
                  {Object.entries(VOICES).map(([id, name]) => (
                    <option key={id} value={id}>{name}</option>
                  ))}
                </select>
              </Field>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox" checked={config.audioEnabled}
                  onChange={(e) => setConfig((p) => ({ ...p, audioEnabled: e.target.checked }))}
                  className="w-4 h-4"
                />
                <label className="text-xs text-dark-200">Enable TTS Audio</label>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <Field label="Model">
                <select value={config.model} onChange={set("model")} className={inputCls}>
                  <option value="">-- Select Model --</option>
                  {modelsList.map((m) => (
                    <option key={m.id} value={m.id}>[{m.provider}] {m.name || m.id}</option>
                  ))}
                </select>
              </Field>
              <Field label="Thinking Mode">
                <select value={config.thinking} onChange={set("thinking")} className={inputCls}>
                  {THINKING_OPTIONS.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                </select>
              </Field>

              <Field label="IDENTITY.md">
                {loadingFiles ? <div className="text-xs text-dark-300 italic">Loading...</div> : (
                  <textarea
                    value={config.identityMd}
                    onChange={(e) => setConfig((p) => ({ ...p, identityMd: e.target.value }))}
                    placeholder="- **Name:** Agent Name"
                    rows={6} className={`${inputCls} font-mono text-xs`}
                  />
                )}
              </Field>

              <Field label="SOUL.md">
                {loadingFiles ? <div className="text-xs text-dark-300 italic">Loading...</div> : (
                  <textarea
                    value={config.soulMd}
                    onChange={(e) => setConfig((p) => ({ ...p, soulMd: e.target.value }))}
                    placeholder="# You are..."
                    rows={10} className={`${inputCls} font-mono text-xs`}
                  />
                )}
              </Field>

              <Field label="Company Members">
                {loadingFiles ? <div className="text-xs text-dark-300 italic">Loading...</div> : (
                  <>
                    <select
                      multiple value={config.companyMembers}
                      onChange={(e) => setConfig((p) => ({ ...p, companyMembers: Array.from(e.target.selectedOptions, (o) => o.value) }))}
                      className={`${inputCls} h-32`}
                    >
                      {availableAgents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.identity?.emoji || agent.emoji || "🤖"} {agent.identity?.name || agent.name}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-dark-300 mt-1">Hold Cmd/Ctrl to select multiple.</p>
                  </>
                )}
              </Field>

              <Field label="Agent-to-Agent Interaction">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox" checked={config.agentToAgentEnabled}
                    onChange={(e) => setConfig((p) => ({ ...p, agentToAgentEnabled: e.target.checked }))}
                    className="w-4 h-4"
                  />
                  <label className="text-xs text-dark-200">Enable agent có thể gọi các company members</label>
                </div>
              </Field>

              <Field label="Tools - Allow">
                <select
                  multiple value={config.toolsAllow}
                  onChange={(e) => setConfig((p) => ({ ...p, toolsAllow: Array.from(e.target.selectedOptions, (o) => o.value) }))}
                  className={`${inputCls} h-24`}
                >
                  {AVAILABLE_TOOLS.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <p className="text-xs text-dark-300 mt-1">Empty = all allowed</p>
              </Field>

              <Field label="Tools - Deny">
                <select
                  multiple value={config.toolsDeny}
                  onChange={(e) => setConfig((p) => ({ ...p, toolsDeny: Array.from(e.target.selectedOptions, (o) => o.value) }))}
                  className={`${inputCls} h-24`}
                >
                  {AVAILABLE_TOOLS.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </Field>

              <Field label="Skills">
                <p className="text-xs text-dark-200">
                  Quản lý skills qua{" "}
                  <a href="https://clawhub.com" target="_blank" rel="noopener noreferrer" className="text-brand-400 hover:underline">
                    ClawHub
                  </a>
                </p>
              </Field>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-dark-400 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 bg-dark-500 hover:bg-dark-400 border border-dark-400 hover:border-brand-500 text-white rounded-brand text-sm transition-colors">
            Cancel
          </button>
          <button onClick={handleSave} disabled={loading} className="px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white rounded-brand text-sm transition-colors disabled:opacity-50">
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
